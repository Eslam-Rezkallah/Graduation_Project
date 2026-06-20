import { Router } from "express";
import { authentication } from "../../middleware/auth.middleware.js";
import { validation } from "../../middleware/validation.middleware.js";
import * as validators from "./organization.validation.js";
import * as orgService from "./service/organization.service.js"
import * as memberService from "./service/member.service.js";
import * as invitationService from "./service/invitation.service.js";
import spaceController from "../space/space.controller.js";
import activityController from "../activity/activity.controller.js";
import webhookController from "../webhook/webhook.controller.js";
import {
  uploadFileDisk,
  fileValidations,
} from "../../utils/multer/local.multer.js";

const router = Router();



// ─────────────────────────────────────────────────────────────
// ORG CRUD
// ─────────────────────────────────────────────────────────────

// GET /org/me  — all orgs the logged-in user belongs to.
// MUST be registered BEFORE "/:orgId" — otherwise Express matches "/me"
// as ":orgId", and orgIdParam validation rejects "me" (not a valid
// ObjectId) with a 400, which the FE mistakes for "user has no org" and
// bounces a real member to the onboarding screen.
router.get("/me", authentication(), orgService.getMyOrganizations);

// GET /org/:orgId  — get org details + member count + current user role
router.get(
  "/:orgId",
  authentication(),
  validation(validators.orgIdParam),
  orgService.getOrg
);


// POST /org  — create a new org
router.post(
  "/",
  authentication(),
  uploadFileDisk("organization/profile", fileValidations.image).single("logo"),
  validation(validators.createOrg),
  orgService.createOrg
);



// PATCH /org/:orgId  — update org info (owner/admin)
router.patch(
  "/:orgId",
  authentication(),
  uploadFileDisk("organization/profile", fileValidations.image).single("logo"),
  validation(validators.updateOrg),
  orgService.updateOrg
);

// DELETE /org/:orgId  — soft delete (owner only)
router.delete(
  "/:orgId",
  authentication(),
  validation(validators.orgIdParam),
  orgService.deleteOrg
);

// ─────────────────────────────────────────────────────────────
// MEMBERS
// ─────────────────────────────────────────────────────────────

// GET /org/:orgId/members  — list all members (any member can view)
router.get(
  "/:orgId/members",
  authentication(),
  validation(validators.listMembers),
  memberService.getOrgMembers
);

// PATCH /org/:orgId/members/:memberId/role  — promote/demote (owner only)
router.patch(
  "/:orgId/members/:memberId/role",
  authentication(),
  validation(validators.changeMemberRole),
  memberService.changeMemberRole
);

// DELETE /org/:orgId/members/:memberId  — remove member (owner/admin)
router.delete(
  "/:orgId/members/:memberId",
  authentication(),
  validation(validators.removeMemberParam),
  memberService.removeMember
);
router.delete(
  "/:orgId/leave",
  authentication(),
  memberService.leaveOrganization,
);
// ─────────────────────────────────────────────────────────────
// INVITATIONS — org-scoped
// ─────────────────────────────────────────────────────────────

// POST /org/:orgId/invitations  — send email invite (owner/admin)
router.post(
  "/:orgId/invitations",
  authentication(),
  validation(validators.createInvitation),
  invitationService.createInvitation
);

// ─────────────────────────────────────────────────────────────
// WORK SESSIONS — admin monitoring (Time Doctor / Jira worklog)
// ─────────────────────────────────────────────────────────────

// GET /org/:orgId/work-sessions  — all sessions for admin
router.get(
  "/:orgId/work-sessions",
  authentication(),
  validation(validators.orgWorkSessions),
  orgService.getOrgWorkSessions
);

// GET /org/:orgId/work-sessions/summary  — productivity per user
router.get(
  "/:orgId/work-sessions/summary",
  authentication(),
  validation(validators.orgWorkSessionsSummary),
  orgService.getWorkSessionsSummary
);

// ─────────────────────────────────────────────────────────────
// CHAT ROOMS — org scoped (Slack/Teams sidebar)
// ─────────────────────────────────────────────────────────────

// GET /org/:orgId/chat-rooms  — all chat rooms grouped by type
router.get(
  "/:orgId/chat-rooms",
  authentication(),
  validation(validators.orgIdParam),
  orgService.getOrgChatRooms
);

// ─────────────────────────────────────────────────────────────
// NESTED ROUTERS
// ─────────────────────────────────────────────────────────────

router.use("/:orgId/spaces", spaceController);
router.use("/:orgId/activity", activityController);
router.use("/:orgId/webhooks", webhookController);

export default router;
