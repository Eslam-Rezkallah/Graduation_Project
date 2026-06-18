/**
 * modules/work-session/workSession.validation.js
 */
import joi from "joi";
import { generalFields } from "../../middleware/validation.middleware.js";

/* ── POST /work-session/start ─────────────────────────────── */
export const startSession = joi
  .object({
    orgId:  generalFields.id.required(),
    taskId: generalFields.id,          // optional — can track without a task
    note:   joi.string().trim().max(1000).allow(""),
  })
  .required();

/* ── POST /work-session/pause ─────────────────────────────── */
export const pauseSession = joi
  .object({
    orgId: generalFields.id.required(),
    note:  joi.string().trim().max(1000).allow(""),
  })
  .required();

/* ── POST /work-session/resume ────────────────────────────── */
export const resumeSession = joi
  .object({
    orgId: generalFields.id.required(),
  })
  .required();

/* ── POST /work-session/stop ──────────────────────────────── */
export const stopSession = joi
  .object({
    orgId: generalFields.id.required(),
    note:  joi.string().trim().max(1000).allow(""),
  })
  .required();

/* ── POST /work-session/activity ──────────────────────────── */
export const logActivity = joi
  .object({
    orgId: generalFields.id.required(),
    /*
      type: what kind of activity was detected on the client.
      The frontend sends this; backend just stores it.
    */
    type: joi
      .string()
      .valid("keyboard", "mouse", "app_switch", "ping")
      .default("ping"),
    details: joi.string().trim().max(500).allow(""),
  })
  .required();

/* ── GET /work-session/me ─────────────────────────────────── */
export const getMySessions = joi
  .object({
    orgId:     generalFields.id.required(),
    status:    joi.string().valid("active", "paused", "stopped"),
    taskId:    generalFields.id,
    from:      joi.date().iso(),
    to:        joi.date().iso().min(joi.ref("from")),
    page:      joi.number().integer().min(1).default(1),
    limit:     joi.number().integer().min(1).max(100).default(20),
  })
  .required();