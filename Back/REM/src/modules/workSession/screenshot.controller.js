import { Router } from "express";
import joi from "joi";
import screenshotModel from "../../DB/Model/screenshot.model.js";
import workSessionModel from "../../DB/Model/worksession.model.js";
import {
  authentication,
} from "../../middleware/auth.middleware.js";
import {
  isValidObjectId,
} from "../../middleware/validation.middleware.js";
import { validation } from "../../middleware/validation.middleware.js";
import { asyncHandler } from "../../utils/response/error.response.js";
import { successResponse } from "../../utils/response/success.response.js";
import { httpError } from "../../utils/errors/index.js";
import {
  requireOrgMember,
  requireOrgAdmin,
} from "../../utils/permissions/org.permissions.js";
import { callAiService } from "../../utils/ai/ai.client.js";

const router = Router();
router.use(authentication());

const id = joi.string().custom(isValidObjectId).required();

// POST /work-session/:sessionId/screenshots
// Body: { imageUrl, capturedAt }
// The desktop agent uploads to cloud storage first, then POSTs the URL
// here so the BE doesn't have to proxy binary uploads.
const uploadSchema = joi
  .object({
    sessionId: id,
    imageUrl: joi.string().uri().required(),
    capturedAt: joi.date().iso().required(),
  })
  .required();

router.post(
  "/:sessionId/screenshots",
  validation(uploadSchema),
  asyncHandler(async (req, res) => {
    const session = await workSessionModel.findById(req.params.sessionId);
    if (!session) throw httpError(404, "Work session not found");
    // Only the session owner can upload. This stops a leaked URL from
    // being used to seed other users' sessions.
    if (session.userId.toString() !== req.user._id.toString()) {
      throw httpError(
        403,
        "Only the session owner can upload screenshots for it",
      );
    }
    // The session must still be active or recently stopped — refuse
    // uploads on long-stopped sessions (sign of a misconfigured agent).
    const stoppedAgeMs = session.endTime
      ? Date.now() - session.endTime.getTime()
      : 0;
    const HOURS_24 = 24 * 60 * 60 * 1000;
    if (stoppedAgeMs > HOURS_24) {
      throw httpError(
        409,
        "Session was stopped more than 24h ago; uploads rejected",
      );
    }

    const shot = await screenshotModel.create({
      session: session._id,
      imageUrl: req.body.imageUrl,
      capturedAt: new Date(req.body.capturedAt),
    });
    return successResponse({ res, status: 201, data: shot });
  }),
);

// GET /work-session/:sessionId/screenshots?from=&to=&page=&limit=
// Self OR org admin can view. We compose two access paths so a manager
// can audit any session in their org without joining it first.
router.get(
  "/:sessionId/screenshots",
  asyncHandler(async (req, res) => {
    const session = await workSessionModel.findById(req.params.sessionId);
    if (!session) throw httpError(404, "Work session not found");

    const isSelf =
      session.userId.toString() === req.user._id.toString();
    if (!isSelf) {
      // Non-owner → must be org admin/owner of the session's org
      await requireOrgAdmin(session.organizationId, req.user._id);
    } else {
      await requireOrgMember(session.organizationId, req.user._id);
    }

    const { from, to, page = 1, limit = 50 } = req.query;
    const filter = { session: session._id };
    if (from || to) {
      filter.capturedAt = {};
      if (from) filter.capturedAt.$gte = new Date(from);
      if (to) filter.capturedAt.$lte = new Date(to);
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      screenshotModel
        .find(filter)
        .sort({ capturedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      screenshotModel.countDocuments(filter),
    ]);
    return successResponse({
      res,
      data: { items, total, page: Number(page), limit: Number(limit) },
    });
  }),
);

// DELETE /work-session/screenshots/:screenshotId  — self only
router.delete(
  "/screenshots/:screenshotId",
  asyncHandler(async (req, res) => {
    const shot = await screenshotModel.findById(req.params.screenshotId);
    if (!shot) throw httpError(404, "Screenshot not found");
    const session = await workSessionModel.findById(shot.session);
    if (!session) throw httpError(404, "Parent session not found");
    if (session.userId.toString() !== req.user._id.toString()) {
      throw httpError(403, "Only the session owner can delete their screenshot");
    }
    await shot.deleteOne();
    return successResponse({ res, message: "Screenshot deleted" });
  }),
);

router.post(
  "/screenshots/:screenshotId/analyze",
  asyncHandler(async (req, res) => {
    const shot = await screenshotModel.findById(req.params.screenshotId);
    if (!shot) throw httpError(404, "Screenshot not found");
    const session = await workSessionModel.findById(shot.session);
    if (!session) throw httpError(404, "Parent session not found");

    const isSelf = session.userId.toString() === req.user._id.toString();
    if (!isSelf) {
      await requireOrgAdmin(session.organizationId, req.user._id);
    } else {
      await requireOrgMember(session.organizationId, req.user._id);
    }

    const analysis = await callAiService(
      "screenshot",
      "POST",
      "/analyze-screenshot",
      {
        data: {
          image_url: shot.imageUrl,
          user_id: String(session.userId),
          captured_at: shot.capturedAt?.toISOString(),
        },
      },
    );

    return successResponse({
      res,
      data: {
        screenshotId: shot._id,
        analysis,
      },
    });
  }),
);

export default router;
