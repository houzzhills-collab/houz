/**
 * Minimal Resend client (POST /emails). The API key travels only in the
 * Authorization header and never appears in errors or logs. Each message's own
 * id is sent as the Idempotency-Key, so a retry after a timeout or a crash
 * mid-send cannot deliver the same email twice.
 */

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** True for transient failures (network, 429, 5xx) worth retrying. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export type OutgoingEmail = {
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  /** Resend tags: ASCII letters, numbers, underscores and dashes only. */
  tags: Record<string, string>;
};

export type ResendOptions = { baseUrl: string; apiKey: string; timeoutMs: number };

const MAX_RESPONSE_BYTES = 256 * 1024;

function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

export async function sendWithResend(options: ResendOptions, email: OutgoingEmail, idempotencyKey: string): Promise<{ id: string }> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "houzzhills-api",
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        tags: Object.entries(email.tags).map(([name, value]) => ({ name: tagValue(name), value: tagValue(value) })),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new EmailSendError(timedOut ? "Resend did not respond in time" : "Resend could not be reached", true);
  }

  const raw = await response.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  if (raw && Buffer.byteLength(raw) <= MAX_RESPONSE_BYTES) {
    try {
      const parsed: unknown = JSON.parse(raw);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
  }

  if (response.ok && typeof body?.id === "string") return { id: body.id };
  // Resend's error messages describe the request (e.g. an unverified domain), never the key.
  const detail = typeof body?.message === "string" ? body.message.slice(0, 300) : `HTTP ${response.status}`;
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  if (response.ok) throw new EmailSendError("Resend returned an unexpected response", true);
  throw new EmailSendError(`Resend rejected the email (${response.status}): ${detail}`, retryable);
}
