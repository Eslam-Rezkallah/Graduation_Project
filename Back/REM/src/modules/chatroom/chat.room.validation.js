import joi from "joi";
import {
  isValidObjectId,
  generalFields,
} from "../../middleware/validation.middleware.js";

// ── Reusable id field ──────────────────────────────────────────
const id = joi.string().custom(isValidObjectId).required();
const optionalId = joi.string().custom(isValidObjectId);

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/direct
// ─────────────────────────────────────────────────────────────
export const createDirect = joi
  .object({
    targetUserId: id.label("targetUserId"),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/channel
// ✅ NEW: optional memberIds — allows admin/owner to pre-select
//        members when creating the channel (works for both
//        public and private channels).
// ─────────────────────────────────────────────────────────────
export const createChannel = joi
  .object({
    name: joi.string().min(2).max(100).required(),
    description: joi.string().max(500),
    organizationId: optionalId,
    teamId: optionalId,
    projectId: optionalId,
    isPrivate: joi.boolean().default(false),
    memberIds: joi
      .array()
      .items(joi.string().custom(isValidObjectId))
      .unique()
      .optional(),
  })
  .or("organizationId", "teamId", "projectId") // at least one scope required
  .required();

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/team
// ─────────────────────────────────────────────────────────────
export const createTeamChat = joi
  .object({
    teamId: id.label("teamId"),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/organization
// ─────────────────────────────────────────────────────────────
export const createOrganizationChat = joi
  .object({
    organizationId: id.label("organizationId"),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/group
// ─────────────────────────────────────────────────────────────
export const createGroup = joi
  .object({
    name: joi.string().min(2).max(100).required(),
    description: joi.string().max(500),
    organizationId: id.label("organizationId"),
    memberIds: joi
      .array()
      .items(joi.string().custom(isValidObjectId))
      .min(1)
      .required(),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// GET /chat/rooms
// ─────────────────────────────────────────────────────────────
export const listChatRooms = joi
  .object({
    organizationId: optionalId,
    type: joi
      .string()
      .valid("direct", "team", "organization", "channel", "group"),
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(50).default(20),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// GET /chat/rooms/browse — discover joinable public channels
// ─────────────────────────────────────────────────────────────
export const browseChannels = joi
  .object({
    organizationId: id.label("organizationId"),
    search: joi.string().trim().max(100).allow(""),
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(50).default(30),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// GET /chat/rooms/:roomId
// ─────────────────────────────────────────────────────────────
export const roomParam = joi
  .object({
    roomId: id.label("roomId"),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/:roomId/join
// ─────────────────────────────────────────────────────────────
export const joinChannel = joi
  .object({
    roomId: id.label("roomId"),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// DELETE /chat/rooms/:roomId/leave
// ─────────────────────────────────────────────────────────────
export const leaveRoom = joi
  .object({
    roomId: id.label("roomId"),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// POST /chat/rooms/:roomId/members/:memberId
// DELETE /chat/rooms/:roomId/members/:memberId
// ─────────────────────────────────────────────────────────────
export const manageMember = joi
  .object({
    roomId: id.label("roomId"),
    memberId: id.label("memberId"),
  })
  .required();

// ─────────────────────────────────────────────────────────────
// PATCH /chat/rooms/:roomId
// ─────────────────────────────────────────────────────────────
export const updateRoom = joi
  .object({
    roomId: id.label("roomId"),
    name: joi.string().min(2).max(100),
    description: joi.string().max(500).allow(""),
    isPrivate: joi.boolean(),
    icon: joi.string().uri().allow("", null),
    // Slack-style branding. Every field is optional and clearable.
    // `color` is validated as a strict #RRGGBB so the FE can drop it
    // into style attrs without re-validating.
    branding: joi
      .object({
        color: joi
          .string()
          .pattern(/^#[0-9a-fA-F]{6}$/)
          .allow("", null),
        coverImage: joi.string().uri().allow("", null),
        tagline: joi.string().max(140).allow("", null),
        topic: joi.string().max(250).allow("", null),
      })
      .unknown(false),
  })
  .required();
