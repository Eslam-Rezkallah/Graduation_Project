/**
 * modules/webhook/webhook.controller.js
 *
 *   POST   /org/:orgId/webhooks               create (returns secret ONCE)
 *   GET    /org/:orgId/webhooks               list
 *   PATCH  /org/:orgId/webhooks/:id           update (name/url/events/isActive)
 *   DELETE /org/:orgId/webhooks/:id           remove
 *   POST   /org/:orgId/webhooks/:id/rotate    rotate the signing secret
 *   POST   /org/:orgId/webhooks/:id/test      queue a synthetic test delivery
 *   GET    /org/:orgId/webhooks/deliveries    delivery log (+ status counts)
 *
 * All endpoints require org owner/admin — webhooks expose org data
 * to external URLs, so plain members shouldn't be able to create them.
 */

import { Router } from "express";
import joi from "joi";
import { authentication } from "../../middleware/auth.middleware.js";
import { validation, generalFields } from "../../middleware/validation.middleware.js";
import { asyncHandler } from "../../utils/response/error.response.js";
import { successResponse } from "../../utils/response/success.response.js";
import { httpError } from "../../utils/errors/index.js";
import { requireOrgAdmin } from "../../utils/permissions/org.permissions.js";
import webhookSubscriptionModel from "../../DB/Model/webhookSubscription.model.js";
import webhookDeliveryModel, {
  deliveryStatus,
} from "../../DB/Model/webhookDelivery.model.js";
import { generateWebhookSecret } from "../../utils/webhooks/webhook.service.js";
import mongoose from "mongoose";

const { Types } = mongoose;

// mergeParams:true is REQUIRED — this router is mounted under
// "/org/:orgId/webhooks", so without it req.params.orgId is undefined
// inside every route and the orgId-required validation 400s with
// "Validation error" (which is exactly what broke the Webhooks page).
const router = Router({ mergeParams: true });
router.use(authentication());

// Whitelist of event names a subscription is allowed to opt into.
// Bump this when you add new event sources. Frontend reads it from
// /docs/openapi.json for the "choose events" UI.
const SUPPORTED_EVENTS = [
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.assigned",
  "task.deleted",
  "comment.added",
  "sprint.started",
  "sprint.closed",
  "org.member.join",
  "org.member.remove",
  "team.member.add",
  "team.member.remove",
  "chat.message.sent",
  "call.started",
  "call.ended",
];

const createSchema = joi
  .object({
    orgId: generalFields.id.required(),
    name: joi.string().trim().min(2).max(100).required(),
    targetUrl: joi.string().uri({ scheme: ["https"] }).required(),
    events: joi
      .array()
      .items(joi.string().valid(...SUPPORTED_EVENTS))
      .min(1)
      .required(),
  })
  .required();

const updateSchema = joi
  .object({
    orgId: generalFields.id.required(),
    id: generalFields.id.required(),
    name: joi.string().trim().min(2).max(100),
    targetUrl: joi.string().uri({ scheme: ["https"] }),
    events: joi.array().items(joi.string().valid(...SUPPORTED_EVENTS)).min(1),
    isActive: joi.boolean(),
  })
  .min(3)
  .required();

const idSchema = joi
  .object({
    orgId: generalFields.id.required(),
    id: generalFields.id.required(),
  })
  .required();

const listSchema = joi
  .object({ orgId: generalFields.id.required() })
  .required();

const deliveriesSchema = joi
  .object({
    orgId: generalFields.id.required(),
    status: joi.string().valid(...Object.values(deliveryStatus)),
    subscriptionId: generalFields.id,
    page: joi.number().integer().min(1).default(1),
    limit: joi.number().integer().min(1).max(100).default(20),
  })
  .required();

// POST /org/:orgId/webhooks
router.post(
  "/",
  validation(createSchema),
  asyncHandler(async (req, res) => {
    const { orgId } = req.params;
    await requireOrgAdmin(orgId, req.user._id);

    const secret = generateWebhookSecret();
    const sub = await webhookSubscriptionModel.create({
      organizationId: orgId,
      createdBy: req.user._id,
      name: req.body.name,
      targetUrl: req.body.targetUrl,
      events: [...new Set(req.body.events)],
      secret,
      isActive: true,
    });

    // Return the secret EXACTLY ONCE — it's `select: false` so future
    // reads won't expose it. If the user loses it, they must rotate.
    return successResponse(
      {
        res,
        message: "Webhook created. Store the secret now — it won't be shown again.",
        data: {
          subscription: {
            _id: sub._id,
            name: sub.name,
            targetUrl: sub.targetUrl,
            events: sub.events,
            isActive: sub.isActive,
            createdAt: sub.createdAt,
          },
          secret,
        },
      },
      201,
    );
  }),
);

// GET /org/:orgId/webhooks
router.get(
  "/",
  validation(listSchema),
  asyncHandler(async (req, res) => {
    const { orgId } = req.params;
    await requireOrgAdmin(orgId, req.user._id);

    const items = await webhookSubscriptionModel
      .find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .lean();

    return successResponse({ res, data: { count: items.length, items } });
  }),
);

// GET /org/:orgId/webhooks/deliveries  — delivery log for the org.
// Registered BEFORE the "/:id" routes so the static "/deliveries"
// segment can never be parsed as a webhook id.
router.get(
  "/deliveries",
  validation(deliveriesSchema),
  asyncHandler(async (req, res) => {
    const { orgId } = req.params;
    await requireOrgAdmin(orgId, req.user._id);

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = { organizationId: orgId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.subscriptionId)
      filter.subscriptionId = req.query.subscriptionId;

    // statusCounts drive the tab badges, so they ignore the active
    // status filter but still respect a chosen subscription. aggregate()
    // does NOT auto-cast strings to ObjectId, so cast explicitly.
    const countsMatch = { organizationId: new Types.ObjectId(orgId) };
    if (req.query.subscriptionId)
      countsMatch.subscriptionId = new Types.ObjectId(req.query.subscriptionId);

    const [items, total, countsAgg] = await Promise.all([
      webhookDeliveryModel
        .find(filter)
        .populate("subscriptionId", "name targetUrl isActive")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      webhookDeliveryModel.countDocuments(filter),
      webhookDeliveryModel.aggregate([
        { $match: countsMatch },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);

    const statusCounts = { pending: 0, delivered: 0, failed: 0, dead: 0 };
    for (const row of countsAgg) {
      if (row._id in statusCounts) statusCounts[row._id] = row.n;
    }

    return successResponse({
      res,
      data: {
        items,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
        statusCounts,
      },
    });
  }),
);

// PATCH /org/:orgId/webhooks/:id
router.patch(
  "/:id",
  validation(updateSchema),
  asyncHandler(async (req, res) => {
    const { orgId, id } = req.params;
    await requireOrgAdmin(orgId, req.user._id);

    const patch = {};
    for (const f of ["name", "targetUrl", "events", "isActive"]) {
      if (req.body[f] !== undefined) patch[f] = req.body[f];
    }
    if (patch.events) patch.events = [...new Set(patch.events)];
    // Re-enabling resets the failure counter so the worker doesn't
    // instantly disable it again.
    if (patch.isActive === true) {
      patch.consecutiveFailures = 0;
      patch.disabledReason = null;
    }

    const updated = await webhookSubscriptionModel.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { $set: patch },
      { new: true },
    );
    if (!updated) throw httpError(404, "Webhook not found");

    return successResponse({ res, message: "Webhook updated", data: updated });
  }),
);

// DELETE /org/:orgId/webhooks/:id
router.delete(
  "/:id",
  validation(idSchema),
  asyncHandler(async (req, res) => {
    const { orgId, id } = req.params;
    await requireOrgAdmin(orgId, req.user._id);

    const r = await webhookSubscriptionModel.deleteOne({
      _id: id,
      organizationId: orgId,
    });
    if (r.deletedCount === 0) throw httpError(404, "Webhook not found");
    return successResponse({ res, message: "Webhook removed" });
  }),
);

// POST /org/:orgId/webhooks/:id/rotate
router.post(
  "/:id/rotate",
  validation(idSchema),
  asyncHandler(async (req, res) => {
    const { orgId, id } = req.params;
    await requireOrgAdmin(orgId, req.user._id);

    const secret = generateWebhookSecret();
    const updated = await webhookSubscriptionModel.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { $set: { secret } },
      { new: true },
    );
    if (!updated) throw httpError(404, "Webhook not found");

    return successResponse({
      res,
      message: "Secret rotated. Old secret is no longer valid.",
      data: { _id: updated._id, secret },
    });
  }),
);

// POST /org/:orgId/webhooks/:id/test
// Queues a synthetic "webhook.test" delivery for THIS subscription
// (ignoring its event whitelist) so the user can confirm their endpoint
// is reachable. The normal delivery worker picks it up on its next tick,
// so the result shows up in the Deliveries tab with a real status code.
router.post(
  "/:id/test",
  validation(idSchema),
  asyncHandler(async (req, res) => {
    const { orgId, id } = req.params;
    await requireOrgAdmin(orgId, req.user._id);

    const sub = await webhookSubscriptionModel.findOne({
      _id: id,
      organizationId: orgId,
    });
    if (!sub) throw httpError(404, "Webhook not found");

    const delivery = await webhookDeliveryModel.create({
      subscriptionId: sub._id,
      organizationId: orgId,
      event: "webhook.test",
      payload: {
        event: "webhook.test",
        organizationId: String(orgId),
        timestamp: new Date().toISOString(),
        data: {
          message: "This is a test delivery from REM.",
          triggeredBy: String(req.user._id),
        },
      },
      status: deliveryStatus.Pending,
      nextAttemptAt: new Date(),
    });

    return successResponse({
      res,
      message: "Test event queued. Check the Deliveries tab for the result.",
      data: { deliveryId: delivery._id },
    });
  }),
);

export default router;
