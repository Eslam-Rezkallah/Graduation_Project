import cloudinary from "cloudinary";
import { config } from "../../config/index.js";

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true,
});

export const cloud = cloudinary.v2;

const PLACEHOLDER_MARKERS = ["placeholder", "changeme", "your_", "xxx"];

/** True when real Cloudinary credentials are set (not dev placeholders). */
export function isCloudinaryConfigured() {
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  const values = [cloudName, apiKey, apiSecret];
  if (values.some((v) => !v || !String(v).trim())) return false;
  const blob = values.join("|").toLowerCase();
  return !PLACEHOLDER_MARKERS.some((m) => blob.includes(m));
}
