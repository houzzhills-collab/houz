import { createHttpClient } from "./http";

export * from "./client";
export type * from "./types";

/**
 * The single ApiClient used by the whole web app. By default it calls the API
 * on the same origin (`/api/v1/*`, forwarded to the API service by
 * next.config.ts). NEXT_PUBLIC_API_BASE_URL points it at another origin instead.
 */
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
export const api = createHttpClient(apiBaseUrl);

/** Photo URLs from the API are either absolute (CDN) or relative to the API origin. */
export function apiAssetUrl(url: string): string {
  return url.startsWith("/") ? `${apiBaseUrl}${url}` : url;
}
