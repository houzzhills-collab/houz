import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const RESEND_TEST_KEY = "re_test_A1b2C3d4E5f6G7h8";

export type ReceivedEmail = {
  idempotencyKey: string | null;
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  tags: Array<{ name: string; value: string }>;
};

/**
 * In-process stand-in for Resend's POST /emails. Requests must carry the test
 * key. `failNext` makes the next calls answer with the given status, and a
 * repeated Idempotency-Key returns the original id without recording a second
 * email, like the real API.
 */
export class FakeResend {
  readonly sent: ReceivedEmail[] = [];
  /** Statuses to answer the next requests with, in order (e.g. [500] or [422]). */
  failNext: number[] = [];
  private readonly ids = new Map<string, string>();
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  to(address: string): ReceivedEmail[] {
    return this.sent.filter((email) => email.to.includes(address));
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = [];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/emails") return reply(404, { message: "Not found" });
    if (request.headers.authorization !== `Bearer ${RESEND_TEST_KEY}`) return reply(401, { statusCode: 401, name: "validation_error", message: "API key is invalid" });
    const failure = this.failNext.shift();
    if (failure) return reply(failure, { statusCode: failure, name: "application_error", message: failure === 422 ? "The example.com domain is not verified" : "Internal server error" });

    const key = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : null;
    const existing = key ? this.ids.get(key) : undefined;
    if (existing) return reply(200, { id: existing });
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Omit<ReceivedEmail, "idempotencyKey">;
    const id = randomUUID();
    if (key) this.ids.set(key, id);
    this.sent.push({ ...body, idempotencyKey: key });
    return reply(200, { id });
  }
}
