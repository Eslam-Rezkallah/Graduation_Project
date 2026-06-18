import axios from "axios";
import { config } from "../../config/index.js";
import { httpError } from "../errors/index.js";

const SERVICE_URLS = Object.freeze({
  screenshot: config.ai.screenshotServiceUrl,
  chat: config.ai.chatServiceUrl,
  report: config.ai.reportServiceUrl,
});

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function isAiServiceConfigured(service) {
  return Boolean(SERVICE_URLS[service]);
}

export function listAiServices() {
  return Object.entries(SERVICE_URLS).map(([name, url]) => ({
    name,
    configured: Boolean(url),
    url,
  }));
}

export async function callAiService(service, method, path, { data, params } = {}) {
  const baseUrl = SERVICE_URLS[service];
  if (!baseUrl) {
    throw httpError(503, `AI ${service} service is not configured`);
  }

  try {
    const response = await axios.request({
      method,
      url: `${trimTrailingSlash(baseUrl)}${path}`,
      data,
      params,
      timeout: config.ai.serviceTimeoutMs,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail || err.response?.data?.message;
    if (status && status >= 400 && status < 500) {
      throw httpError(status, detail || `AI ${service} service rejected request`);
    }
    throw httpError(
      503,
      `AI ${service} service is unavailable`,
      detail || err.message || null,
    );
  }
}
