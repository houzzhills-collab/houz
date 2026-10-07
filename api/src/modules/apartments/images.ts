import type { AppConfig } from "../../config/env.js";
import { encodeKey } from "../../lib/object-storage.js";

/**
 * Photo validation by content, not by the client's declared type or file name.
 * Only raster formats every browser shows are accepted; SVG is refused because
 * it can carry script.
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_UPLOAD = 10;
export const MAX_IMAGES_PER_APARTMENT = 24;

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

export function detectImageType(data: Buffer): ImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const EXTENSIONS: Record<ImageType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Photos never change once stored (a new photo gets a new id), so they can be cached forever. */
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Object key in the bucket: apartments/<apartment id>/<photo id>.<ext>. */
export function objectKey(apartmentId: string, imageId: string, type: ImageType): string {
  return `apartments/${apartmentId}/${imageId}.${EXTENSIONS[type]}`;
}

export type ImageUrls = { apiPrefix: string; publicBase: string | null };

export function imageUrls(config: AppConfig): ImageUrls {
  return { apiPrefix: config.apiPrefix, publicBase: config.storage.r2?.publicUrl ?? null };
}

/**
 * Where clients load a photo: straight from Cloudflare's CDN when it is in R2
 * and the bucket has a public URL, otherwise through the API (relative to the
 * API origin, no login needed).
 */
export function imageUrl(urls: ImageUrls, apartmentId: string, image: { id: string; storageKey: string | null }): string {
  if (image.storageKey && urls.publicBase) return `${urls.publicBase}/${encodeKey(image.storageKey)}`;
  return `${urls.apiPrefix}/public/apartments/${apartmentId}/images/${image.id}`;
}
