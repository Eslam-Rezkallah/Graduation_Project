/**
 * modules/workSession/admin.controller.js
 *
 * ── ADMIN WORK-SESSION MONITORING ───────────────────────────────
 * Org owner/admin endpoints used by the employee-detail screen to
 * inspect ANOTHER member's tracked time and screenshots.
 *
 *   GET /work-session/admin/sessions?orgId=&userId=&status=&from=&to=&page=&limit=
 *   GET /work-session/admin/screenshots?orgId=&userId=&from=&to=&page=&limit=
 *
 * Mounted at /work-session BEFORE screenshot.controller.js so the
 * static "/admin/..." paths win over its dynamic "/:sessionId/..."
 * routes (otherwise "/admin/screenshots" would be parsed as a
 * sessionId="admin" lookup and 404).
 *
 * The owner's own sessions are served by GET /work-session/me — this
 * file is strictly the manager-looking-at-someone-else path, so every
 * route is gated by requireOrgAdmin.
 */

import { Router } from "express";
import joi from "joi";
import workSessionModel, {
  SESSION_STATUS,
} from "../../DB/Model/worksession.model.js";
import screenshotModel from "../../DB/Model/screenshot.model.js";
import { authentication } from "../../middleware/auth.middleware.js";
import {
  validation,
  generalFields,
} from "../../middleware/validation.middleware.js";
import { asyncHandler } from "../../utils/response/error.response.js";
import { successResponse } from "../../utils/response/success.response.js";
import { requireOrgAdmin } from "../../utils/permissions/org.permissions.js";

const router = Router();
router.use(authentication());

// ── Shared shaping: derive totalSeconds the same way getMySessions does
function shapeSession(s) {
  return {
    _id: s._id,
    userId: s.userId,
    organizationId: s.organizationId,
    taskId: s.taskId || null,
    status: s.status,
    startTime: s.startTime,
    endTime: s.endTime || null,
    activeSeconds: s.activeSeconds,
    idleSeconds: s.idleSeconds,
    pausedSeconds: s.pausedSeconds,
    totalSeconds:
      s.status === SESSION_STATUS.STOPPED
        ? (s.activeSeconds || 0) + (s.idleSeconds || 0) + (s.pausedSeconds || 0)
        : Math.floor((Date.now() - new Date(s.startTime)) / 1000),
    lastActivityAt: s.lastActivityAt,
    isIdle: s.isIdle,
    note: s.note,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// GET /work-session/admin/sessions
// Org admin views a single member's (or the whole org's) sessions.
// ─────────────────────────────────────────────────────────────
const listSessionsSchema = joi
  .object({
    orgId: generalFields.id.required(),
    userId: generalFields.id, // optional — omit to list the whole org
    status: joi.string().valid("active", "paused", "stopped"),
    from: joi.date().iso(),
    to: joi.date().iso().min(joi.ref("from")),
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(100).default(20),
  })
  .required();

router.get(
  "/admin/sessions",
  validation(listSessionsSchema),
  asyncHandler(async (req, res) => {
    const { orgId, userId, status, from, to } = req.query;
    await requireOrgAdmin(orgId, req.user._id);

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = { organizationId: orgId };
    if (userId) filter.userId = userId;
    if (status) filter.status = status;
    if (from || to) {
      filter.startTime = {};
      if (from) filter.startTime.$gte = new Date(from);
      if (to) filter.startTime.$lte = new Date(to);
    }

    const [docs, total] = await Promise.all([
      workSessionModel
        .find(filter)
        .select(
          "userId organizationId status taskId startTime endTime " +
            "activeSeconds idleSeconds pausedSeconds lastActivityAt isIdle " +
            "note createdAt updatedAt",
        )
        .populate("taskId", "title status priority")
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      workSessionModel.countDocuments(filter),
    ]);

    return successResponse({
      res,
      data: { page, limit, total, items: docs.map(shapeSession) },
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// GET /work-session/admin/screenshots
// Resolves the member's sessions in the org, then returns their
// screenshots newest-first. userId is required here (a screenshot
// view always targets one person).
// ─────────────────────────────────────────────────────────────
const listScreenshotsSchema = joi
  .object({
    orgId: generalFields.id.required(),
    userId: generalFields.id.required(),
    from: joi.date().iso(),
    to: joi.date().iso().min(joi.ref("from")),
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(100).default(20),
  })
  .required();

router.get(
  "/admin/screenshots",
  validation(listScreenshotsSchema),
  asyncHandler(async (req, res) => {
    const { orgId, userId, from, to } = req.query;
    await requireOrgAdmin(orgId, req.user._id);

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Which sessions belong to this member in this org?
    const sessionIds = (
      await workSessionModel
        .find({ organizationId: orgId, userId })
        .select("_id")
        .lean()
    ).map((s) => s._id);

    if (sessionIds.length === 0) {
      return successResponse({
        res,
        data: { items: [], total: 0, page, limit },
      });
    }

    const filter = { session: { $in: sessionIds } };
    if (from || to) {
      filter.capturedAt = {};
      if (from) filter.capturedAt.$gte = new Date(from);
      if (to) filter.capturedAt.$lte = new Date(to);
    }

    const [shots, total] = await Promise.all([
      screenshotModel
        .find(filter)
        .sort({ capturedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      screenshotModel.countDocuments(filter),
    ]);

    // Stamp userId onto each row so the FE can group/label without a
    // second lookup (the screenshot doc only stores its session).
    const items = shots.map((s) => ({ ...s, userId }));

    return successResponse({
      res,
      data: { items, total, page, limit },
    });
  }),
);

export default router;
