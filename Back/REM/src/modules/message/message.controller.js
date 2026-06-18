import { Router } from "express";
import * as messageService from "./service/message.service.js";
import * as extras from "./service/message.extras.service.js";
import * as validators from "./message.validation.js";
import { authentication } from "../../middleware/auth.middleware.js";
import { validation } from "../../middleware/validation.middleware.js";
import {
  uploadCloudFile,
  fileValidations,
} from "../../utils/multer/cloud.multer.js";

const router = Router({ mergeParams: true });

router.use(authentication());

const uploadAny = uploadCloudFile([
  ...fileValidations.image,
  ...fileValidations.document,
  ...fileValidations.video,
  ...fileValidations.audio,
]);

// ── Send ──────────────────────────────────────────────────────
router.post(
  "/",
  uploadAny.array("attachments", 5),
  validation(validators.sendMessage),
  messageService.sendMessage,
);

// ── ✅ NEW: Forward a message to this room ────────────────────
// POST /chat/rooms/:roomId/messages/forward
router.post(
  "/forward",
  validation(validators.forwardMessage),
  messageService.forwardMessageHandler,
);

// ── Search messages in a room ─────────────────────────────────
// GET /chat/rooms/:roomId/messages/search?q=hello&page=1&limit=20
router.get(
  "/search",
  validation(validators.searchMessages),
  messageService.searchMessages,
);

router.post(
  "/ai/summarize",
  validation(validators.summarizeMessages),
  messageService.summarizeMessages,
);

// ── Pinned messages (static path — must come BEFORE /:messageId) ──
// GET /chat/rooms/:roomId/messages/pinned
router.get(
  "/pinned",
  validation(validators.listPinned),
  extras.listPinnedMessages,
);

// ── Scheduled messages (static paths — must come BEFORE /:messageId) ──
// POST /chat/rooms/:roomId/messages/schedule
router.post(
  "/schedule",
  validation(validators.scheduleMessage),
  extras.scheduleMessage,
);
// GET /chat/rooms/:roomId/messages/scheduled
router.get(
  "/scheduled",
  validation(validators.listScheduled),
  extras.listMyScheduledMessages,
);
// DELETE /chat/rooms/:roomId/messages/scheduled/:scheduledId
router.delete(
  "/scheduled/:scheduledId",
  validation(validators.cancelScheduled),
  extras.cancelScheduledMessage,
);

// ── List ──────────────────────────────────────────────────────
router.get(
  "/",
  validation(validators.listMessages),
  messageService.listMessages,
);

// ── Edit ──────────────────────────────────────────────────────
router.patch(
  "/:messageId",
  validation(validators.editMessage),
  messageService.editMessage,
);

// ── Delete ────────────────────────────────────────────────────
router.delete(
  "/:messageId",
  validation(validators.deleteMessage),
  messageService.deleteMessage,
);

// ── Receipts ──────────────────────────────────────────────────
router.patch(
  "/:messageId/seen",
  validation(validators.markSeen),
  messageService.markSeen,
);

router.patch(
  "/:messageId/delivered",
  validation(validators.messageParam),
  messageService.markDelivered,
);

// ── Pin / Unpin ─────────────────────────────────────────────
// POST   /chat/rooms/:roomId/messages/:messageId/pin
router.post(
  "/:messageId/pin",
  validation(validators.pinParams),
  extras.pinMessage,
);
// DELETE /chat/rooms/:roomId/messages/:messageId/pin
router.delete(
  "/:messageId/pin",
  validation(validators.pinParams),
  extras.unpinMessage,
);

// ── Save / Unsave (bookmarks) ───────────────────────────────
// POST   /chat/rooms/:roomId/messages/:messageId/save
router.post(
  "/:messageId/save",
  validation(validators.saveMessage),
  extras.saveMessage,
);
// DELETE /chat/rooms/:roomId/messages/:messageId/save
router.delete(
  "/:messageId/save",
  validation(validators.pinParams), // same shape: roomId + messageId
  extras.unsaveMessage,
);

// ── Thread (replies under a message) ────────────────────────
// GET /chat/rooms/:roomId/messages/:messageId/thread
router.get(
  "/:messageId/thread",
  validation(validators.listThread),
  extras.listThread,
);

export default router;
