// src/modules/auth/service/organization.service.js
//
// Handles org JOIN by code only (no login required — authenticates via email+password).
// Org creation lives in: src/modules/organization/service/organization.service.js
import * as dbService from "../../../DB/db.service.js";
import organizationModel from "../../../DB/Model/organization.model.js";
import memberModel from "../../../DB/Model/member.model.js";
import userModel from "../../../DB/Model/user.model.js";
import { asyncHandler } from "../../../utils/response/error.response.js";
import { successResponse } from "../../../utils/response/success.response.js";
import { compareHash } from "../../../utils/security/hash.security.js";
import { syncOrgChatOnMemberChange } from "../../chatroom/service/chat.sync.service.js";
import { httpError } from "../../../utils/errors/index.js";

// ─────────────────────────────────────────────────────────────
// joinOrganization — business logic
// ─────────────────────────────────────────────────────────────

export const joinOrganization = async ({ email, password, joinCode }) => {
  const user = await dbService.findOne({
    model: userModel,
    filter: { email },
  });
  if (!user) {
    throw httpError(401, "Invalid email or password");
  }

  if (user.provider !== "System") {
    throw httpError(401, "This account uses social login. Please use your provider to sign in.");
  }

  const isPasswordValid = compareHash({
    plainText: password,
    hashValue: user.password,
  });
  if (!isPasswordValid) {
    throw httpError(401, "Invalid email or password");
  }

  if (!user.confirmEmail) {
    throw httpError(403, "Please verify your email first");
  }

  const organization = await dbService.findOne({
    model: organizationModel,
    filter: {
      joinCode: joinCode.toUpperCase(),
      isDeleted: false,
      isActive: true,
    },
  });
  if (!organization) {
    throw httpError(404, "Invalid organization code");
  }

  const existingMembership = await dbService.findOne({
    model: memberModel,
    filter: {
      organizationId: organization._id,
      userId: user._id,
    },
  });

  if (existingMembership) {
    if (existingMembership.isActive) {
      throw httpError(409, "You are already a member of this organization");
    }

    // reactivate deactivated membership
    existingMembership.isActive = true;
    existingMembership.joinedAt = Date.now();
    await existingMembership.save();

    return {
      organization,
      membership: existingMembership,
      message: "Membership reactivated successfully",
    };
  }

  const membership = await dbService.create({
    model: memberModel,
    data: {
      organizationId: organization._id,
      userId: user._id,
      role: "member",
      isActive: true,
    },
  });

  // Pull the new member into the org-wide chat if one exists.
  syncOrgChatOnMemberChange(organization._id, { addUserId: user._id });

  return { organization, membership };
};

// ─────────────────────────────────────────────────────────────
// POST /auth/org-join  — controller
// ─────────────────────────────────────────────────────────────

export const joinOrganizationController = asyncHandler(
  async (req, res, next) => {
    const { email, password, joinCode } = req.body;

    const result = await joinOrganization({ email, password, joinCode });

return successResponse(
  {
    res,
    message: result.message || "Successfully joined organization",
    data: result,
  },
  201,
);
  },
);
