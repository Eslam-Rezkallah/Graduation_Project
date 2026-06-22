import { Router } from "express";
import { asyncHandler } from "../../utils/response/error.response.js";
import { successResponse } from "../../utils/response/success.response.js";
import { authentication } from "../../middleware/auth.middleware.js";
import {
  callAiService,
  isAiServiceConfigured,
  listAiServices,
} from "../../utils/ai/ai.client.js";
import {
  getVoiceSpeechDashboard,
  getVoiceAnalysisForMessage,
} from "../../utils/ai/voice-analysis.service.js";

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

// ── Report intelligence (employee ↔ task from uploaded report files) ──
router.get(
  "/reports/employees",
  authentication(),
  asyncHandler(async (req, res) => {
    const data = await callAiService("report", "GET", "/employees");
    return successResponse({ res, data });
  }),
);

router.get(
  "/reports/tasks",
  authentication(),
  asyncHandler(async (req, res) => {
    const data = await callAiService("report", "GET", "/tasks", {
      params: req.query,
    });
    return successResponse({ res, data });
  }),
);

router.post(
  "/reports/rescan",
  authentication(),
  asyncHandler(async (req, res) => {
    const data = await callAiService("report", "POST", "/rescan");
    return successResponse({ res, message: "Report scan complete", data });
  }),
);

// ── Voice emotion + acoustic analysis (Whisper + librosa) ──
router.post(
  "/voice/analyze",
  authentication(),
  asyncHandler(async (req, res) => {
    const data = await callAiService("chat", "POST", "/analyze-voice", {
      data: req.body,
      timeoutMs: 180_000,
    });
    return successResponse({ res, data });
  }),
);

// Auto dashboard: recent org voice messages + cached analysis
router.get(
  "/voice/dashboard",
  authentication(),
  asyncHandler(async (req, res) => {
    const { orgId } = req.query;
    if (!orgId) {
      return res.status(400).json({ success: false, message: "orgId is required" });
    }
    const data = await getVoiceSpeechDashboard(orgId, req.user._id);
    return successResponse({ res, data });
  }),
);

router.get(
  "/voice/messages/:messageId",
  authentication(),
  asyncHandler(async (req, res) => {
    const { orgId } = req.query;
    if (!orgId) {
      return res.status(400).json({ success: false, message: "orgId is required" });
    }
    const data = await getVoiceAnalysisForMessage(
      req.params.messageId,
      req.user._id,
      orgId,
    );
    if (!data) {
      return res.status(404).json({ success: false, message: "Voice message not found" });
    }
    return successResponse({ res, data });
  }),
);

export default router;
