// src/utils/security/token.security.js
import jwt from "jsonwebtoken";
import userModel, { roleTypes } from "../../DB/Model/user.model.js";
import * as dbService from "../../DB/db.service.js";
import { UnauthorizedError, ForbiddenError } from "../errors/index.js";
import { config } from "../../config/index.js";

export const tokenTypes = {
  access: "access",
  refresh: "refresh",
};

export const generateAccessToken = ({
  payload = {},
  role = roleTypes.Member,
} = {}) => {
  const signature =
    role === roleTypes.Admin
      ? config.security.adminAccessSecret
      : config.security.userAccessSecret;

  return jwt.sign(payload, signature, {
    expiresIn: config.security.accessTokenExpiration,
  });
};

export const generateRefreshToken = ({
  payload = {},
  role = roleTypes.Member,
} = {}) => {
  const signature =
    role === roleTypes.Admin
      ? config.security.adminRefreshSecret
      : config.security.userRefreshSecret;

  return jwt.sign(payload, signature, {
    expiresIn: config.security.refreshTokenExpiration,
  });
};

export const decodedToken = async ({
  authorization = "",
  tokenType = tokenTypes.access,
} = {}) => {
  const [bearer, token] = authorization?.split(" ") || [];

  if (!token || !bearer) {
    throw new UnauthorizedError("Authorization header is missing");
  }

  let accessSignature = "";
  let refreshSignature = "";
  let allowedRoles = [];

  switch (bearer) {
    case "Bearer":
      // Bearer = human user tokens (all roles allowed; route-level
      // authorization() decides what each role can actually do)
      accessSignature = config.security.userAccessSecret;
      refreshSignature = config.security.userRefreshSecret;
      allowedRoles = [roleTypes.Member, roleTypes.Manager, roleTypes.Admin];
      break;

    case "System":
      // System = admin-issued tokens, intended for elevated/system flows
      accessSignature = config.security.adminAccessSecret;
      refreshSignature = config.security.adminRefreshSecret;
      allowedRoles = [roleTypes.Admin];
      break;

    default:
      throw new UnauthorizedError("Invalid token type");
  }

  const decoded = verifyToken({
    token,
    signature:
      tokenType === tokenTypes.access ? accessSignature : refreshSignature,
  });

  if (!decoded?.id) {
    throw new UnauthorizedError("Invalid token payload");
  }

  const user = await dbService.findOne({
    model: userModel,
    filter: { _id: decoded.id, isDeleted: false },
  });

  if (!user) {
    throw new UnauthorizedError("User not found");
  }

  if (!allowedRoles.includes(user.role)) {
    throw new ForbiddenError("Token type not permitted for this role");
  }

  if (user?.changeCredentialsTime?.getTime() >= decoded.iat * 1000) {
    throw new UnauthorizedError("Credentials changed. Please log in again.");
  }

  return user;
};

export const generateToken = ({
  payload = {},
  signature = config.security.userAccessSecret,
  expiresIn = config.security.accessTokenExpiration,
} = {}) => {
  return jwt.sign(payload, signature, { expiresIn });
};

export const verifyToken = ({
  token,
  signature = config.security.userAccessSecret,
} = {}) => {
  return jwt.verify(token, signature);
};
