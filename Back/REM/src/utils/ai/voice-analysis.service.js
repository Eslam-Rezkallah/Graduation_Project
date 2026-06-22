import messageModel from "../../DB/Model/message.model.js";
import chatRoomModel from "../../DB/Model/chatroom.model.js";
import { callAiService, isAiServiceConfigured } from "./ai.client.js";
import { requireOrgAdmin } from "../permissions/org.permissions.js";
import { childLogger } from "../logger/logger.js";

const log = childLogger("voice-analysis");

/** @type {Map<string, Promise<void>>} */
const inFlight = new Map();

function voiceAttachment(message) {
  return message.attachments?.find((a) => a.type === "voice" && a.url);
}

function senderLabel(sender) {
  if (!sender) return "Unknown";
  return sender.username || sender.fullName || sender.email || "Unknown";
}

function mapAnalysisPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const features = raw.features ?? {};
  const featureErr =
    typeof features.error === "string" ? features.error.trim() : "";
  if (featureErr) {
    return { error: featureErr };
  }
  if (!features.duration_sec && features.pitch_score == null) {
    return { error: "Acoustic features could not be extracted from audio" };
  }
  return {
    language: raw.language ?? "unknown",
    transcript: raw.transcript ?? "",
    translatedTranscript: raw.translated_transcript ?? "",
    features,
    emotion: raw.emotion
      ? {
          label: raw.emotion.label,
          confidence: raw.emotion.confidence,
          verdict: raw.emotion.verdict,
        }
      : null,
    analyzedAt: new Date().toISOString(),
  };
}

function hasValidAnalysis(message) {
  if (message.voiceAnalysisStatus !== "ready" || !message.voiceAnalysis) {
    return false;
  }
  const a = message.voiceAnalysis;
  if (a.error && String(a.error).trim()) return false;
  const f = a.features;
  if (!f || typeof f !== "object") return false;
  if (typeof f.error === "string" && f.error.trim()) return false;
  return f.duration_sec != null || f.pitch_score != null;
}

export async function analyzeVoiceMessageRecord(messageDoc) {
  const att = voiceAttachment(messageDoc);
  if (!att?.url) {
    throw new Error("No voice attachment URL on message");
  }
  if (!isAiServiceConfigured("chat")) {
    throw new Error("AI chat service is not configured");
  }

  const sender =
    messageDoc.senderId?.username != null
      ? messageDoc.senderId
      : null;
  const userName = senderLabel(sender);

  const raw = await callAiService("chat", "POST", "/analyze-voice", {
    data: {
      audio_url: att.url,
      user: userName,
    },
    timeoutMs: 180_000,
  });

  return mapAnalysisPayload(raw);
}

export function queueVoiceAnalysis(messageId) {
  const key = String(messageId);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    try {
      await messageModel.updateOne(
        { _id: messageId },
        { $set: { voiceAnalysisStatus: "pending" } },
      );

      const message = await messageModel
        .findById(messageId)
        .populate("senderId", "username fullName email")
        .lean();

      if (!message) return;

      const analysis = await analyzeVoiceMessageRecord(message);
      if (analysis?.error) {
        await messageModel.updateOne(
          { _id: messageId },
          {
            $set: {
              voiceAnalysisStatus: "failed",
              voiceAnalysis: { error: analysis.error, analyzedAt: new Date() },
            },
          },
        );
        return;
      }

      await messageModel.updateOne(
        { _id: messageId },
        {
          $set: {
            voiceAnalysisStatus: "ready",
            voiceAnalysis: analysis,
          },
        },
      );
    } catch (err) {
      log.warn({ err: err.message, messageId: key }, "voice analysis failed");
      await messageModel.updateOne(
        { _id: messageId },
        {
          $set: {
            voiceAnalysisStatus: "failed",
            voiceAnalysis: {
              error: err.message || "Analysis failed",
              analyzedAt: new Date(),
            },
          },
        },
      );
    }
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, job);
  return job;
}

async function orgRoomIds(orgId) {
  const rooms = await chatRoomModel
    .find({ organizationId: orgId, isDeleted: false })
    .select("_id name")
    .lean();
  return rooms;
}

export async function getVoiceSpeechDashboard(orgId, userId) {
  await requireOrgAdmin(orgId, userId);

  const rooms = await orgRoomIds(orgId);
  const roomIds = rooms.map((r) => r._id);
  const roomNameById = Object.fromEntries(
    rooms.map((r) => [String(r._id), r.name || "Chat"]),
  );

  if (!roomIds.length) {
    return { featured: null, recent: [], analyzing: false };
  }

  const messages = await messageModel
    .find({
      chatRoomId: { $in: roomIds },
      deletedForEveryone: false,
      $or: [{ messageType: "voice" }, { "attachments.type": "voice" }],
    })
    .sort({ createdAt: -1 })
    .limit(15)
    .populate("senderId", "username fullName email")
    .lean();

  let analyzing = false;

  for (const msg of messages) {
    if (hasValidAnalysis(msg)) continue;
    if (msg.voiceAnalysisStatus === "pending" || inFlight.has(String(msg._id))) {
      analyzing = true;
      continue;
    }
    if (!voiceAttachment(msg)) continue;
    // Re-analyze if missing, failed, or cached with invalid/empty features.
    queueVoiceAnalysis(msg._id);
    analyzing = true;
    break;
  }

  const recent = messages.map((msg) => {
    const att = voiceAttachment(msg);
    return {
      messageId: String(msg._id),
      roomId: String(msg.chatRoomId),
      roomName: roomNameById[String(msg.chatRoomId)] || "Chat",
      senderName: senderLabel(msg.senderId),
      createdAt: msg.createdAt,
      audioUrl: att?.url ?? null,
      status: msg.voiceAnalysisStatus || (att ? "pending" : "failed"),
      analysis: msg.voiceAnalysis ?? null,
    };
  });

  const featured =
    recent.find(
      (m) =>
        m.status === "ready" &&
        m.analysis &&
        !m.analysis.error &&
        m.analysis.features &&
        (m.analysis.features.duration_sec != null ||
          m.analysis.features.pitch_score != null),
    ) ?? null;

  return { featured, recent, analyzing };
}

export async function getVoiceAnalysisForMessage(messageId, userId, orgId) {
  await requireOrgAdmin(orgId, userId);

  const message = await messageModel
    .findById(messageId)
    .populate("senderId", "username fullName email")
    .lean();

  if (!message) return null;

  const room = await chatRoomModel
    .findById(message.chatRoomId)
    .select("organizationId name")
    .lean();

  if (!room || String(room.organizationId) !== String(orgId)) {
    return null;
  }

  if (message.voiceAnalysisStatus !== "ready" && voiceAttachment(message)) {
    if (!inFlight.has(String(messageId))) {
      queueVoiceAnalysis(messageId);
    }
  }

  return {
    messageId: String(message._id),
    roomName: room.name || "Chat",
    senderName: senderLabel(message.senderId),
    createdAt: message.createdAt,
    status: message.voiceAnalysisStatus || "pending",
    analysis: message.voiceAnalysis ?? null,
  };
}
