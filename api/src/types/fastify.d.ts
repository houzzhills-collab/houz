import type { preHandlerAsyncHookHandler } from "fastify";
import type { Redis } from "ioredis";
import type { DataSource } from "typeorm";
import type { AppConfig } from "../config/env.js";
import type { R2Storage } from "../lib/object-storage.js";
import type { Permission } from "../lib/permissions.js";
import type { Principal, SessionService } from "../modules/auth/session.service.js";
import type { EmailService } from "../modules/email/email.service.js";
import type { PaymentProvider } from "../modules/payments/providers/index.js";
import type { SettingsService } from "../modules/settings/settings.service.js";
import type { IdempotencyOptions, IdempotencyState } from "../plugins/idempotency.js";
import type { AppMetrics } from "../plugins/metrics.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: DataSource;
    redis: Redis;
    sessions: SessionService;
    /** Owner-managed global settings (payment keys are encrypted at rest). */
    settings: SettingsService;
    payments: {
      /** The provider selected in settings, or null when online payment is off. */
      provider(): Promise<PaymentProvider | null>;
    };
    /** Transactional email dispatcher (Resend). Emails are queued with `queueEmail` inside transactions. */
    email: EmailService;
    /** Cloudflare R2 for uploaded files, or null when uploads are kept in PostgreSQL. */
    storage: R2Storage | null;
    metrics: AppMetrics;
    /** Verifies the bearer access token and loads `request.principal`. */
    authenticate: preHandlerAsyncHookHandler;
    /** Authenticates, enforces the temporary-password gate, then checks every listed permission. */
    authorize: (...permissions: Permission[]) => preHandlerAsyncHookHandler;
    /** Route preHandler enabling `Idempotency-Key` replay protection. Place it after `authorize`. */
    idempotent: (options?: IdempotencyOptions) => preHandlerAsyncHookHandler;
  }

  interface FastifyRequest {
    principal: Principal | null;
    idempotency: IdempotencyState | null;
  }

  interface FastifyContextConfig {
    /** Allow this route while the user still has to replace a temporary password. */
    allowPasswordChangeRequired?: boolean;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string; iat?: number; exp?: number };
  }
}
