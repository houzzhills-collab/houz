import { AwsClient } from "aws4fetch";
import type { AppConfig } from "../config/env.js";
import { AppError } from "./errors.js";

type R2Config = NonNullable<AppConfig["storage"]["r2"]>;

const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

/** Percent-encodes each path segment of an object key for use in a URL. */
export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** Storage failures surface as 502 with a generic message; credentials and endpoints never reach clients. */
function unavailable(): AppError {
  return new AppError(502, "STORAGE_UNAVAILABLE", "File storage could not be reached. Try again shortly.");
}

/**
 * Cloudflare R2 through its S3-compatible API, signed with SigV4 (aws4fetch).
 * Every call has a hard timeout; transient 5xx/429 responses are retried a
 * couple of times by the client before failing.
 */
export class R2Storage {
  private readonly client: AwsClient;

  constructor(
    private readonly config: R2Config,
    private readonly timeoutMs: number,
  ) {
    this.client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", retries: 2, initRetryMs: 200 });
  }

  private objectUrl(key: string): string {
    return `${this.config.endpoint}/${this.config.bucket}/${encodeKey(key)}`;
  }

  private async request(key: string, init: RequestInit): Promise<Response> {
    try {
      return await this.client.fetch(this.objectUrl(key), { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw unavailable();
    }
  }

  async put(key: string, data: Buffer, contentType: string, cacheControl: string): Promise<void> {
    const response = await this.request(key, { method: "PUT", body: data, headers: { "content-type": contentType, "cache-control": cacheControl } });
    await response.body?.cancel();
    if (!response.ok) throw unavailable();
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    const response = await this.request(key, { method: "GET" });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_OBJECT_BYTES) throw unavailable();
    return { data, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }

  /** Deleting a missing object succeeds, so retries are safe. */
  async delete(key: string): Promise<void> {
    const response = await this.request(key, { method: "DELETE" });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw unavailable();
  }
}
