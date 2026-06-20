import chatRoomModel, {
  chatRoomTypes,
} from "../../../DB/Model/chatroom.model.js";
import memberModel from "../../../DB/Model/member.model.js";
import userModel from "../../../DB/Model/user.model.js";
import teamModel from "../../../DB/Model/team.model.js";
import projectModel from "../../../DB/Model/project.model.js";
import { asyncHandler } from "../../../utils/response/error.response.js";
import { successResponse } from "../../../utils/response/success.response.js";
import { getPagination } from "../../../utils/db/pagination.js";
import { getChatNamespace } from "../../socket/socket.controller.js";
import messageModel from "../../../DB/Model/message.model.js";
import reactionModel from "../../../DB/Model/reaction.model.js";
import * as dbService from "../../../DB/db.service.js";
import {
  forceUserLeaveRoom,
  forceAllMembersLeaveRoom,
} from "../../socket/util/socket-room.util.js";
import { childLogger } from "../../../utils/logger/logger.js";
import { requireOrgMember } from "../../../utils/permissions/org.permissions.js";
import { httpError } from "../../../utils/errors/index.js";

const chatLog = childLogger("chat-service");
// ─────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────

async function requireRoomMember(roomId, userId) {
  const room = await dbService.findOne({
    model: chatRoomModel,
    filter: {
      _id: roomId,
      members: userId,
      isDeleted: false,
    },
  });
  if (!room)
    throw httpError(404, "Room not found or access denied");
  return room;
}

async function requireRoomAdmin(room, userId) {
  const uid = userId.toString();
  const isAdmin = room.admins.some((a) => a.toString() === uid);
  const isCreator = room.createdBy.toString() === uid;
  if (!isAdmin && !isCreator)
    throw httpError(403, "Not authorized to manage this room");
}

// Note: chat-membership sync helpers live in `chat.sync.service.js`
// with proper diffing + socket eviction. Callers import them directly
// from that module — do NOT re-export here to avoid two divergent
// implementations of the same logic.

// FIX: helper to find a shared org between two users
async function findSharedOrg(userIdA, userIdB) {
  const orgsA = await dbService.find({
    model: memberModel,
    filter: {
      userId: userIdA,
      isActive: true,
    },
    select: "organizationId",
  });
  const orgIdsA = new Set(orgsA.map((m) => m.organizationId.toString()));

  const orgsB = await dbService.find({
    model: memberModel,
    filter: {
      userId: userIdB,
      isActive: true,
    },
    select: "organizationId",
  });

  for (const m of orgsB) {
    if (orgIdsA.has(m.organizationId.toString())) {
      return m.organizationId;
    }
  }
  return null;
}

function broadcastRoomCreated(room) {
  try {
    const chatNs = getChatNamespace();
    if (chatNs && chatNs.broadcastRoomCreated) {
      chatNs.broadcastRoomCreated(room);
    }
  } catch (err) {
    chatLog.error({ err, roomId: room?._id }, "broadcastRoomCreated failed");
  }
}

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/direct
// FIX: now verifies both users share an org and stores organizationId
// ─────────────────────────────────────────────────────────────

export const createDirect = asyncHandler(async (req, res, next) => {
  const senderId = req.user._id;
  const { targetUserId } = req.body;

  if (senderId.toString() === targetUserId) {
    return next(httpError(400, "Cannot create a DM with yourself"));
  }

  const target = await dbService.findOne({
    model: userModel,
    filter: {
      _id: targetUserId,
      isDeleted: false,
    },
    select: "_id username",
  });
  if (!target) return next(httpError(404, "Target user not found"));

  // FIX: verify both users share at least one organization
  const sharedOrgId = await findSharedOrg(senderId, targetUserId);
  if (!sharedOrgId) {
    return next(
      httpError(403, "Cannot create a DM — you don't share an organization with this user"),
    );
  }

  // check for existing DM within same org
  const existing = await dbService.findOne({
    model: chatRoomModel,
    filter: {
      type: chatRoomTypes.direct,
      organizationId: sharedOrgId,
      members: { $all: [senderId, targetUserId], $size: 2 },
      isDeleted: false,
    },
  });
  if (existing) {
    return successResponse({
      res,
      data: { room: existing },
      message: "DM already exists",
    });
  }

  const room = await dbService.create({
    model: chatRoomModel,
    data: {
      type: chatRoomTypes.direct,
      organizationId: sharedOrgId, // FIX: DMs now scoped to an org
      members: [senderId, targetUserId],
      admins: [senderId],
      createdBy: senderId,
      isPrivate: true,
    },
  });

  const populated = await dbService.findOne({
    model: chatRoomModel,
    filter: { _id: room._id },
    populate: {
      path: "members",
      select: "username email image",
    },
    lean: true,
  });

  broadcastRoomCreated(populated);

  return successResponse(
    { res, data: { room: populated }, message: "Direct message created" },
    201,
  );
});

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/channel
// ─────────────────────────────────────────────────────────────

export const createChannel = asyncHandler(async (req, res, next) => {
  const {
    name,
    description,
    organizationId,
    teamId,
    projectId,
    isPrivate,
    memberIds = [], // ✅ NEW
  } = req.body;
  const userId = req.user._id;

  // FIX: channel MUST be scoped to org/team/project — otherwise it has no
  // access boundary and ends up orphaned (no one can list it).
  if (!organizationId && !teamId && !projectId) {
    return next(
      httpError(400, "Channel must be scoped to an organization, team, or project"),
    );
  }

  if (organizationId) {
    const member = await requireOrgMember(organizationId, userId);
    if (!["owner", "admin"].includes(member.role)) {
      return next(
        httpError(403, "Only organization owner or admin can create channels"),
      );
    }
  }

  // FIX: when teamId is provided, resolve the org from the team
  let resolvedOrgId = organizationId || null;

  if (teamId) {
    // FIX: team-scoped channel creation requires team-manager OR
    // org-admin/owner authority. Plain team members can join existing
    // channels but not create new ones — matches Slack/Teams convention.
    const team = await dbService.findOne({
      model: teamModel,
      filter: {
        _id: teamId,
        members: userId,
        isDeleted: false,
      },
    });
    if (!team)
      return next(
        httpError(404, "Team not found or you are not a member"),
      );

    const isTeamManager = team.managers
      .map((m) => m.toString())
      .includes(userId.toString());

    let isOrgAdmin = false;
    if (team.organizationId) {
      const mem = await dbService.findOne({
        model: memberModel,
        filter: {
          organizationId: team.organizationId,
          userId,
          isActive: true,
        },
      });
      isOrgAdmin = mem && ["owner", "admin"].includes(mem.role);
    }

    if (!isTeamManager && !isOrgAdmin) {
      return next(
        httpError(403, "Only a team manager or organization admin/owner can create team channels"),
      );
    }

    // FIX: use the team's organizationId
    if (!resolvedOrgId) resolvedOrgId = team.organizationId;
  }

  if (projectId) {
    const project = await dbService.findOne({
      model: projectModel,
      filter: {
        _id: projectId,
        isDeleted: false,
      },
      select: "manager organizationId",
    });
    if (!project) return next(httpError(404, "Project not found"));

    const isProjectManager = project.manager.toString() === userId.toString();
    let isOrgAdmin = false;
    if (project.organizationId) {
      const mem = await dbService.findOne({
        model: memberModel,
        filter: {
          organizationId: project.organizationId,
          userId,
          isActive: true,
        },
      });
      isOrgAdmin = mem && ["owner", "admin"].includes(mem.role);
    }
    if (!isProjectManager && !isOrgAdmin)
      return next(
        httpError(403, "Only project manager or organization owner/admin can create project channels"),
      );

    if (!resolvedOrgId) resolvedOrgId = project.organizationId;
  }

  // ── Check for duplicate channel in same scope ───────────
  const existingChannel = await dbService.findOne({
    model: chatRoomModel,
    filter: {
      name,
      organizationId: resolvedOrgId,
      teamId: teamId || null,
      projectId: projectId || null,
      type: chatRoomTypes.channel,
      isDeleted: false,
    },
  });
  if (existingChannel) {
    return next(
      httpError(409, "A channel with the same name already exists in this scope"),
    );
  }

  // ── ✅ NEW: Build initial members list ──────────────────
  // Always include creator + any pre-selected members
  const initialMembers = [
    ...new Set([userId.toString(), ...memberIds.map((id) => id.toString())]),
  ];

  // ── ✅ NEW: Validate that all selected members belong to ─
  //          the resolved organization (if scoped to one)
  if (memberIds.length > 0 && resolvedOrgId) {
    const validMembers = await dbService.find({
      model: memberModel,
      filter: {
        organizationId: resolvedOrgId,
        userId: { $in: memberIds },
        isActive: true,
      },
      select: "userId",
      lean: true,
    });

    if (validMembers.length !== memberIds.length) {
      return next(
        httpError(400, "One or more selected members are not active members of this organization"),
      );
    }
  }

  const room = await dbService.create({
    model: chatRoomModel,
    data: {
      name,
      description: description || null,
      type: chatRoomTypes.channel,
      organizationId: resolvedOrgId,
      teamId: teamId || null,
      projectId: projectId || null,
      members: initialMembers, // ✅ NEW: includes pre-selected members
      admins: [userId],
      createdBy: userId,
      isPrivate: isPrivate ?? false,
    },
  });

  const populated = await dbService.findOne({
    model: chatRoomModel,
    filter: { _id: room._id },
    populate: {
      path: "members",
      select: "username email image",
    },
    lean: true,
  });

  broadcastRoomCreated(populated);

  return successResponse(
    { res, data: { room: populated }, message: "Channel created" },
    201,
  );
});

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/team
// ─────────────────────────────────────────────────────────────

export const createTeamChat = asyncHandler(async (req, res, next) => {
  const { teamId } = req.body;
  const userId = req.user._id;

  const team = await dbService.findOne({
    model: teamModel,
    filter: {
      _id: teamId,
      members: userId,
      isDeleted: false,
    },
    select: "members name organizationId",
  });
  if (!team)
    return next(
      httpError(404, "Team not found or you are not a member"),
    );

  let room = await dbService.findOne({
    model: chatRoomModel,
    filter: {
      type: chatRoomTypes.team,
      teamId,
      isDeleted: false,
    },
  });

  if (room) {
    return successResponse({
      res,
      data: { room },
      message: "Team chat already exists",
    });
  }

  // FIX: admins must be team managers + team creator, NOT every member.
  // The previous `admins: team.members` made every team member able to
  // delete/update the team chat, which is a clear access-control bug.
  const adminIds = [
    ...new Set([
      team.createdBy?.toString(),
      ...team.managers.map((m) => m.toString()),
    ].filter(Boolean)),
  ];

  room = await dbService.create({
    model: chatRoomModel,
    data: {
      name: team.name ? `Team: ${team.name}` : "Team Chat",
      type: chatRoomTypes.team,
      organizationId: team.organizationId, // FIX: use team's org
      teamId,
      members: team.members,
      admins: adminIds,
      createdBy: userId,
      isPrivate: false,
    },
  });

  const populated = await dbService.findOne({
    model: chatRoomModel,
    filter: { _id: room._id },
    populate: {
      path: "members",
      select: "username email image",
    },
    lean: true,
  });

  broadcastRoomCreated(populated);

  return successResponse(
    { res, data: { room: populated }, message: "Team chat created" },
    201,
  );
});

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/organization
// ─────────────────────────────────────────────────────────────

export const createOrganizationChat = asyncHandler(async (req, res, next) => {
  const { organizationId } = req.body;
  const userId = req.user._id;

  const member = await requireOrgMember(organizationId, userId);
  if (!["owner", "admin"].includes(member.role)) {
    return next(
      httpError(403, "Only organization owner or admin can create organization chat"),
    );
  }

  let room = await dbService.findOne({
    model: chatRoomModel,
    filter: {
      type: chatRoomTypes.organization,
      organizationId,
      isDeleted: false,
    },
  });

  if (room) {
    return successResponse({
      res,
      data: { room },
      message: "Organization chat already exists",
    });
  }

  const orgMembers = await dbService.find({
    model: memberModel,
    filter: { organizationId, isActive: true },
    select: "userId role",
  });
  const memberIds = orgMembers.map((m) => m.userId);
  // FIX: org-wide chat admins must be ONLY org owners/admins, not every
  // member. The previous code gave every org member admin rights to the
  // organization-wide chat (so anyone could delete it).
  const adminIds = orgMembers
    .filter((m) => ["owner", "admin"].includes(m.role))
    .map((m) => m.userId);

  room = await dbService.create({
    model: chatRoomModel,
    data: {
      name: "Organization Chat",
      type: chatRoomTypes.organization,
      organizationId,
      members: memberIds,
      admins: adminIds,
      createdBy: userId,
      isPrivate: false,
    },
  });

  const populated = await dbService.findOne({
    model: chatRoomModel,
    filter: { _id: room._id },
    populate: {
      path: "members",
      select: "username email image",
    },
    lean: true,
  });

  broadcastRoomCreated(populated);

  return successResponse(
    { res, data: { room: populated }, message: "Organization chat created" },
    201,
  );
});

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/group
// ─────────────────────────────────────────────────────────────

export const createGroup = asyncHandler(async (req, res, next) => {
  const { name, description, organizationId, memberIds } = req.body;
  const userId = req.user._id;

  // FIX: allow any org member to create group chats (not just admin/owner)
  await requireOrgMember(organizationId, userId);

  const allMemberIds = [...new Set([userId.toString(), ...memberIds])];

  const validMembers = await dbService.find({
    model: memberModel,
    filter: {
      organizationId,
      userId: { $in: allMemberIds },
      isActive: true,
    },
    select: "userId",
    lean: true,
  });

  if (validMembers.length !== allMemberIds.length) {
    return next(
      httpError(400, "One or more members are not part of the organization"),
    );
  }

  const room = await dbService.create({
    model: chatRoomModel,
    data: {
      name,
      description: description || null,
      type: chatRoomTypes.group,
      organizationId,
      members: allMemberIds,
      admins: [userId],
      createdBy: userId,
      isPrivate: true,
    },
  });

  const populated = await dbService.findOne({
    model: chatRoomModel,
    filter: { _id: room._id },
    populate: {
      path: "members",
      select: "username email image",
    },
    lean: true,
  });

  broadcastRoomCreated(populated);

  return successResponse(
    { res, data: { room: populated }, message: "Group chat created" },
    201,
  );
});

// GET /chat/rooms  — UPDATED: embeds unread counts per room
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// GET /chat/rooms/browse — discover PUBLIC channels in the org the
// caller has NOT joined yet (the "Browse channels" modal). Private
// channels and rooms the user is already in are excluded.
// ─────────────────────────────────────────────────────────────
export const browseChannels = asyncHandler(async (req, res, next) => {
  const userId = req.user._id;
  const { organizationId, search } = req.query;

  // Only members of the org may browse its channels.
  await requireOrgMember(organizationId, userId);

  const { page, limit, skip } = getPagination(req.query);

  const filter = {
    organizationId,
    type: chatRoomTypes.channel,
    isPrivate: false,
    isDeleted: false,
    members: { $ne: userId }, // hide channels the user already belongs to
  };

  if (search && search.trim()) {
    // Escape regex metacharacters so a stray "." or "(" in the search
    // box can't break the query or match unexpectedly.
    const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = { $regex: safe, $options: "i" };
    filter.$or = [{ name: rx }, { description: rx }];
  }

  const [rooms, total] = await Promise.all([
    chatRoomModel
      .find(filter)
      .select("name description icon branding type members createdBy createdAt")
      .populate("createdBy", "username image")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    chatRoomModel.countDocuments(filter),
  ]);

  // Expose a member count (not the full member list) and an explicit
  // isMember:false flag the FE can rely on when rendering the Join button.
  const discoverable = rooms.map((r) => ({
    ...r,
    memberCount: Array.isArray(r.members) ? r.members.length : 0,
    members: undefined,
    isMember: false,
  }));

  return successResponse({
    res,
    data: { rooms: discoverable, total, page, limit },
  });
});

// ─────────────────────────────────────────────────────────────
// GET /chat/rooms
// ─────────────────────────────────────────────────────────────
export const listChatRooms = asyncHandler(async (req, res, next) => {
  const userId = req.user._id;
  const { organizationId, type } = req.query;

  const { page, limit, skip } = getPagination(req.query);

  const filter = { members: userId, isDeleted: false };
  if (organizationId) filter.organizationId = organizationId;
  if (type) filter.type = type;

  const [rooms, total] = await Promise.all([
    chatRoomModel
      .find(filter)
      .populate("members", "username email image")
      .populate("admins", "username email image")
      .populate({
        path: "lastMessage",
        select: "content messageType senderId createdAt",
        populate: { path: "senderId", select: "username image" },
      })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    chatRoomModel.countDocuments(filter),
  ]);

  // ── Compute unread counts for all returned rooms in one query ──
  const roomIds = rooms.map((r) => r._id);

  const unreadAgg = await messageModel.aggregate([
    {
      $match: {
        chatRoomId: { $in: roomIds },
        deletedForEveryone: false,
        deletedFor: { $ne: userId },
        senderId: { $ne: userId },
        "seenBy.userId": { $ne: userId },
      },
    },
    {
      $group: {
        _id: "$chatRoomId",
        count: { $sum: 1 },
      },
    },
  ]);

  const unreadMap = new Map(
    unreadAgg.map((item) => [item._id.toString(), item.count]),
  );

  // ── Embed unreadCount into each room object ──
  const roomsWithUnread = rooms.map((room) => ({
    ...room,
    unreadCount: unreadMap.get(room._id.toString()) || 0,
  }));

  const totalUnread = unreadAgg.reduce((sum, item) => sum + item.count, 0);

  return successResponse({
    res,
    data: { rooms: roomsWithUnread, total, totalUnread, page, limit },
  });
});

// ─────────────────────────────────────────────────────────────
// GET /chat/rooms/:roomId
// ─────────────────────────────────────────────────────────────

export const getChatRoom = asyncHandler(async (req, res, next) => {
  const { roomId } = req.params;
  const userId = req.user._id;

  const room = await chatRoomModel
    .findOne({ _id: roomId, members: userId, isDeleted: false })
    .populate("members", "username email image")
    .populate("admins", "username email image")
    .populate("createdBy", "username email image")
    .populate({
      path: "lastMessage",
      select: "content messageType senderId createdAt",
      populate: { path: "senderId", select: "username image" }, // ✅ nested inside lastMessage
    });

  if (!room)
    return next(httpError(404, "Room not found or access denied"));

  return successResponse({ res, data: { room } });
});
// ─────────────────────────────────────────────────────────────
// PATCH /chat/rooms/:roomId
// ─────────────────────────────────────────────────────────────

export const updateRoom = asyncHandler(async (req, res, next) => {
  const { roomId } = req.params;
  const userId = req.user._id;
  const { name, description, isPrivate, icon, branding } = req.body;

  const room = await requireRoomMember(roomId, userId);
  await requireRoomAdmin(room, userId);

  if (room.type === chatRoomTypes.direct) {
    return next(
      httpError(400, "Cannot update a direct message room"),
    );
  }

  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (isPrivate !== undefined) update.isPrivate = isPrivate;
  if (icon !== undefined) update.icon = icon;
  // Partial branding merge — caller can update one field without
  // having to send the others. Empty string clears a value.
  if (branding && typeof branding === "object") {
    if (branding.color !== undefined) update["branding.color"] = branding.color;
    if (branding.coverImage !== undefined)
      update["branding.coverImage"] = branding.coverImage;
    if (branding.tagline !== undefined)
      update["branding.tagline"] = branding.tagline;
    if (branding.topic !== undefined) update["branding.topic"] = branding.topic;
  }

  const updated = await dbService.findOneAndUpdate({
    model: chatRoomModel,
    filter: { _id: roomId },
    data: update,
    options: { new: true },
  });

  return successResponse({
    res,
    data: { room: updated },
    message: "Room updated",
  });
});

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/:roomId/join
// ─────────────────────────────────────────────────────────────

export const joinChannel = asyncHandler(async (req, res, next) => {
  const { roomId } = req.params;
  const userId = req.user._id;

  const room = await dbService.findOne({
    model: chatRoomModel,
    filter: { _id: roomId, isDeleted: false },
  });
  if (!room) return next(httpError(404, "Room not found"));

  if (room.type !== chatRoomTypes.channel) {
    return next(
      httpError(400, "Can only join channels. Use invite for groups."),
    );
  }
  if (room.isPrivate) {
    return next(
      httpError(403, "This channel is private. Request an invite."),
    );
  }

  const alreadyMember = room.members.some(
    (m) => m.toString() === userId.toString(),
  );
  if (alreadyMember) {
    return successResponse({
      res,
      message: "Already a member",
      data: { room },
    });
  }

  if (room.organizationId) {
    await requireOrgMember(room.organizationId, userId);
  }

  const updated = await dbService.findOneAndUpdate({
    model: chatRoomModel,
    filter: { _id: roomId },
    data: { $addToSet: { members: userId } },
    options: { new: true },
  });

  return successResponse({
    res,
    data: { room: updated },
    message: "Joined channel",
  });
});

// ─────────────────────────────────────────────────────────────
// DELETE /chat/rooms/:roomId/leave
// ─────────────────────────────────────────────────────────────

export const leaveRoom = asyncHandler(async (req, res, next) => {
  const { roomId } = req.params;
  const userId = req.user._id;

  const room = await requireRoomMember(roomId, userId);

  if (room.type === chatRoomTypes.direct) {
    return next(httpError(400, "Cannot leave a direct message"));
  }
  const isAdmin = room.admins.some((a) => a.toString() === userId.toString());

  if (isAdmin && room.admins.length === 1 && room.members.length > 1) {
    const nextAdmin = room.members.find(
      (m) => m.toString() !== userId.toString(),
    );
    if (nextAdmin) {
      await dbService.findOneAndUpdate({
        model: chatRoomModel,
        filter: { _id: roomId },
        data: { $addToSet: { admins: nextAdmin } },
      });
    }
  }
  await dbService.findOneAndUpdate({
    model: chatRoomModel,
    filter: { _id: roomId },
    data: { $pull: { members: userId, admins: userId } },
    options: { new: true },
  });

  // 🆕 The user might have multiple tabs/devices; kick them all
  await forceUserLeaveRoom(userId, roomId);

  return successResponse({ res, message: "Left room successfully" });
});

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/:roomId/members/:memberId
// ─────────────────────────────────────────────────────────────

export const addMember = asyncHandler(async (req, res, next) => {
  const { roomId, memberId } = req.params;
  const userId = req.user._id;

  const room = await requireRoomMember(roomId, userId);
  await requireRoomAdmin(room, userId);

  if (room.type === chatRoomTypes.direct) {
    return next(
      httpError(400, "Cannot add members to a direct message"),
    );
  }

  // FIX: organization-wide chat membership is managed by the org module
  // (members join automatically when accepted into the org). Manually
  // adding people here desyncs the room from its source of truth.
  if (room.type === chatRoomTypes.organization) {
    return next(
      httpError(
        400,
        "Organization chat membership is managed automatically. " +
          "Invite the user to the organization instead.",
      ),
    );
  }

  const newMember = await dbService.findOne({
    model: userModel,
    filter: { _id: memberId, isDeleted: false },
  });
  if (!newMember) return next(httpError(404, "User not found"));

  if (room.organizationId) {
    await requireOrgMember(room.organizationId, memberId);
  }

  // FIX: cross-scope leak — a team chat must only contain team members,
  // a project channel must only contain project members. Without this
  // check an admin could parachute someone from outside the team/project
  // into the chat (visible to all current members + can read history).
  if (room.type === chatRoomTypes.team && room.teamId) {
    const inTeam = await dbService.findOne({
      model: teamModel,
      filter: {
        _id: room.teamId,
        members: memberId,
        isDeleted: false,
      },
    });
    if (!inTeam) {
      return next(
        httpError(400, "User must be a member of the team before being added to the team chat"),
      );
    }
  }

  if (room.type === chatRoomTypes.channel && room.projectId) {
    const inProject = await dbService.findOne({
      model: projectModel,
      filter: {
        _id: room.projectId,
        members: memberId,
        isDeleted: false,
      },
    });
    if (!inProject) {
      return next(
        httpError(400, "User must be a member of the project before being added to its channel"),
      );
    }
  }

  const updated = await dbService.findOneAndUpdate({
    model: chatRoomModel,
    filter: { _id: roomId },
    data: { $addToSet: { members: memberId } },
    options: { new: true },
    populate: [{ path: "members", select: "username email image" }],
  });

  return successResponse({
    res,
    data: { room: updated },
    message: "Member added",
  });
});
// ─────────────────────────────────────────────────────────────
// DELETE /chat/rooms/:roomId/members/:memberId
// ─────────────────────────────────────────────────────────────
export const removeMember = asyncHandler(async (req, res, next) => {
  const { roomId, memberId } = req.params;
  const userId = req.user._id;

  const room = await requireRoomMember(roomId, userId);
  await requireRoomAdmin(room, userId);

  if (room.type === chatRoomTypes.direct) {
    return next(
      httpError(400, "Cannot remove members from a direct message"),
    );
  }

  if (memberId === userId.toString()) {
    return next(
      httpError(400, "Use the leave endpoint to remove yourself"),
    );
  }

  await dbService.findOneAndUpdate({
    model: chatRoomModel,
    filter: { _id: roomId },
    data: { $pull: { members: memberId, admins: memberId } },
    options: { new: true },
  });

  // 🆕 Socket cleanup: kick removed member's sockets out of the room
  await forceUserLeaveRoom(memberId, roomId);

  return successResponse({ res, message: "Member removed" });
});

// ─────────────────────────────────────────────────────────────
// DELETE /chat/rooms/:roomId
// ─────────────────────────────────────────────────────────────
export const deleteRoom = asyncHandler(async (req, res, next) => {
  const { roomId } = req.params;
  const userId = req.user._id;

  const room = await dbService.findOne({
    model: chatRoomModel,
    filter: { _id: roomId, isDeleted: false },
  });
  if (!room) return next(httpError(404, "Room not found"));

  if (room.createdBy.toString() !== userId.toString()) {
    return next(
      httpError(403, "Only the room creator can delete this room"),
    );
  }

  await dbService.updateOne({
    model: chatRoomModel,
    filter: { _id: roomId },
    data: { isDeleted: true, deletedAt: new Date() },
  });

  // 🆕 Force all members' sockets out of the room
  await forceAllMembersLeaveRoom(room.members, roomId);

  return successResponse({ res, message: "Room deleted" });
});