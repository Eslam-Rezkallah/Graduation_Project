/**
 * modules/message/service/shared.message.service.js
 *
 * ── Single source of truth for message operations ──────────
 * Both REST (message.service.js) and Socket (chat.socket.js)
 * call these functions so bug fixes only need to happen once.
 *
 * ── Phase 2: Cache invalidation ────────────────────────────
 * Unread-counts cache is invalidated when a user marks messages
 * seen (their own count drops). Outgoing messages don't invalidate
 * recipients' caches — the socket layer delivers real-time updates,
 * and the 30s TTL handles fallback consistency.
 */

import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import messageModel from "../../../DB/Model/message.model.js";
import chatRoomModel from "../../../DB/Model/chatroom.model.js";
import reactionModel, {
  validReactions,
} from "../../../DB/Model/reaction.model.js";
import userModel from "../../../DB/Model/user.model.js";
import { config } from "../../../config/index.js";
import {
  cloud,
  isCloudinaryConfigured,
} from "../../../utils/multer/cloudinary.multer.js";
import * as dbService from "../../../DB/db.service.js";
import { invalidate, ckey } from "../../../utils/cache/cache.service.js";
import { childLogger } from "../../../utils/logger/logger.js";
import { httpError } from "../../../utils/errors/index.js";
import { queueVoiceAnalysis } from "../../../utils/ai/voice-analysis.service.js";
import { isAiServiceConfigured } from "../../../utils/ai/ai.client.js";

const log = childLogger("message-shared");

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

export const EDIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const DELETE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────────
// SLASH COMMAND INTERCEPT
// ─────────────────────────────────────────────────────────────

// Wrapped in a try/catch so a buggy command never breaks the message
// send path. Returns null when the content isn't a slash command.
async function runSlashCommandIfAny({ content, userId, roomId }) {
  try {
    const { parseSlashIntent, dispatchSlash } = await import(
      "../../../utils/slash/slash.registry.js"
    );
    const intent = parseSlashIntent(content);
    if (!intent) return null;

    const room = await chatRoomModel
      .findOne({ _id: roomId, isDeleted: false })
      .lean();
    if (!room) return null;

    // Resolve the user once for the handler (most commands need it).
    const user = await userModel
      .findById(userId)
      .select("_id username email image")
      .lean();
    if (!user) return null;

    return await dispatchSlash({ intent, user, room });
  } catch (err) {
    log.warn({ err: err.message }, "slash dispatch failed");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// MENTIONS
// ─────────────────────────────────────────────────────────────

// Matches @username — usernames are alphanumeric + underscore + dash.
// Conservative: stops at whitespace or punctuation, so "@maitha." or
// "@maitha," resolve to "maitha".
const MENTION_RE = /@([a-zA-Z0-9_-]{2,30})/g;

/**
 * Pull @mentions from content and resolve to userIds, BUT only for
 * usernames that are actual members of the chat room. This is the
 * boundary that prevents notification spam — a typo'd @somebody-else
 * won't notify a stranger.
 *
 * Returns deduped ObjectIds, excluding the sender themselves.
 */
export async function extractMentionsForRoom({
  content,
  roomId,
  excludeUserId,
}) {
  if (!content) return [];
  const usernames = new Set();
  let m;
  while ((m = MENTION_RE.exec(content)) !== null) {
    usernames.add(m[1]);
  }
  if (usernames.size === 0) return [];

  // Resolve usernames within the room's member set in one round-trip.
  const room = await chatRoomModel
    .findOne({ _id: roomId, isDeleted: false })
    .select("members")
    .lean();
  if (!room) return [];

  const users = await userModel
    .find({
      _id: { $in: room.members },
      username: { $in: [...usernames] },
      isDeleted: false,
    })
    .select("_id")
    .lean();

  const ids = users
    .map((u) => u._id)
    .filter((id) => id.toString() !== String(excludeUserId));

  return ids;
}

// ─────────────────────────────────────────────────────────────
// GUARDS
// ─────────────────────────────────────────────────────────────

export async function requireRoomMember(roomId, userId) {
  if (!mongoose.Types.ObjectId.isValid(roomId)) {
    throw httpError(400, "Invalid room ID");
  }
  const room = await dbService.findOne({
    model: chatRoomModel,
    filter: {
      _id: roomId,
      members: userId,
      isDeleted: false,
    },
  });
  if (!room) {
    throw httpError(404, "Room not found or access denied");
  }
  return room;
}

// ─────────────────────────────────────────────────────────────
// ATTACHMENT HELPERS
// ─────────────────────────────────────────────────────────────

function resolveAttachmentType(mimetype = "") {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "voice";
  return "file";
}

function getCloudFolder(userId, roomId) {
  return `${process.env.APP_NAME}/chat/${roomId}/${userId}`;
}

function attachmentExtension(file) {
  const fromName = path.extname(file.originalname || "");
  if (fromName) return fromName;
  const map = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "video/mp4": ".mp4",
  };
  return map[file.mimetype] || "";
}

async function removeTempFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    /* temp file may already be gone */
  }
}

/** Dev fallback: persist under /uploads when Cloudinary is not configured. */
async function uploadAttachmentLocal(file, userId, roomId) {
  const relDir = path.join("uploads", "chat", String(roomId), String(userId));
  const absDir = path.resolve("./src", relDir);
  await fs.mkdir(absDir, { recursive: true });

  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${attachmentExtension(file)}`;
  const destPath = path.join(absDir, filename);
  await fs.copyFile(file.path, destPath);
  await removeTempFile(file.path);

  const url = `http://localhost:${config.app.port}/uploads/chat/${roomId}/${userId}/${filename}`;

  log.warn(
    { url },
    "Cloudinary not configured — saved attachment locally (dev only)",
  );

  return {
    type: resolveAttachmentType(file.mimetype),
    url,
    public_id: null,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    duration: null,
  };
}

export async function uploadAttachments(files, userId, roomId) {
  if (!files || !files.length) return [];

  const useLocal = !isCloudinaryConfigured();
  const folder = getCloudFolder(userId, roomId);
  const resourceType = (mimetype) => {
    if (mimetype.startsWith("image/")) return "image";
    if (mimetype.startsWith("video/") || mimetype.startsWith("audio/"))
      return "video";
    return "raw";
  };

  return Promise.all(
    files.map(async (file) => {
      if (useLocal) {
        return uploadAttachmentLocal(file, userId, roomId);
      }

      try {
        const result = await cloud.uploader.upload(file.path, {
          folder,
          resource_type: resourceType(file.mimetype),
        });
        await removeTempFile(file.path);
        return {
          type: resolveAttachmentType(file.mimetype),
          url: result.secure_url,
          public_id: result.public_id,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          duration: result.duration || null,
        };
      } catch (err) {
        await removeTempFile(file.path);
        throw err;
      }
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// CACHE INVALIDATION HELPERS
// ─────────────────────────────────────────────────────────────

/** Drop a single user's unread-counts cache entry. */
async function invalidateUserUnread(userId) {
  try {
    await invalidate(ckey("unread-counts", userId));
  } catch (err) {
    // Cache failures must never break the message flow
    log.warn({ err, userId }, "unread cache invalidation failed");
  }
}

// ─────────────────────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────────────────────

export async function createMessage({
  roomId,
  userId,
  content = "",
  messageType = "text",
  replyTo = null,
  attachments = [],
  forwardedFrom = null,
}) {
  // Validate reply target
  if (replyTo) {
    const parent = await dbService.findOne({
      model: messageModel,
      filter: {
        _id: replyTo,
        chatRoomId: roomId,
        deletedForEveryone: false,
      },
    });
    if (!parent) {
      throw httpError(404, "Reply target not found");
    }
  }

  // Validate forward source
  if (forwardedFrom) {
    const source = await dbService.findOne({
      model: messageModel,
      filter: {
        _id: forwardedFrom,
        deletedForEveryone: false,
      },
    });
    if (!source) {
      throw httpError(404, "Forwarded message not found");
    }
  }

  if (!content.trim() && !attachments.length) {
    throw httpError(400, "Message must have content or attachment");
  }

  // Resolve message type from attachment if needed
  let resolvedType = messageType;
  if (attachments.length && messageType === "text") {
    resolvedType =
      attachments[0].type === "voice" ? "voice" : attachments[0].type;
  }

  // Slash-command intercept. If the content starts with a registered
  // /cmd, dispatch it instead of (or alongside) the normal save path.
  // Done BEFORE mention extraction because the command might
  // suppress the user message entirely.
  const slashResult = await runSlashCommandIfAny({
    content,
    userId,
    roomId,
  });
  if (slashResult?.suppressMessage) {
    // Replace user content with the command's broadcast text (if any)
    // so the timeline still has SOMETHING to render.
    if (!slashResult.broadcast) {
      // Pure ephemeral — caller gets the reply only, no DB row.
      // Return a synthetic populated message-like object so callers
      // (REST + socket) handle it identically.
      return {
        _id: null,
        ephemeral: true,
        replyToUser: slashResult.replyToUser || null,
      };
    }
    content = slashResult.broadcast;
    messageType = "system";
  }

  // Extract @mentions from content. We scope lookups to the room
  // members so we never accidentally notify a stranger whose
  // username matched the regex.
  const mentions = await extractMentionsForRoom({
    content,
    roomId,
    excludeUserId: userId,
  });

  const message = await messageModel.create({
    chatRoomId: roomId,
    senderId: userId,
    content: content.trim(),
    messageType: resolvedType,
    attachments,
    replyTo: replyTo || null,
    forwardedFrom: forwardedFrom || null,
    mentions,
  });

  await chatRoomModel.updateOne(
    { _id: roomId },
    { lastMessage: message._id, lastMessageAt: new Date() },
  );

  // If this is a reply, bump the parent's replyCount so thread
  // listings can show "N replies" without a separate count query.
  if (replyTo) {
    await messageModel.updateOne(
      { _id: replyTo },
      { $inc: { replyCount: 1 } },
    );
  }

  // Background unfurl: extract the first URL from the message and
  // fetch its OG preview off the hot path. The message ships
  // immediately; the FE re-renders when the preview lands.
  (async () => {
    try {
      const { extractFirstUrl, unfurlOne } = await import(
        "../../../utils/unfurl/unfurl.service.js"
      );
      const url = extractFirstUrl(content);
      if (!url) return;
      const preview = await unfurlOne(url);
      if (!preview) return;
      await messageModel.updateOne(
        { _id: message._id },
        { $set: { preview } },
      );
    } catch (err) {
      log.debug({ err: err.message }, "background unfurl failed");
    }
  })();

  // Auto-analyze voice messages for AI Speech dashboard (async, non-blocking).
  if (
    isAiServiceConfigured("chat") &&
    (resolvedType === "voice" || attachments.some((a) => a.type === "voice"))
  ) {
    queueVoiceAnalysis(message._id).catch((err) => {
      log.debug({ err: err.message, messageId: message._id }, "voice analysis queue failed");
    });
  }

  // Fan out mention notifications. Like the comment_mention pattern,
  // we go through the central event bus so the socket transport
  // pushes them in real time and the DB row is persisted.
  if (mentions.length > 0) {
    // Lazy-imported to avoid a circular dep at module load time.
    const { notificationEvent } = await import(
      "../../../utils/events/notification.event.js"
    );
    notificationEvent.emit("message_mention", {
      mentionedUserIds: mentions.map((m) => m.toString()),
      triggeredById: userId,
      roomId,
      messageId: message._id,
      contentPreview: content.trim().slice(0, 100),
    });
  }

  const populated = await messageModel
    .findById(message._id)
    .populate("senderId", "username email image")
    .populate("replyTo", "content senderId messageType")
    .populate(
      "forwardedFrom",
      "content senderId messageType chatRoomId createdAt",
    )
    .lean();

  // NOTE: We intentionally don't invalidate recipients' unread-counts cache
  // here. Real-time delivery happens via socket "receive_message"; the cache
  // is only a fallback for refetch scenarios where 30s staleness is OK.
  // Invalidating on every send would add a Redis round-trip per message.

  return populated;
}

// ─────────────────────────────────────────────────────────────
// EDIT MESSAGE
// ─────────────────────────────────────────────────────────────

export async function editMessageById({ roomId, messageId, userId, content }) {
  const message = await dbService.findOne({
    model: messageModel,
    filter: {
      _id: messageId,
      chatRoomId: roomId,
      deletedForEveryone: false,
    },
  });

  if (!message) {
    throw httpError(404, "Message not found");
  }
  if (message.senderId.toString() !== userId.toString()) {
    throw httpError(403, "Can only edit your own messages");
  }

  const age = Date.now() - new Date(message.createdAt).getTime();
  if (age > EDIT_WINDOW_MS) {
    throw httpError(403, "Edit window expired (1 hour)");
  }

  const editedAt = new Date();

  const updated = await messageModel
    .findOneAndUpdate(
      { _id: messageId },
      { content: content.trim(), edited: true, editedAt },
      { new: true },
    )
    .populate("senderId", "username image");

  return { updated, editedAt };
}

// ─────────────────────────────────────────────────────────────
// DELETE MESSAGE
// ─────────────────────────────────────────────────────────────

export async function deleteMessageById({
  roomId,
  messageId,
  userId,
  deleteType = "me",
}) {
  const message = await messageModel.findOne({
    _id: messageId,
    chatRoomId: roomId,
    deletedForEveryone: false,
  });

  if (!message) {
    throw httpError(404, "Message not found");
  }

  const age = Date.now() - new Date(message.createdAt).getTime();

  if (deleteType === "everyone") {
    if (message.senderId.toString() !== userId.toString()) {
      throw httpError(403, "Can only delete your own messages for everyone");
    }
    if (age > DELETE_WINDOW_MS) {
      throw httpError(403, "Delete-for-everyone window expired (1 hour)");
    }

    await messageModel.updateOne(
      { _id: messageId },
      {
        deletedForEveryone: true,
        deleted: true,
        content: "",
        attachments: [],
      },
    );

    return { deleteType: "everyone" };
  }

  // delete for me
  await messageModel.updateOne(
    { _id: messageId },
    { $addToSet: { deletedFor: userId } },
  );

  // The deleting user's unread count may drop if this was an unseen message
  // they're hiding for themselves. Invalidate their cache to be safe.
  await invalidateUserUnread(userId);

  return { deleteType: "me" };
}

// ─────────────────────────────────────────────────────────────
// MARK SEEN (batch up to pivot message)
// ─────────────────────────────────────────────────────────────

/**
 * Marks all messages in a room up to (and including) the pivot
 * message as seen by the given user.
 *
 * If the user has disabled readReceipts, we still track locally
 * (so unread count works for THEM) but broadcastSeen = false
 * tells the caller NOT to emit the seen event to other users.
 *
 * @returns {{ modifiedCount: number, broadcastSeen: boolean }}
 */
export async function markMessagesSeen({ roomId, messageId, userId }) {
  const pivotMsg = await messageModel
    .findOne({ _id: messageId, chatRoomId: roomId })
    .select("createdAt");

  if (!pivotMsg) {
    throw httpError(404, "Message not found");
  }

  const result = await messageModel.updateMany(
    {
      chatRoomId: roomId,
      createdAt: { $lte: pivotMsg.createdAt },
      "seenBy.userId": { $ne: userId },
      senderId: { $ne: userId },
    },
    { $addToSet: { seenBy: { userId, seenAt: new Date() } } },
  );

  // Check if user has read receipts enabled
  const userDoc = await userModel
    .findById(userId)
    .select("readReceipts")
    .lean();
  const broadcastSeen = userDoc?.readReceipts !== false; // default true

  // Invalidate THIS user's unread-counts cache — they just saw messages
  // so their next /unread-counts call must reflect the drop immediately.
  if (result.modifiedCount > 0) {
    await invalidateUserUnread(userId);
  }

  return {
    modifiedCount: result.modifiedCount,
    broadcastSeen,
  };
}

// ─────────────────────────────────────────────────────────────
// REACTIONS
// ─────────────────────────────────────────────────────────────

/**
 * Add or change a reaction. Returns { reactionDoc, summary }.
 */
export async function addReactionToMessage({
  roomId,
  messageId,
  userId,
  reaction,
}) {
  if (!validReactions.includes(reaction)) {
    throw httpError(
      400,
      `Invalid reaction. Allowed: ${validReactions.join(", ")}`,
    );
  }

  const message = await messageModel.findOne({
    _id: messageId,
    chatRoomId: roomId,
    deletedForEveryone: false,
  });
  if (!message) {
    throw httpError(404, "Message not found");
  }

  const existing = await dbService.findOne({
    model: reactionModel,
    filter: { messageId, userId },
  });
  let reactionDoc;

  if (existing) {
    if (existing.reaction === reaction) {
      return { reactionDoc: existing, unchanged: true };
    }
    existing.reaction = reaction;
    await existing.save();
    reactionDoc = existing;
  } else {
    reactionDoc = await dbService.create({
      model: reactionModel,
      data: {
        messageId,
        chatRoomId: roomId,
        userId,
        reaction,
      },
    });
    await messageModel.updateOne(
      { _id: messageId },
      { $addToSet: { reactions: reactionDoc._id } },
    );
  }

  const summary = await reactionModel.aggregate([
    { $match: { messageId: message._id } },
    { $group: { _id: "$reaction", count: { $sum: 1 } } },
    { $project: { reaction: "$_id", count: 1, _id: 0 } },
  ]);

  return { reactionDoc, summary, unchanged: false };
}

/**
 * Remove a user's reaction. Returns { summary }.
 */
export async function removeReactionFromMessage({ roomId, messageId, userId }) {
  const reactionDoc = await dbService.findOneAndDelete({
    model: reactionModel,
    filter: { messageId, userId },
  });

  if (!reactionDoc) {
    throw httpError(404, "Reaction not found");
  }

  await messageModel.updateOne(
    { _id: messageId },
    { $pull: { reactions: reactionDoc._id } },
  );

  const summary = await reactionModel.aggregate([
    { $match: { messageId: reactionDoc.messageId } },
    { $group: { _id: "$reaction", count: { $sum: 1 } } },
    { $project: { reaction: "$_id", count: 1, _id: 0 } },
  ]);

  return { summary };
}

// ─────────────────────────────────────────────────────────────
// FORWARD MESSAGE
// ─────────────────────────────────────────────────────────────

export async function forwardMessage({
  sourceMessageId,
  targetRoomId,
  userId,
}) {
  const sourceMsg = await dbService.findOne({
    model: messageModel,
    filter: {
      _id: sourceMessageId,
      deletedForEveryone: false,
    },
  });

  if (!sourceMsg) {
    throw httpError(404, "Source message not found");
  }

  // Verify membership in source room
  await requireRoomMember(sourceMsg.chatRoomId, userId);
  // Verify membership in target room
  await requireRoomMember(targetRoomId, userId);

  // Cannot forward to the same room
  if (sourceMsg.chatRoomId.toString() === targetRoomId.toString()) {
    throw httpError(400, "Cannot forward to the same room");
  }

  // Create forwarded message — cache rules from createMessage apply here too
  const forwarded = await createMessage({
    roomId: targetRoomId,
    userId,
    content: sourceMsg.content,
    messageType: sourceMsg.messageType,
    attachments: sourceMsg.attachments || [],
    forwardedFrom: sourceMsg._id,
  });

  return forwarded;
}
