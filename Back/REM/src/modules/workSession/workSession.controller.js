/**
 * modules/work-session/workSession.controller.js
 *
 * Route definitions for the Work Session module.
 * Mounted at:  /api/work-session
 */

import { Router } from "express";
import { authentication } from "../../middleware/auth.middleware.js";
import { validation }     from "../../middleware/validation.middleware.js";
import * as validators    from "./workSession.validation.js";
import * as sessionService from "./service/workSession.service.js";

const router = Router({ mergeParams: true });

/**
 * POST /api/work-session/start
 * Body: { orgId, taskId?, note? }
 */
router.post(
  "/start",
  authentication(),
  validation(validators.startSession),
  sessionService.startSession
);

/**
 * POST /api/work-session/pause
 * Body: { orgId, note? }
 */
router.post(
  "/pause",
  authentication(),
  validation(validators.pauseSession),
  sessionService.pauseSession
);

/**
 * POST /api/work-session/resume
 * Body: { orgId }
 */
router.post(
  "/resume",
  authentication(),
  validation(validators.resumeSession),
  sessionService.resumeSession
);

/**
 * POST /api/work-session/stop
 * Body: { orgId, note? }
 */
router.post(
  "/stop",
  authentication(),
  validation(validators.stopSession),
  sessionService.stopSession
);

/**
 * POST /api/work-session/activity
 * Body: { orgId, type?, details? }
 * Hot path — in-memory update, no DB write unless idle recovery.
 */
router.post(
  "/activity",
  authentication(),
  validation(validators.logActivity),
  sessionService.logActivity
);

/**
 * GET /api/work-session/me
 * Query: { orgId, status?, taskId?, from?, to?, page?, limit? }
 */
router.get(
  "/me",
  authentication(),
  validation(validators.getMySessions),
  sessionService.getMySessions
);

export default router;