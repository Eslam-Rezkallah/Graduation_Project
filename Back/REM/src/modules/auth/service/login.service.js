// FIX: removed "import axios from 'axios'" — was unused dead code
import { OAuth2Client } from "google-auth-library";
import userModel, {
  providerTypes,
  roleTypes,
} from "../../../DB/Model/user.model.js";
import { emailEvent } from "../../../utils/events/email.event.js";
import { asyncHandler } from "../../../utils/response/error.response.js";
import { successResponse } from "../../../utils/response/success.response.js";
import {
  compareHash,
  generateHash,
} from "../../../utils/security/hash.security.js";
import { generateToken } from "../../../utils/security/token.security.js";
import { getGeoLocation } from "../../../utils/security/geo-location.service.js";
// ─────────────────────────────────────────────────────────────
// SHARED HELPERS  (used by all login flows below)
// ─────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../../../utils/security/token.security.js";
import refreshTokenModel from "../../../DB/Model/refreshToken.model.js";
import ms from "ms"; // npm install ms
import { config } from "../../../config/index.js";
import { recordAudit } from "../../../utils/audit/audit.logger.js";
import { auditActions } from "../../../utils/audit/audit.actions.js";
import { httpError } from "../../../utils/errors/index.js";
import { detectGeoRisk } from "../../../utils/security/geo-risk.service.js";

// ─── Brute-force lockout constants ──────────────────────────
// Security hardening: 5 failed attempts within a 5-minute rolling
// window → 5-minute temporary lockout. Tunable via env if needed.
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS || 5 * 60 * 1000);
const LOGIN_ATTEMPT_WINDOW_MS = Number(
  process.env.LOGIN_ATTEMPT_WINDOW_MS || 5 * 60 * 1000,
);
// Exact message surfaced to clients when an account is locked.
const LOGIN_LOCKED_MESSAGE =
  "Account temporarily locked. Try again in 5 minutes.";

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const issueTokens = async (user, req) => {
  const accessToken = generateAccessToken({
    payload: { id: user._id },
    role: user.role,
  });

  const refreshToken = generateRefreshToken({
    payload: { id: user._id },
    role: user.role,
  });

  // Store refresh token hash (so we can revoke it)
  const expiresAt = new Date(
    Date.now() + ms(config.security.refreshTokenExpiration),
  );
  await refreshTokenModel.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt,
    userAgent: req?.headers?.["user-agent"] || null,
    ipAddress: req?.ip || null,
  });

  return { accessToken, refreshToken };
};
const buildUserPayload = (user) => ({
  _id: user._id,
  username: user.username,
  email: user.email,
  image: user.image,
  role: user.role,
});

// ─────────────────────────────────────────────────────────────
// OTP / BAN HELPER
// ─────────────────────────────────────────────────────────────

const checkBanAndOTPStatus = async (user, otpType) => {
  const fieldMap = {
    twoStepVerification: {
      otpField: "twoStepVerificationOTP",
      banUntilField: "twoStepVerificationOTPBanUntil",
      failedAttemptsField: "twoStepVerificationOTPFailedAttempts",
      expiresField: "twoStepVerificationOTPExpires",
    },
    resetPassword: {
      otpField: "resetPasswordOTP",
      banUntilField: "resetPasswordOTPBanUntil",
      failedAttemptsField: "resetPasswordOTPFailedAttempts",
      expiresField: "resetPasswordOTPExpires",
    },
    confirmEmail: {
      otpField: "confirmEmailOTP",
      banUntilField: "confirmEmailOTPBanUntil",
      failedAttemptsField: "confirmEmailOTPFailedAttempts",
      expiresField: "confirmEmailOTPExpires",
    },
  };

  const fields = fieldMap[otpType];
  if (!fields) throw new Error("Invalid OTP type");

  const { otpField, banUntilField, failedAttemptsField, expiresField } = fields;

  if (user[banUntilField] && user[banUntilField] > Date.now()) {
    throw httpError(429, "Your request has been banned. Try again later");
  }

  if (user[banUntilField] && user[banUntilField] < Date.now()) {
    user[banUntilField] = null;
    user[failedAttemptsField] = 0;
    await user.save();
  }

  if (user[failedAttemptsField] >= 5) {
    user[banUntilField] = Date.now() + 300000;
    await user.save();
    throw httpError(
      429,
      "Too many failed attempts. You are banned for 5 minutes.",
    );
  }

  if (user[otpField] && user[expiresField] < Date.now()) {
    const eventName =
      otpType === "twoStepVerification"
        ? "twoStepVerification"
        : otpType === "resetPassword"
          ? "ForgetPassword"
          : "sendConfirmationEmail";
    emailEvent.emit(eventName, { id: user._id, email: user.email });
    throw httpError(401, "OTP expired. A new OTP has been sent to your email.");
  }
};

// ═══════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════

export const login = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return next(httpError(400, "Email and password are required"));
  }

  const user = await userModel.findOne({
    email,
    provider: providerTypes.System,
  });

  if (!user) {
    // Audit the failure but don't leak which path failed (user vs
    // password) to the response — return generic 401.
    await recordAudit({
      req,
      action: auditActions.AUTH_LOGIN_FAILURE,
      outcome: "failure",
      meta: { email, reason: "user_not_found" },
    });

    const existingUser = await userModel.findOne({ email });
    if (existingUser && existingUser.provider === providerTypes.Google) {
      return next(
        httpError(
          401,
          "Account registered with another provider (e.g., Google).",
        ),
      );
    }
    return next(httpError(401, "Invalid credentials"));
  }

  if (!user.confirmEmail) {
    return next(httpError(401, "Email not confirmed"));
  }

  // ── Brute-force lockout check (BEFORE bcrypt compare) ──────
  // The check goes first so we don't waste CPU on bcrypt for a
  // locked-out account, and so the response time doesn't leak
  // "did the password match" info during the lockout window.
  if (user.loginLockedUntil && user.loginLockedUntil.getTime() > Date.now()) {
    const retryAfterSec = Math.ceil(
      (user.loginLockedUntil.getTime() - Date.now()) / 1000,
    );
    res.setHeader("Retry-After", retryAfterSec);
    return next(httpError(429, LOGIN_LOCKED_MESSAGE));
  }

  if (!compareHash({ plainText: password, hashValue: user.password })) {
    // Track the failure inside a rolling 5-minute window. If the
    // previous window has lapsed (or never started), restart the
    // counter; otherwise increment within the active window. Once we
    // cross the threshold, lock the account for 5 minutes and audit it
    // as a distinct event so dashboards can distinguish "many bad
    // attempts" from a one-off typo.
    const now = Date.now();
    const windowStart = user.loginFailedWindowStart?.getTime() || 0;
    const windowActive =
      windowStart && now - windowStart < LOGIN_ATTEMPT_WINDOW_MS;

    const nextCount = windowActive ? (user.loginFailedAttempts || 0) + 1 : 1;
    const update = {
      loginFailedAttempts: nextCount,
      loginFailedWindowStart: windowActive
        ? user.loginFailedWindowStart
        : new Date(now),
    };
    let locked = false;

    if (nextCount >= LOGIN_MAX_ATTEMPTS) {
      update.loginLockedUntil = new Date(now + LOGIN_LOCKOUT_MS);
      locked = true;
    }
    await userModel.updateOne({ _id: user._id }, { $set: update });

    await recordAudit({
      req,
      actorId: user._id,
      action: auditActions.AUTH_LOGIN_FAILURE,
      outcome: "failure",
      meta: {
        email,
        reason: "bad_password",
        attempts: nextCount,
        locked,
      },
    });

    if (locked) {
      return next(httpError(429, LOGIN_LOCKED_MESSAGE));
    }
    return next(httpError(401, "Invalid credentials"));
  }

  if (user.twoStepVerification) {
    emailEvent.emit("twoStepVerification", { id: user._id, email });
    return successResponse({ res, data: { requiresOTP: true } });
  }

  // ── Successful password match ──────────────────────────────
  // Reset the brute-force counter so a clean login clears any
  // previous failures.
  if (user.loginFailedAttempts > 0 || user.loginLockedUntil) {
    await userModel.updateOne(
      { _id: user._id },
      {
        $set: {
          loginFailedAttempts: 0,
          loginLockedUntil: null,
          loginFailedWindowStart: null,
        },
      },
    );
  }

  const tokens = await issueTokens(user, req);
  const forwardedIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim();

  const clientIp = forwardedIp || req.ip || req.connection?.remoteAddress;

  const geo = await getGeoLocation(clientIp);
  const risk = await detectGeoRisk({
    userId: user._id,
    country: geo?.country,
    city: geo?.city,
  });
  await recordAudit({
    req,
    actorId: user._id,
    action: auditActions.AUTH_LOGIN_SUCCESS,
    outcome: "success",
    meta: {
      email,
      provider: "system",
      ip: clientIp,
      country: geo?.country || "Unknown",
      city: geo?.city || "Unknown",
      proxy: geo?.proxy || false,
      risk: risk.risk,
      reason: risk.reason,
    },
  });

  return successResponse({
    res,
    data: {
      ...tokens,
      user: buildUserPayload(user),
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// LOGIN WITH GOOGLE
// ═══════════════════════════════════════════════════════════════

export const loginWithGoogle = asyncHandler(async (req, res, next) => {
  const { idToken } = req.body;
  if (!idToken) {
    return next(httpError(400, "ID token is required"));
  }

  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  if (!payload.email_verified) {
    return next(httpError(401, "Google email not verified"));
  }

  const user = await userModel.findOne({ email: payload.email });

  if (!user) {
    return next(
      httpError(404, "User not found. Please sign up with Google first."),
    );
  }

  if (user.provider !== providerTypes.Google) {
    return next(
      httpError(409, "This email is registered with another provider."),
    );
  }
  const tokens = await issueTokens(user, req);
  const forwardedIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim();

  const clientIp = forwardedIp || req.ip || req.connection?.remoteAddress;

  const geo = await getGeoLocation(clientIp);
  const risk = await detectGeoRisk({
    userId: user._id,
    country: geo?.country,
    city: geo?.city,
  });
  await recordAudit({
    req,
    actorId: user._id,
    action: auditActions.AUTH_LOGIN_SUCCESS,
    outcome: "success",
    meta: {
      email: user.email,
      provider: "google",
      ip: clientIp,
      country: geo?.country || "Unknown",
      city: geo?.city || "Unknown",
      proxy: geo?.proxy || false,
      risk: risk.risk,
      reason: risk.reason,
    },
  });
  return successResponse({
    res,
    data: {
      ...tokens,
      user: buildUserPayload(user),
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// VALIDATE LOGIN OTP (2FA)
// ═══════════════════════════════════════════════════════════════

export const validateLoginOTP = asyncHandler(async (req, res, next) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return next(httpError(400, "Email and OTP code are required"));
  }

  const user = await userModel.findOne({ email, isDeleted: false });
  if (!user) return next(httpError(404, "User not found"));

  if (!user.twoStepVerification) {
    return next(httpError(400, "Two-step verification is not enabled"));
  }

  try {
    await checkBanAndOTPStatus(user, "twoStepVerification");
  } catch (error) {
    return next(error);
  }

  if (
    !user.twoStepVerificationOTP ||
    !compareHash({
      plainText: code,
      hashValue: user.twoStepVerificationOTP,
    })
  ) {
    user.twoStepVerificationOTPFailedAttempts++;
    await user.save();

    if (user.twoStepVerificationOTPFailedAttempts >= 5) {
      user.twoStepVerificationOTPBanUntil = Date.now() + 300000;
      await user.save();
      return next(
        httpError(
          429,
          "Too many failed attempts. You are banned for 5 minutes.",
        ),
      );
    }
    return next(httpError(401, "Invalid OTP"));
  }

  if (user.twoStepVerificationOTPExpires < Date.now()) {
    return next(httpError(401, "OTP expired"));
  }

  await userModel.updateOne(
    { _id: user._id },
    {
      twoStepVerificationOTP: null,
      twoStepVerificationOTPExpires: null,
      twoStepVerificationOTPFailedAttempts: 0,
      twoStepVerificationOTPBanUntil: null,
    },
  );
  const tokens = await issueTokens(user, req);
  return successResponse({
    res,
    data: {
      ...tokens,
      user: buildUserPayload(user),
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// VERIFY ENABLE TWO-STEP VERIFICATION
// ═══════════════════════════════════════════════════════════════

export const verifyEnableTwoStepVerification = asyncHandler(
  async (req, res, next) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return next(httpError(400, "Email and code are required"));
    }

    const user = await userModel.findOne({ email, isDeleted: false });
    if (!user) return next(httpError(404, "User not found"));

    if (user.twoStepVerificationOTPValidated) {
      return next(httpError(409, "Two step verification already enabled"));
    }

    await checkBanAndOTPStatus(user, "twoStepVerification");

    if (
      !user.twoStepVerificationOTP ||
      !compareHash({
        plainText: code,
        hashValue: user.twoStepVerificationOTP,
      })
    ) {
      user.twoStepVerificationOTPFailedAttempts++;
      await user.save();

      if (user.twoStepVerificationOTPFailedAttempts < 5) {
        emailEvent.emit("twoStepVerification", {
          id: user._id,
          email: user.email,
        });
        return next(
          httpError(
            401,
            "Incorrect OTP. A new OTP has been sent to your email.",
          ),
        );
      }
      return next(httpError(429, "Incorrect OTP. Too many failed attempts."));
    }

    if (user.twoStepVerificationOTPExpires < Date.now()) {
      return next(httpError(401, "OTP expired"));
    }

    await userModel.updateOne(
      { email },
      {
        twoStepVerification: true,
        twoStepVerificationOTPValidated: true,
        twoStepVerificationOTP: null,
        twoStepVerificationOTPExpires: null,
        twoStepVerificationOTPFailedAttempts: 0,
        twoStepVerificationOTPBanUntil: null,
      },
    );

    return successResponse({
      res,
      message: "Two step verification enabled successfully",
    });
  },
);

// ═══════════════════════════════════════════════════════════════
// FORGET PASSWORD
// ═══════════════════════════════════════════════════════════════

export const forgetPassword = asyncHandler(async (req, res, next) => {
  const { email } = req.body;
  if (!email) {
    return next(httpError(400, "Email is required"));
  }

  const user = await userModel.findOne({ email, isDeleted: false });
  if (!user) return next(httpError(404, "User not found"));

  if (!user.confirmEmail) {
    return next(
      httpError(404, "Email not confirmed. Please verify your account"),
    );
  }

  await checkBanAndOTPStatus(user, "resetPassword");

  if (user.resetPasswordOTP && user.resetPasswordOTPExpires > Date.now()) {
    return next(httpError(429, "An OTP has already been sent to your email."));
  }

  emailEvent.emit("ForgetPassword", { id: user._id, email });

  return successResponse({
    res,
    message: "Reset password OTP sent successfully",
  });
});

// ═══════════════════════════════════════════════════════════════
// VALIDATE FORGET PASSWORD OTP
// ═══════════════════════════════════════════════════════════════

export const validateForgetPassword = asyncHandler(async (req, res, next) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return next(httpError(400, "Email and OTP code are required"));
  }

  const user = await userModel.findOne({ email, isDeleted: false });
  if (!user) return next(httpError(404, "User not found"));

  if (!user.confirmEmail) {
    return next(
      httpError(404, "Email not confirmed. Please verify your account"),
    );
  }

  await checkBanAndOTPStatus(user, "resetPassword");

  if (
    !user.resetPasswordOTP ||
    !compareHash({ plainText: code, hashValue: user.resetPasswordOTP })
  ) {
    user.resetPasswordOTPFailedAttempts++;
    await user.save();

    if (user.resetPasswordOTPFailedAttempts < 5) {
      emailEvent.emit("ForgetPassword", { id: user._id, email: user.email });
      return next(
        httpError(401, "Incorrect OTP. A new OTP has been sent to your email."),
      );
    }
    return next(httpError(429, "Incorrect OTP. Too many failed attempts."));
  }

  await userModel.updateOne({ email }, { resetPasswordOTPValidated: true });

  return successResponse({ res, message: "OTP validated successfully" });
});

// ═══════════════════════════════════════════════════════════════
// RESET PASSWORD
// ═══════════════════════════════════════════════════════════════

export const resetPassword = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return next(httpError(400, "Email and password are required"));
  }

  const user = await userModel.findOne({ email, isDeleted: false });
  if (!user) return next(httpError(404, "User not found"));

  if (!user.confirmEmail) {
    return next(
      httpError(404, "Email not confirmed. Please verify your account"),
    );
  }

  await checkBanAndOTPStatus(user, "resetPassword");

  if (!user.resetPasswordOTPValidated) {
    return next(
      httpError(401, "OTP not validated. Please validate the OTP first."),
    );
  }

  await userModel.updateOne(
    { email },
    {
      password: generateHash({ plainText: password }),
      changeCredentialsTime: Date.now(),
      // Reset brute-force counters too — successful credential change
      // restores access.
      loginFailedAttempts: 0,
      loginLockedUntil: null,
      $unset: {
        resetPasswordOTP: 1,
        resetPasswordOTPExpires: 1,
        resetPasswordOTPFailedAttempts: 1,
        resetPasswordOTPBanUntil: 1,
        resetPasswordOTPValidated: 1,
      },
    },
  );

  await recordAudit({
    req,
    actorId: user._id,
    action: auditActions.AUTH_PASSWORD_RESET_COMPLETE,
    meta: { email },
  });

  return successResponse({ res, message: "Password reset successful" });
});
