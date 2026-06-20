import mongoose from "mongoose";
import organizationModel from "../../../DB/Model/organization.model.js";
import memberModel from "../../../DB/Model/member.model.js";
import workSessionModel from "../../../DB/Model/worksession.model.js";
import chatRoomModel from "../../../DB/Model/chatroom.model.js";
import * as dbService from "../../../DB/db.service.js";
import { asyncHandler } from "../../../utils/response/error.response.js";
import { successResponse } from "../../../utils/response/success.response.js";
import { getPagination } from "../../../utils/db/pagination.js";
import { recordAudit } from "../../../utils/audit/audit.logger.js";
import { auditActions } from "../../../utils/audit/audit.actions.js";
import { httpError } from "../../../utils/errors/index.js";

// ─────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────

const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const genJoinCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

async function ensureUniqueJoinCode() {
  while (true) {
    const joinCode = genJoinCode();
    const exists = await dbService.findOne({
      model: organizationModel,
      filter: { joinCode, isDeleted: false },
    });
    if (!exists) return joinCode;
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTED HELPER — reused by member.service.js & invitation.service.js
// ─────────────────────────────────────────────────────────────

export async function requireOrgRole({ orgId, userId, roles }) {
  const member = await dbService.findOne({
    model: memberModel,
    filter: { organizationId: orgId, userId, isActive: true },
  });
  if (!member)
    throw httpError(403, "You are not a member of this organization");
  if (!roles.includes(member.role))
    throw httpError(403, "Not authorized");
  return member;
}

// ─────────────────────────────────────────────────────────────
// GET /org/me
// ─────────────────────────────────────────────────────────────

export const getMyOrganizations = asyncHandler(async (req, res, next) => {
  const memberships = await  dbService.find({
    model: memberModel,
    filter: { userId: req.user._id, isActive: true },
    populate: {
      path: "organizationId",
      match: { isDeleted: false, isActive: true },
      select: "name slug logo ownerId createdAt",
    },
  }) 
  const organizations = memberships
    .filter((m) => m.organizationId)
    .map((m) => ({
      // organizationId is a populated Mongoose document — spreading it
      // directly copies internal props ($__, _doc, …) and buries the real
      // fields (_id, name) inside _doc, so the FE reads org._id as
      // undefined and bounces the user to onboarding. toObject() flattens
      // it to a plain { _id, name, slug, logo, ownerId, createdAt } first.
      ...m.organizationId.toObject(),
      memberRole: m.role,
      joinedAt: m.joinedAt,
    }));

  return successResponse({ res, data: { organizations } });
});

// ─────────────────────────────────────────────────────────────
// GET /org/:orgId
// ─────────────────────────────────────────────────────────────

export const getOrg = asyncHandler(async (req, res, next) => {
  const { orgId } = req.params;

  const member = await dbService.findOne({
    model: memberModel,
    filter: { organizationId: orgId, userId: req.user._id, isActive: true },
  });
  if (!member)
    return next(httpError(403, "Not a member of this organization"));

  const org = await dbService.findOne({
    model: organizationModel,
    filter: { _id: orgId, isDeleted: false },
  });
  if (!org) return next(httpError(404, "Organization not found"));

  const memberCount = await dbService.countDocuments({
    model: memberModel,
    filter: { organizationId: orgId, isActive: true },
  });

  const orgData = org.toObject();

  // Only owner/admin can see the joinCode
  if (!["owner", "admin"].includes(member.role)) {
    delete orgData.joinCode;
  }

  return successResponse({
    res,
    data: {
      ...orgData,
      memberCount,
      memberRole: member.role,
    },
  });
});
// ─────────────────────────────────────────────────────────────
// POST /org
// FIX: rejects duplicate name and slug instead of auto-incrementing
// ─────────────────────────────────────────────────────────────

export const createOrg = asyncHandler(async (req, res, next) => {
  const { name, slug: providedSlug, logo = null } = req.body;

  // ── Check duplicate name ────────────────────────────────
  const existingName = await dbService.findOne({
    model: organizationModel,
    filter: { name, isDeleted: false },
  });
  if (existingName) {
    return next(httpError(409, "Organization name already exists"));
  }

  // ── Check duplicate slug ────────────────────────────────
  const baseSlug = providedSlug ? providedSlug : slugify(name);
  const existingSlug = await dbService.findOne({
    model: organizationModel,
    filter: { slug: baseSlug, isDeleted: false },
  });
  if (existingSlug) {
    return next(
      httpError(409, "Organization slug already taken. Choose a different name or slug."),
    );
  }

  const joinCode = await ensureUniqueJoinCode();

  const uploadedLogo = req.file
    ? `/${String(req.file.finalPath || "").replace(/\\/g, "/")}`
    : logo;

  const org = await dbService.create({
    model: organizationModel,
    data: {
      name,
      slug: baseSlug,
      logo: uploadedLogo || null,
      joinCode,
      ownerId: req.user._id,
      isActive: true,
      isDeleted: false,
    },
  });

  await dbService.create({
    model: memberModel,
    data: {
      organizationId: org._id,
      userId: req.user._id,
      role: "owner",
      isActive: true,
    },
  });

  await recordAudit({
    req,
    actorId: req.user._id,
    orgId: org._id,
    action: auditActions.ORG_CREATE,
    targetType: "Organization",
    targetId: org._id,
    meta: { name: org.name, slug: org.slug },
  });

  return successResponse(
    { res, message: "Organization created", data: org },
    201,
  );
});

// ─────────────────────────────────────────────────────────────
// PATCH /org/:orgId
// FIX: rejects duplicate name and slug on update
// ─────────────────────────────────────────────────────────────

export const updateOrg = asyncHandler(async (req, res, next) => {
  const { orgId } = req.params;
  const { name, slug: providedSlug, logo } = req.body;

  await requireOrgRole({
    orgId,
    userId: req.user._id,
    roles: ["owner", "admin"],
  });

  const org = await dbService.findOne({
    model: organizationModel,
    filter: { _id: orgId, isDeleted: false },
  });
  if (!org) return next(httpError(404, "Organization not found"));

  const update = {};

  // ── Validate name uniqueness ────────────────────────────
  if (name) {
    const existingName = await dbService.findOne({
      model: organizationModel,
      filter: { name, _id: { $ne: orgId }, isDeleted: false },
    });
    if (existingName) {
      return next(
        httpError(409, "Organization name already exists"),
      );
    }
    update.name = name;
  }

  // ── Handle logo upload ──────────────────────────────────
  const uploadedLogo = req.file
    ? `/${String(req.file.finalPath || "").replace(/\\/g, "/")}`
    : null;

  if (uploadedLogo) update.logo = uploadedLogo;
  else if (logo !== undefined) update.logo = logo;

  // ── Validate slug uniqueness ────────────────────────────
  if (providedSlug || name) {
    const baseSlug = providedSlug ? providedSlug : slugify(name);
    const existingSlug = await dbService.findOne({
      model: organizationModel,
      filter: { slug: baseSlug, _id: { $ne: orgId }, isDeleted: false },
    });
    if (existingSlug) {
      return next(httpError(409, "Slug already taken"));
    }
    update.slug = baseSlug;
  }

  if (Object.keys(update).length === 0) {
    return next(httpError(400, "No fields to update"));
  }

  const updated = await dbService.findOneAndUpdate({
    model: organizationModel,
    filter: { _id: orgId, isDeleted: false },
    data: update,
    options: { new: true },
  });

  return successResponse({
    res,
    message: "Organization updated",
    data: updated,
  });
});

// ─────────────────────────────────────────────────────────────
// DELETE /org/:orgId
// ─────────────────────────────────────────────────────────────

export const deleteOrg = asyncHandler(async (req, res, next) => {
  const { orgId } = req.params;

  await requireOrgRole({ orgId, userId: req.user._id, roles: ["owner"] });

  const org = await dbService.findOne({
    model: organizationModel,
    filter: { _id: orgId, isDeleted: false },
  });
  if (!org) return next(httpError(404, "Organization not found"));

  await dbService.updateOne({
    model: organizationModel,
    filter: { _id: orgId },
    data: { isDeleted: true, isActive: false },
  });

  await dbService.updateMany({
    model: memberModel,
    filter: { organizationId: orgId },
    data: { isActive: false },
  });

  await recordAudit({
    req,
    actorId: req.user._id,
    orgId,
    action: auditActions.ORG_DELETE,
    targetType: "Organization",
    targetId: orgId,
    meta: { name: org.name, slug: org.slug },
  });

  return successResponse({ res, message: "Organization deleted" });
});

// ─────────────────────────────────────────────────────────────
// GET /org/:orgId/work-sessions
// ─────────────────────────────────────────────────────────────

export const getOrgWorkSessions = asyncHandler(async (req, res, next) => {
  const { orgId } = req.params;
  const { userId, status, from, to } = req.query;

  await requireOrgRole({
    orgId,
    userId: req.user._id,
    roles: ["owner", "admin"],
  });

  const filter = { organizationId: orgId };
  if (userId) filter.userId = userId;
  if (status) filter.status = status;
  if (from || to) {
    filter.startTime = {};
    if (from) filter.startTime.$gte = new Date(from);
    if (to) filter.startTime.$lte = new Date(to);
  }

  const { page, limit, skip } = getPagination(req.query);

  const sessions = await dbService.find({
    model: workSessionModel,
    filter,
    populate: [
      { path: "userId", select: "username email image" },
      { path: "taskId", select: "title status priority" },
    ],
    skip,
    limit,
  });

  return successResponse({
    res,
    data: { sessions, total: sessions.length, page, limit },
  });
});

// ─────────────────────────────────────────────────────────────
// GET /org/:orgId/work-sessions/summary
// ─────────────────────────────────────────────────────────────

export const getWorkSessionsSummary = asyncHandler(async (req, res, next) => {
  const { orgId } = req.params;
  const { from, to } = req.query;

  await requireOrgRole({
    orgId,
    userId: req.user._id,
    roles: ["owner", "admin"],
  });

  const matchFilter = {
    // aggregation pipelines do NOT auto-cast strings to ObjectId
    organizationId: new mongoose.Types.ObjectId(orgId),
    status: "stopped",
  };

  if (from || to) {
    matchFilter.startTime = {};
    if (from) matchFilter.startTime.$gte = new Date(from);
    if (to) matchFilter.startTime.$lte = new Date(to);
  }

  const summary = await workSessionModel.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: "$userId",
        totalSessions: { $sum: 1 },
        totalActiveSeconds: { $sum: "$activeSeconds" },
        totalIdleSeconds: { $sum: "$idleSeconds" },
        totalPausedSeconds: { $sum: "$pausedSeconds" },
        avgActivePerSession: { $avg: "$activeSeconds" },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
        pipeline: [{ $project: { username: 1, email: 1, image: 1 } }],
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmpty: false } },
    {
      $project: {
        _id: 0,
        userId: "$_id",
        user: 1,
        totalSessions: 1,
        totalActiveSeconds: 1,
        totalIdleSeconds: 1,
        totalPausedSeconds: 1,
        avgActivePerSession: { $round: ["$avgActivePerSession", 0] },
        productivityPercent: {
          $cond: [
            {
              $gt: [{ $add: ["$totalActiveSeconds", "$totalIdleSeconds"] }, 0],
            },
            {
              $round: [
                {
                  $multiply: [
                    {
                      $divide: [
                        "$totalActiveSeconds",
                        {
                          $add: ["$totalActiveSeconds", "$totalIdleSeconds"],
                        },
                      ],
                    },
                    100,
                  ],
                },
                2,
              ],
            },
            0,
          ],
        },
      },
    },
    { $sort: { totalActiveSeconds: -1 } },
  ]);

  return successResponse({ res, data: { summary } });
});

// ─────────────────────────────────────────────────────────────
// GET /org/:orgId/chat-rooms
// ─────────────────────────────────────────────────────────────

export const getOrgChatRooms = asyncHandler(async (req, res, next) => {
  const { orgId } = req.params;

  const member = await dbService.findOne({
    model: memberModel,
    filter: { organizationId: orgId, userId: req.user._id, isActive: true },
  });
  if (!member)
    return next(httpError(403, "Not a member of this organization"));

  const rooms = await dbService.find({
    model: chatRoomModel,
    filter: {
      organizationId: orgId,
      members: req.user._id,
      isDeleted: false,
    },
    populate: [
      { path: "members", select: "username email image" },
      { path: "admins", select: "username image" },
      {
        path: "lastMessage",
        select: "content messageType senderId createdAt",
        populate: { path: "senderId", select: "username image" },
      },
    ],
  });

  const grouped = {
    organization: [],
    team: [],
    channel: [],
    group: [],
    direct: [],
  };

  for (const room of rooms) {
    if (grouped[room.type] !== undefined) {
      grouped[room.type].push(room);
    }
  }

  return successResponse({
    res,
    data: { rooms, grouped, total: rooms.length },
  });
});
