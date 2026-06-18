/**
 * modules/work-session/service/workSession.service.js
 *
 * All business logic for the Work Session module.
 *
 * ── TIME ACCOUNTING MODEL ───────────────────────────────────
 *
 *  wall-clock  = endTime - startTime
 *  pausedSec   = Σ (resumedAt - pausedAt) for each pause segment
 *  nonPausedSec= wall-clock - pausedSec
 *  idleSec     = accumulated by idle-detection cron (stored on doc)
 *  activeSec   = nonPausedSec - idleSec   (>= 0)
 *
 * ── STATE MACHINE ───────────────────────────────────────────
 *
 *   (none) ──start──► ACTIVE
 *   ACTIVE ──pause──► PAUSED
 *   PAUSED ──resume─► ACTIVE
 *   ACTIVE ──stop───► STOPPED
 *   PAUSED ──stop───► STOPPED
 *
 * Any other transition throws an error.
 */

import memberModel      from "../../../DB/Model/member.model.js";
import workSessionModel, { SESSION_STATUS } from "../../../DB/Model/worksession.model.js";
import * as dbService   from "../../../DB/db.service.js";
import { asyncHandler } from "../../../utils/response/error.response.js";
import { successResponse } from "../../../utils/response/success.response.js";
import { getPagination } from "../../../utils/db/pagination.js";
import {
  setSession,
  getSession,
  getByUserId,
  removeSession,
  updateSession,
} from "../../../utils/cache/session.store.js";
import { IDLE_THRESHOLD_SEC } from "../../../utils/jobs/idle.detection.job.js";
import { requireOrgMember } from "../../../utils/permissions/org.permissions.js";
import { httpError } from "../../../utils/errors/index.js";

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */

/** Fetch the current user's active OR paused session from DB */
async function findRunningSession(userId, orgId) {
  return workSessionModel.findOne({
    userId,
    organizationId: orgId,
    status: { $in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.PAUSED] },
  });
}

/**
 * Build the in-memory cache entry for a session.
 * Called after start and resume.
 */
async function cacheSession(session) {
  const now = Date.now();
  await setSession(session._id, {
    sessionId:      String(session._id),
    userId:         String(session.userId),
    lastActivityAt: now,
    lastHeartbeat:  now,
    isIdle:         false,
    idleSince:      null,
    accruedIdle:    0,
    dirty:          false,
  });
}

/**
 * Compute and persist the final time totals before stopping.
 * Mutates the Mongoose document in-place then saves.
 */
async function finalizeAndSave(session, extraFields = {}) {
  // Merge any in-memory idle seconds that haven't been flushed yet
  const cached = await getSession(session._id);
  if (cached && cached.accruedIdle > 0) {
    const delta = cached.accruedIdle - (session.idleSeconds || 0);
    if (delta > 0) session.idleSeconds += delta;
  }

  session.computeTotals(); // sets activeSeconds, pausedSeconds

  Object.assign(session, extraFields);
  return session.save();
}

/* ═══════════════════════════════════════════════════════════
   SERVICE HANDLERS
═══════════════════════════════════════════════════════════ */

/* ── POST /work-session/start ─────────────────────────────── */
export const startSession = asyncHandler(async (req, res, next) => {
  const { orgId, taskId, note } = req.body;
  const userId = req.user._id;

  await requireOrgMember(orgId, userId);

  /* Guard: only one active session per user (per org) */
  const existing = await findRunningSession(userId, orgId);
  if (existing) {
    return next(
      httpError(
        409,
        existing.status === SESSION_STATUS.ACTIVE
          ? "You already have an active session. Stop or pause it first."
          : "You have a paused session. Resume or stop it first.",
      ),
    );
  }

  const now = new Date();

  const session = await workSessionModel.create({
    userId,
    organizationId: orgId,
    taskId:         taskId || null,
    status:         SESSION_STATUS.ACTIVE,
    startTime:      now,
    lastActivityAt: now,
    lastHeartbeatAt: now,
    note:           note || "",
  });

  // Seed the in-memory cache
  await cacheSession(session);

  return successResponse({
    res,
    status:  201,
    message: "Work session started",
    data:    formatSession(session),
  });
});

/* ── POST /work-session/pause ─────────────────────────────── */
export const pauseSession = asyncHandler(async (req, res, next) => {
  const { orgId, note } = req.body;
  const userId = req.user._id;

  await requireOrgMember(orgId, userId);

  const session = await findRunningSession(userId, orgId);

  if (!session) {
    return next(httpError(404, "No active session found"));
  }
  if (session.status === SESSION_STATUS.PAUSED) {
    return next(httpError(409, "Session is already paused"));
  }

  const now = new Date();

  // Open a new pause segment
  session.pauseSegments.push({ pausedAt: now, resumedAt: null });
  if (note) session.note = note;

  // Flush accrued idle from memory before pausing
  const cached = await getSession(session._id);
  if (cached && cached.accruedIdle > 0) {
    const delta = cached.accruedIdle - (session.idleSeconds || 0);
    if (delta > 0) session.idleSeconds += delta;
  }

  session.status = SESSION_STATUS.PAUSED;
  session.lastActivityAt = now;
  session.lastHeartbeatAt = now;
  session.computeTotals();

  await session.save();

  // Remove from active-tracking cache (paused sessions don't accumulate idle)
  await removeSession(session._id);

  return successResponse({
    res,
    message: "Session paused",
    data:    formatSession(session),
  });
});

/* ── POST /work-session/resume ────────────────────────────── */
export const resumeSession = asyncHandler(async (req, res, next) => {
  const { orgId } = req.body;
  const userId = req.user._id;

  await requireOrgMember(orgId, userId);

  const session = await findRunningSession(userId, orgId);

  if (!session) {
    return next(httpError(404, "No paused session found"));
  }
  if (session.status === SESSION_STATUS.ACTIVE) {
    return next(httpError(409, "Session is already active"));
  }

  const now = new Date();

  // Close the latest open pause segment
  const openSeg = [...session.pauseSegments].reverse().find((s) => !s.resumedAt);
  if (openSeg) {
    openSeg.resumedAt = now;
  }

  session.status = SESSION_STATUS.ACTIVE;
  session.lastActivityAt = now;
  session.lastHeartbeatAt = now;
  session.isIdle = false;
  session.computeTotals();

  await session.save();

  // Re-seed the in-memory cache
  await cacheSession(session);

  return successResponse({
    res,
    message: "Session resumed",
    data:    formatSession(session),
  });
});

/* ── POST /work-session/stop ──────────────────────────────── */
export const stopSession = asyncHandler(async (req, res, next) => {
  const { orgId, note } = req.body;
  const userId = req.user._id;

  await requireOrgMember(orgId, userId);

  const session = await findRunningSession(userId, orgId);

  if (!session) {
    return next(httpError(404, "No active or paused session to stop"));
  }

  const now = new Date();

  // If it was paused, close the open pause segment before stopping
  if (session.status === SESSION_STATUS.PAUSED) {
    const openSeg = [...session.pauseSegments].reverse().find((s) => !s.resumedAt);
    if (openSeg) openSeg.resumedAt = now;
  }

  const stopped = await finalizeAndSave(session, {
    status:          SESSION_STATUS.STOPPED,
    endTime:         now,
    lastActivityAt:  now,
    lastHeartbeatAt: now,
    note:            note || session.note,
  });

  // Evict from in-memory cache
  await removeSession(session._id);

  return successResponse({
    res,
    message: "Session stopped",
    data:    formatSession(stopped),
  });
});

/* ── POST /work-session/activity ──────────────────────────── */
/**
 * Called by the frontend on every keyboard/mouse event (typically
 * debounced to ~10–30 s to avoid flooding).
 *
 * Strategy:
 *  1. Update the in-memory cache (zero DB write in the hot path).
 *  2. If the session was idle, mark it active again and flush immediately
 *     (because idle→active is a state change worth persisting quickly).
 *  3. Otherwise the cron job will flush the heartbeat on its own schedule.
 */
export const logActivity = asyncHandler(async (req, res, next) => {
  const { orgId, type, details } = req.body;
  const userId = req.user._id;

  await requireOrgMember(orgId, userId);

  // 1. Check in-memory cache first (fast path)
  let cached = await getByUserId(userId);

  if (!cached) {
    // Cache miss — the server may have restarted; reload from DB
    const session = await findRunningSession(userId, orgId);
    if (!session || session.status !== SESSION_STATUS.ACTIVE) {
      return next(httpError(404, "No active session to record activity for"));
    }
    await cacheSession(session);
    cached = await getSession(session._id);
  }

  const now = Date.now();
  const wasIdle = cached.isIdle;

  // 2. Update in-memory state
  await updateSession(cached.sessionId, {
    lastActivityAt: now,
    isIdle:         false,
    idleSince:      null,
    dirty:          wasIdle, // only mark dirty if we're transitioning from idle
  });

  // 3. If user was idle, do an immediate DB write to clear the idle flag
  if (wasIdle) {
    await workSessionModel.findByIdAndUpdate(cached.sessionId, {
      $set: {
        isIdle:          false,
        lastActivityAt:  new Date(now),
        lastHeartbeatAt: new Date(now),
      },
    });
  }

  return successResponse({
    res,
    message: "Activity recorded",
    data: {
      sessionId:      cached.sessionId,
      lastActivityAt: new Date(now),
      isIdle:         false,
    },
  });
});

/* ── GET /work-session/me ─────────────────────────────────── */
export const getMySessions = asyncHandler(async (req, res, next) => {
  const { orgId, status, taskId, from, to } = req.query;
  const userId = req.user._id;

  await requireOrgMember(orgId, userId);

  const { page, limit, skip } = getPagination(req.query);

  const filter = { userId, organizationId: orgId };

  if (status)  filter.status = status;
  if (taskId)  filter.taskId = taskId;

  if (from || to) {
    filter.startTime = {};
    if (from) filter.startTime.$gte = new Date(from);
    if (to)   filter.startTime.$lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    workSessionModel
      .find(filter)
      .select(
        "status taskId startTime endTime activeSeconds idleSeconds pausedSeconds " +
        "lastActivityAt isIdle note createdAt updatedAt"
      )
      .populate("taskId", "title status priority")
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    workSessionModel.countDocuments(filter),
  ]);

  // For any ACTIVE session, inject the live in-memory data
  const enriched = await Promise.all(items.map(async (s) => {
    if (s.status !== SESSION_STATUS.ACTIVE) return s;
    const cached = await getSession(s._id);
    if (!cached) return s;
    return {
      ...s,
      lastActivityAt: new Date(cached.lastActivityAt),
      isIdle:         cached.isIdle,
      // live wall-clock total
      liveSeconds: Math.floor((Date.now() - new Date(s.startTime)) / 1000),
    };
  }));

  return successResponse({
    res,
    data: { page, limit, total, items: enriched },
  });
});

/* ═══════════════════════════════════════════════════════════
   FORMATTER  (shapes the DB doc into the API response object)
═══════════════════════════════════════════════════════════ */
function formatSession(session) {
  const s = session.toObject ? session.toObject() : session;
  return {
    _id:            s._id,
    userId:         s.userId,
    organizationId: s.organizationId,
    taskId:         s.taskId   || null,
    status:         s.status,
    startTime:      s.startTime,
    endTime:        s.endTime  || null,
    activeSeconds:  s.activeSeconds,
    idleSeconds:    s.idleSeconds,
    pausedSeconds:  s.pausedSeconds,
    totalSeconds:
      s.status === SESSION_STATUS.STOPPED
        ? s.activeSeconds + s.idleSeconds + s.pausedSeconds
        : Math.floor((Date.now() - new Date(s.startTime)) / 1000),
    lastActivityAt: s.lastActivityAt,
    isIdle:         s.isIdle,
    pauseSegments:  s.pauseSegments,
    note:           s.note,
    createdAt:      s.createdAt,
    updatedAt:      s.updatedAt,
  };
}