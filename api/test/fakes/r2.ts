import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const R2_TEST_ACCESS_KEY = "r2testaccesskey0123456789abcdef";
export const R2_TEST_SECRET = "r2testsecretaccesskey0123456789abcdefghijkl";
export const R2_TEST_BUCKET = "houzzhills-test";

type StoredObject = { data: Buffer; contentType: string; cacheControl: string | null };

/**
 * In-process stand-in for R2's S3 API: PUT, GET and DELETE on /<bucket>/<key>.
 * Requests must be SigV4-signed with the test access key, and the signed
 * payload hash must match the body. `failNext` answers the next requests with
 * the given statuses.
 */
export class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  failNext: number[] = [];
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const reply = (status: number, payload?: Buffer, headers: Record<string, string> = {}) => {
      response.writeHead(status, headers);
      response.end(payload);
    };
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${R2_TEST_ACCESS_KEY}/`) || !request.headers["x-amz-date"]) return reply(403);
    const payloadHash = request.headers["x-amz-content-sha256"];
    if (payloadHash && payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== createHash("sha256").update(body).digest("hex")) return reply(400);
    const failure = this.failNext.shift();
    if (failure) return reply(failure);

    const path = decodeURIComponent(new URL(request.url ?? "/", "http://fake").pathname);
    const prefix = `/${R2_TEST_BUCKET}/`;
    if (!path.startsWith(prefix)) return reply(404);
    const key = path.slice(prefix.length);
    if (request.method === "PUT") {
      this.objects.set(key, { data: body, contentType: String(request.headers["content-type"] ?? ""), cacheControl: request.headers["cache-control"] ?? null });
      return reply(200, undefined, { etag: '"x"' });
    }
    if (request.method === "GET") {
      const stored = this.objects.get(key);
      return stored ? reply(200, stored.data, { "content-type": stored.contentType }) : reply(404);
    }
    if (request.method === "DELETE") {
      this.objects.delete(key);
      return reply(204);
    }
    return reply(405);
  }
}
