import { Router } from "express";
import * as chatRoomService from "./service/chat.service.js";
import * as validators from "./chat.room.validation.js";
import { authentication } from "../../middleware/auth.middleware.js";
import { validation } from "../../middleware/validation.middleware.js";

// ✅ NEW: Import message service for unread counts
import * as messageService from "../message/service/message.service.js";

const router = Router();

router.use(authentication());

// ── ✅ NEW: Unread counts for all rooms ───────────────────────
// GET /chat/rooms/unread-counts (MUST be before /:roomId to avoid conflict)
router.get("/unread-counts", messageService.getUnreadCounts);

// ── Discover public channels to join ──────────────────────────
// GET /chat/rooms/browse (MUST be before /:roomId so "browse" isn't
// parsed as a roomId).
router.get(
  "/browse",
  validation(validators.browseChannels),
  chatRoomService.browseChannels,
);

// ── Create ────────────────────────────────────────────────────
router.post(
  "/direct",
  validation(validators.createDirect),
  chatRoomService.createDirect,
);

router.post(
  "/channel",
  validation(validators.createChannel),
  chatRoomService.createChannel,
);

router.post(
  "/team",
  validation(validators.createTeamChat),
  chatRoomService.createTeamChat,
);

router.post(
  "/organization",
  validation(validators.createOrganizationChat),
  chatRoomService.createOrganizationChat,
);

router.post(
  "/group",
  validation(validators.createGroup),
  chatRoomService.createGroup,
);

// ── Read ──────────────────────────────────────────────────────
router.get(
  "/",
  validation(validators.listChatRooms),
  chatRoomService.listChatRooms,
);

router.get(
  "/:roomId",
  validation(validators.roomParam),
  chatRoomService.getChatRoom,
);

// ── Update ────────────────────────────────────────────────────
router.patch(
  "/:roomId",
  validation(validators.updateRoom),
  chatRoomService.updateRoom,
);

// ── Membership ────────────────────────────────────────────────
router.post(
  "/:roomId/join",
  validation(validators.joinChannel),
  chatRoomService.joinChannel,
);

router.delete(
  "/:roomId/leave",
  validation(validators.leaveRoom),
  chatRoomService.leaveRoom,
);

router.post(
  "/:roomId/members/:memberId",
  validation(validators.manageMember),
  chatRoomService.addMember,
);

router.delete(
  "/:roomId/members/:memberId",
  validation(validators.manageMember),
  chatRoomService.removeMember,
);

// ── Delete ────────────────────────────────────────────────────
router.delete(
  "/:roomId",
  validation(validators.roomParam),
  chatRoomService.deleteRoom,
);

export default router;
