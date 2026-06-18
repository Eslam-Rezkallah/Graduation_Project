// src/config/index.js
import { env } from "./env.js";

/**
 * Centralized config.
 * NEVER read process.env directly outside this file.
 */
export const config = Object.freeze({
  app: {
    name: env.APP_NAME,
    mood: env.MOOD,
    port: env.PORT,
    isProd: env.MOOD === "PROD",
    isDev: env.MOOD === "DEV",
    frontendUrl: env.FRONTEND_URL,
  },
  db: {
    uri: env.DB_URI,
  },
  security: {
    saltRounds: env.SALT,
    userAccessSecret: env.USER_ACCESS_TOKEN,
    userRefreshSecret: env.USER_REFRESH_TOKEN,
    adminAccessSecret: env.ADMIN_ACCESS_TOKEN,
    adminRefreshSecret: env.ADMIN_REFRESH_TOKEN,
    accessTokenExpiration: env.ACCESS_TOKEN_EXPIRATION,
    refreshTokenExpiration: env.REFRESH_TOKEN_EXPIRATION,
  },
  email: {
    user: env.EMAIL,
    password: env.EMAIL_PASSWORD,
  },
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  },
  oauth: {
    googleClientId: env.GOOGLE_CLIENT_ID,
  },
  ai: {
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    screenshotServiceUrl: env.AI_SCREENSHOT_SERVICE_URL || null,
    chatServiceUrl: env.AI_CHAT_SERVICE_URL || null,
    reportServiceUrl: env.AI_REPORT_SERVICE_URL || null,
    serviceTimeoutMs: env.AI_SERVICE_TIMEOUT_MS,
  },
  // Redis (Phase 2)
  redis: {
    url: env.REDIS_URL || null,
    // enabled iff a URL is configured AND REDIS_DISABLED is not true.
    // The disabled flag is the dev-friendly escape hatch when you
    // can't run Redis locally.
    enabled: Boolean(env.REDIS_URL) && env.REDIS_DISABLED !== true,
  },
  // LiveKit SFU for scalable voice/video.
  //   enabled === true iff all three required values are present.
  //   apiSecret is kept inside this frozen config object only —
  //   logger redact paths block it from ever reaching log lines.
  livekit: {
    url: env.LIVEKIT_URL || null,
    apiKey: env.LIVEKIT_API_KEY || null,
    apiSecret: env.LIVEKIT_API_SECRET || null,
    tokenTtl: env.LIVEKIT_TOKEN_TTL,
    webhookPath: env.LIVEKIT_WEBHOOK_PATH,
    enabled: Boolean(
      env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET,
    ),
  },
});
