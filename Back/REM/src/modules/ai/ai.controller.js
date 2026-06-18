import { Router } from "express";
import { asyncHandler } from "../../utils/response/error.response.js";
import { successResponse } from "../../utils/response/success.response.js";
import {
  callAiService,
  isAiServiceConfigured,
  listAiServices,
} from "../../utils/ai/ai.client.js";

const router = Router();

router.get(
  "/services",
  asyncHandler(async (req, res) => {
    return successResponse({ res, data: { services: listAiServices() } });
  }),
);

router.get(
  "/healthz",
  asyncHandler(async (req, res) => {
    const checks = await Promise.all(
      listAiServices().map(async (service) => {
        if (!service.configured) {
          return { ...service, status: "not_configured" };
        }
        try {
          const data = await callAiService(service.name, "GET", "/healthz");
          return { ...service, status: "ok", data };
        } catch (err) {
          return {
            ...service,
            status: "unavailable",
            error: err.message,
          };
        }
      }),
    );

    const hasConfigured = checks.some((check) => check.configured);
    const allConfiguredOk = checks
      .filter((check) => check.configured)
      .every((check) => check.status === "ok");

    return successResponse({
      res,
      status: hasConfigured && !allConfiguredOk ? 503 : 200,
      data: { services: checks },
    });
  }),
);

router.get("/configured", (req, res) => {
  return successResponse({
    res,
    data: {
      screenshot: isAiServiceConfigured("screenshot"),
      chat: isAiServiceConfigured("chat"),
      report: isAiServiceConfigured("report"),
    },
  });
});

export default router;
