import joi from "joi";
import { isValidObjectId } from "../../middleware/validation.middleware.js";

const id = joi.string().custom(isValidObjectId).required();
const optionalId = joi.string().custom(isValidObjectId);

// POST /chat/rooms/:roomId/messages
export const sendMessage = joi
  .object({
    roomId: id.label("roomId"),
    content: joi.string().max(5000).allow("").default(""),
    messageType: joi
      .string()
      .valid("text", "image", "voice", "file", "system")
      .default("text"),
    replyTo: optionalId,
    file: joi.object().unknown(true),
  })
  .required();

// POST /chat/rooms/:roomId/messages/forward
export const forwardMessage = joi
  .object({
    roomId: id.label("roomId"),
    sourceMessageId: id.label("sourceMessageId"),
  })
  .required();

// GET /chat/rooms/:roomId/messages
export const listMessages = joi
  .object({
    roomId: id.label("roomId"),
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(100).default(30),
    before: joi.date().iso(),
  })
  .required();

// PATCH /chat/rooms/:roomId/messages/:messageId
export const editMessage = joi
  .object({
    roomId: id.label("roomId"),
    messageId: id.label("messageId"),
    content: joi.string().max(5000).min(1).required(),
  })
  .required();

// DELETE /chat/rooms/:roomId/messages/:messageId
export const deleteMessage = joi
  .object({
    roomId: id.label("roomId"),
    messageId: id.label("messageId"),
    deleteType: joi.string().valid("me", "everyone").default("me"),
  })
  .required();

// PATCH /chat/rooms/:roomId/messages/:messageId/seen
export const markSeen = joi
  .object({
    roomId: id.label("roomId"),
    messageId: id.label("messageId"),
  })
  .required();

// Message + Room param
export const messageParam = joi
  .object({
    roomId: id.label("roomId"),
    messageId: id.label("messageId"),
  })
  .required();

// GET /chat/rooms/:roomId/messages/search?q=
export const searchMessages = joi
  .object({
    roomId: id.label("roomId"),
    q: joi.string().trim().min(1).max(200).required(),
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(50).default(20),
  })
  .required();

export const summarizeMessages = joi
  .object({
    roomId: id.label("roomId"),
    window: joi.string().valid("day", "week"),
    limit: joi.number().integer().min(1).max(500).default(100),
    maxSummaryLength: joi.number().integer().min(20).max(400).default(150),
    minSummaryLength: joi.number().integer().min(5).max(200).default(30),
    includeVoiceAnalysis: joi.boolean().default(true),
    includeImageOcr: joi.boolean().default(true),
  })
  .required();

// ── Pin / Unpin / List pinned ────────────────────────────────
export const pinParams = joi
  .object({
    roomId: id.label("roomId"),
    messageId: id.label("messageId"),
  })
  .required();

export const listPinned = joi
  .object({ roomId: id.label("roomId") })
  .required();

// ── Save / Unsave ────────────────────────────────────────────
export const saveMessage = joi
  .object({
    roomId: id.label("roomId"),
    messageId: id.label("messageId"),
    note: joi.string().trim().max(500).allow("", null),
  })
  .required();

// ── Thread ───────────────────────────────────────────────────
export const listThread = joi
  .object({
    roomId: id.label("roomId"),
    messageId: id.label("messageId"),
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(100).default(30),
  })
  .required();

// ── Scheduled messages ───────────────────────────────────────
export const scheduleMessage = joi
  .object({
    roomId: id.label("roomId"),
    content: joi.string().trim().min(1).max(5000).required(),
    sendAt: joi.date().iso().greater("now").required(),
    replyTo: optionalId,
    messageType: joi
      .string()
      .valid("text", "image", "voice", "file", "system")
      .default("text"),
  })
  .required();

export const cancelScheduled = joi
  .object({
    roomId: id.label("roomId"),
    scheduledId: id.label("scheduledId"),
  })
  .required();

export const listScheduled = joi
  .object({ roomId: id.label("roomId") })
  .required();
