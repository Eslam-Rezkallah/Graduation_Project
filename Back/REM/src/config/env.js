import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import joi from "joi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Support both MOOD (current) and NODE_ENV (standard)
const mood = process.env.MOOD || "DEV";
const envFile = mood === "PROD" ? ".env.prod" : ".env.dev";

// Jest sets NODE_ENV=test automatically. In that case the test suite
// has already seeded process.env (tests/integration/setup.js), and we
// must NOT let dotenv read .env.dev — it would silently re-introduce
// the developer's REDIS_URL / Cloudinary creds and break test isolation.
if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: path.resolve(__dirname, envFile) });
}

// ── Validation schema ──────────────────────────────────────
const envSchema = joi
  .object({
    MOOD: joi.string().valid("DEV", "PROD").default("DEV"),
    APP_NAME: joi.string().required(),
    PORT: joi.number().port().default(3000),

    // Database
    DB_URI: joi
      .string()
      .uri({ scheme: ["mongodb", "mongodb+srv"] })
      .required(),

    // Security
    SALT: joi.number().integer().min(10).max(14).required(),
    ACCESS_TOKEN_EXPIRATION: joi.string().default("15m"),
    REFRESH_TOKEN_EXPIRATION: joi.string().default("7d"),

    USER_ACCESS_TOKEN: joi.string().min(32).required(),
    USER_REFRESH_TOKEN: joi.string().min(32).required(),
    ADMIN_ACCESS_TOKEN: joi.string().min(32).required(),
    ADMIN_REFRESH_TOKEN: joi.string().min(32).required(), // 15 min in seconds

    // Email
    EMAIL: joi.string().email().required(),
    EMAIL_PASSWORD: joi.string().required(),
    // inside envSchema
    REDIS_URL: joi
      .string()
      .uri({ scheme: ["redis", "rediss"] })
      .optional(),
    // Hard-disable Redis even when REDIS_URL is set. Useful in dev
    // when you don't want to run the Docker container — silences
    // every reconnect log + falls back to in-memory stores.
    REDIS_DISABLED: joi.boolean().default(false),
    // Cloudinary
    CLOUDINARY_CLOUD_NAME: joi.string().required(),
    CLOUDINARY_API_KEY: joi.string().required(),
    CLOUDINARY_API_SECRET: joi.string().required(),

    // OAuth
    GOOGLE_CLIENT_ID: joi.string().required(),

    // AI (optional)
    OPENAI_API_KEY: joi.string().allow("").optional(),
    OPENAI_MODEL: joi.string().default("gpt-4o-mini"),
    AI_SCREENSHOT_SERVICE_URL: joi
      .string()
      .uri({ scheme: ["http", "https"] })
      .allow("")
      .optional(),
    AI_CHAT_SERVICE_URL: joi
      .string()
      .uri({ scheme: ["http", "https"] })
      .allow("")
      .optional(),
    AI_REPORT_SERVICE_URL: joi
      .string()
      .uri({ scheme: ["http", "https"] })
      .allow("")
      .optional(),
    AI_SERVICE_TIMEOUT_MS: joi.number().integer().min(1000).default(30000),

    // LiveKit (Voice/Video SFU) — optional; if any of the three
    // is missing the call module will refuse to mint tokens and
    // log a clear error rather than serving broken calls.
    LIVEKIT_URL: joi
      .string()
      .uri({ scheme: ["ws", "wss", "http", "https"] })
      .allow("")
      .optional(),
    LIVEKIT_API_KEY: joi.string().allow("").optional(),
    LIVEKIT_API_SECRET: joi.string().allow("").optional(),
    LIVEKIT_TOKEN_TTL: joi.string().default("4h"),
    LIVEKIT_WEBHOOK_PATH: joi
      .string()
      .pattern(/^\/[\w\-/]+$/)
      .default("/calls/livekit/webhook"),

    // Frontend
    FRONTEND_URL: joi.string().uri().default("http://localhost:3000"),
  })
  .unknown(true);

const { error, value } = envSchema.validate(process.env, { abortEarly: false });

if (error) {
  console.error("❌ Invalid environment configuration:");
  error.details.forEach((d) => console.error(`  - ${d.message}`));
  process.exit(1);
}

export const env = value;
