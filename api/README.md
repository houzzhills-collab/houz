# Houzz Hills API

This is the backend service for Houzz Hills: authentication, bookings, payments, shortlet apartments, rooms, staff, attendance, restaurant POS, inventory, the payment register, live updates and transactional email. It implements the backend described in [`../docs/PRD.md`](../docs/PRD.md) §5–§10. The frontend in [`../web`](../web) uses it through `web/src/lib/api`.

Stack: Fastify 5, TypeORM 1 (query runners, migrations), PostgreSQL 14+, Redis 6.2+, JWT access tokens with rotating refresh cookies, OpenAPI 3.1 and Prometheus metrics.

## Quick start

```bash
cp .env.example .env                  # set JWT_ACCESS_SECRET and SETTINGS_ENCRYPTION_KEY
docker compose -f ../docker-compose.yml up -d postgres redis   # or your own instances
npm ci
npm run db:migrate
npm run dev                           # http://localhost:4000, docs at /docs
```

Create the first owner account with `POST /api/v1/setup`, sending the `x-setup-secret` header (see [Setup](#first-owner-setup)).

### Accounts for every role (development)

```bash
npm run db:seed                       # one account per role; logs email, password and permissions
npm run db:seed -- --reset-passwords  # new passwords for the seed accounts (revokes their sessions)
SEED_PASSWORD='houzzhills dev 2026' npm run db:seed -- --reset-passwords   # same password for all
```

| Role | Email |
| --- | --- |
| Owner | `owner@houzzhills.test` |
| Manager | `manager@houzzhills.test` |
| Front desk | `front-desk@houzzhills.test` |
| Housekeeping | `housekeeping@houzzhills.test` |
| Restaurant cashier | `restaurant-cashier@houzzhills.test` |
| Restaurant manager | `restaurant-manager@houzzhills.test` |
| Storekeeper | `storekeeper@houzzhills.test` |
| Finance | `finance@houzzhills.test` |
| Auditor | `auditor@houzzhills.test` |

- Passwords are random unless `SEED_PASSWORD` (6+ characters) is set.
- Each run prints the log and appends it to `api/seed-accounts.log` (owner-only file permissions, git-ignored).
- Re-running is safe. Existing accounts are left alone, and their password is shown as unchanged.
- Seed accounts sign straight in. Staff onboarded in the app must still change their temporary password.
- Staff accounts get a staff profile, so they appear under **Team & attendance**. Every seed action is written to the audit log.
- The seeder uses the existing property, or creates one on an empty database. It refuses to run with `NODE_ENV=production` or before migrations are applied.

Requires Node.js ≥ 24.11, which TypeORM 1.x needs. The Docker image already uses it.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch mode with `.env` |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run check` | Typecheck, lint and all tests. Use this in CI. |
| `npm test` | Unit tests. Integration tests also run when `TEST_DATABASE_URL` and `TEST_REDIS_URL` are set. **Those databases are wiped**, along with a sibling `<name>_setup` database. |
| `npm run db:migrate` / `db:migrate:revert` / `db:migrate:status` | Apply, revert the last migration, or check for pending ones (dev) |
| `npm run db:seed` | Development accounts for every role, with a credentials log ([details](#accounts-for-every-role-development)) |
| `npm run db:migrate:prod` | Apply migrations from `dist/` (release step) |
| `npm run db:migration:create -- src/db/migrations/<name>` | New empty migration |

## Endpoints

Everything is under `/api/v1` except the health probes, `/openapi.json`, `/docs` and `/metrics`. The full contract, including request and response schemas, is served at `/openapi.json` and generated from the same schemas that validate requests. Management endpoints need `Authorization: Bearer <access token>`; the permission column shows what each one checks.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /health/live`, `GET /health/ready` | Hosting platform | Liveness; readiness of the database and Redis |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout` | Public / refresh cookie | Sign-in, token rotation, sign-out |
| `GET /auth/session` | Optional bearer | Current user, or `{ user: null }` |
| `POST /auth/password` | Bearer | Change password and clear the temporary-password gate |
| `GET /setup`, `POST /setup` | Public / `x-setup-secret` | One-time owner bootstrap |
| `GET /public/availability` | Public, rate limited | Room types available for a stay |
| `POST /public/reservations` | Public, `Idempotency-Key` | Hold a room and start hosted checkout |
| `GET /public/payments/{reference}` | Public, rate limited | Payment status for the result page (no guest data) |
| `GET /public/apartments`, `GET /…/{slug}` | Public, rate limited | Published apartments (optionally only those free for given dates); one apartment with its booked dates |
| `GET /public/apartments/{id}/images/{imageId}` | Public, cached | Apartment photo |
| `POST /webhooks/payments` | Provider signature | Paystack or Flutterwave payment events |
| `POST /cron/expire-payment-holds` | Bearer `CRON_SECRET` | Release unpaid checkout holds |
| `POST /cron/reconcile-payments` | Bearer `CRON_SECRET` | Settlement reconciliation and stale-transfer queue |
| `POST /cron/daily-summary` | Bearer `CRON_SECRET` | Queue the morning summary email for owners and managers |
| `POST /cron/send-emails` | Bearer `CRON_SECRET` | Deliver one batch of queued emails (the API also does this on its own) |
| `GET /management/dashboard` | `dashboard:read` | Role-filtered property snapshot |
| `GET /management/events` | Authenticated | Server-sent events (`Last-Event-ID` / `?cursor=` replay) |
| `GET, POST /management/reservations` | `reservations:read` / `:write` | List (filters, pagination); staff booking |
| `PATCH /management/reservations/{id}` | `reservations:write` | Stay status transitions, with audited reasons |
| `POST /management/reservations/{id}/payments` | `reservations:write`, `Idempotency-Key` | Cash, POS terminal or bank-transfer payment |
| `GET /management/payments`, `GET …/payments/export` | `payments:read` | Payment register with totals; CSV export |
| `PATCH /management/payments/{id}` | `payments:confirm` | Confirm a pending bank transfer |
| `GET, PATCH /management/payment-exceptions[/{id}]` | `payments:confirm` | Exception queue and resolution notes |
| `GET, POST /management/apartments`, `GET, PATCH /…/{id}` | `rooms:read` / `rooms:create` | Apartment listings: create, edit, publish, archive |
| `POST /management/apartments/{id}/images`, `PUT /…/images/order`, `PATCH, DELETE /…/images/{imageId}` | `rooms:create` | Upload (multipart), order, caption, cover and delete photos |
| `GET /management/apartments/bookings`, `GET /…/{id}/calendar` | `reservations:read` | Booking tracker with booker and payment details; per-apartment calendar, occupancy and revenue |
| `GET, POST /management/rooms`, `PATCH /…/{id}`, `GET /…/{id}/history` | `rooms:read` / `rooms:create` (add) / `rooms:write` (state) | Rooms, state changes, history |
| `GET, POST /management/staff`, `PATCH /…/{id}`, `POST /…/{id}/temporary-password` | `staff:read` / `:write` | Onboarding, employment status, password reset |
| `GET, POST /management/attendance`, `GET /…/self` | `attendance:read` / authenticated | Team state; your own clock in/out |
| `GET /management/inventory`, `POST /…/items`, `POST /…/movements` | `inventory:read` / `:write` | Stock items and the movement ledger |
| `GET, POST /management/menu`, `PATCH /…/{id}` | `pos:read` / `menu:write` | Menu, recipes, update and archive |
| `GET, POST /management/pos`, `GET /…/{id}`, `GET, POST /…/shift` | `pos:read` / `:write` | Sales, receipts, cashier shifts |
| `GET, PATCH /management/settings`, `POST /…/payments/verify` | `settings:manage` (owner only) | Global settings, payment provider and Resend keys |
| `POST /management/settings/email/test`, `GET /…/email/messages` | `settings:manage` (owner only) | Send a test email to yourself; the email delivery log |

Changes from the legacy paths in PRD §7:
- Every path gains the `/api/v1` prefix.
- Inventory is split into `/items` and `/movements`, as the PRD asks for the versioned API.
- Lists accept `limit` (at most 200) and `cursor`, and return `nextCursor`.
- Money and order writes require the `Idempotency-Key` header. The legacy `idempotencyKey` body field is still accepted, but it must match the header.

Request and response bodies otherwise keep the legacy shapes.

## Configuration

Every variable is validated at boot by `src/config/env.ts`. An invalid configuration lists every problem at once and the process exits. See [`.env.example`](.env.example) for the full list with defaults.

In production the API refuses to start in any of these cases:
- a placeholder secret is still set
- refresh cookies are not `Secure`
- `CORS_ORIGINS` is empty or uses `http`
- `PUBLIC_WEB_URL` or a provider base URL is not https

| Area | Variables |
| --- | --- |
| Server | `PORT`, `HOST`, `TRUST_PROXY_HOPS`, `CORS_ORIGINS`, `DOCS_ENABLED`, timeouts, `BODY_LIMIT_BYTES` |
| Database / Redis | `DATABASE_URL`, `DATABASE_SSL*`, `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`, `REDIS_URL`, `REDIS_KEY_PREFIX` |
| Auth | `JWT_ACCESS_SECRET`, `JWT_*_TTL_*`, `COOKIE_DOMAIN`, `COOKIE_SECURE`, `COOKIE_SAME_SITE`, login limits |
| Payments | `SETTINGS_ENCRYPTION_KEY` (encrypts provider keys stored in settings), `PUBLIC_WEB_URL`, provider base URLs and timeout |
| Email | `RESEND_BASE_URL`, `EMAIL_TIMEOUT_MS` (the key and sender are owner settings; links in emails use `PUBLIC_WEB_URL`) |
| File storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, optional `R2_PUBLIC_URL`, `R2_ENDPOINT`, `STORAGE_TIMEOUT_MS` (see [File storage](#file-storage-cloudflare-r2)) |
| Booking | `PUBLIC_BOOKING_RATE_LIMIT_MAX` |
| Operations | `CRON_SECRET`, `RECONCILIATION_WINDOW_HOURS`, `SETUP_SECRET`, `METRICS_TOKEN` |

### Owner-managed settings

The payment provider and its keys, email delivery and its Resend key, and the booking rules are **global settings** the owner changes from the web app's Settings page. They are not environment variables. Settings live in the `settings` table, seeded with defaults by migrations: online payments off, email off, a 20-minute hold, 90-night maximum stay, 365-day horizon and a 48-hour transfer review window.

| Setting | Notes |
| --- | --- |
| `payments.provider` | `none`, `paystack` or `flutterwave`. Can only be switched on once its keys are saved and `PUBLIC_WEB_URL` is set. |
| `payments.paystack_secret_key` | Secret. Format-checked (`sk_test_…` / `sk_live_…`). Also verifies Paystack webhooks. |
| `payments.flutterwave_secret_key`, `payments.flutterwave_webhook_hash` | Secrets |
| `booking.hold_minutes`, `booking.max_stay_nights`, `booking.horizon_days`, `payments.bank_transfer_review_hours` | Integers, range-checked |
| `email.provider` | `none` or `resend`. Can only be switched on once the Resend key and sender are saved. |
| `email.resend_api_key` | Secret. Format-checked (`re_…`). A sending-only key is enough. |
| `email.from_address`, `email.reply_to` | Sender (`bookings@domain` or `Name <bookings@domain>`, domain verified in Resend) and optional reply-to |
| `email.guest_notifications`, `email.staff_notifications`, `email.management_alerts` | `on`/`off` switches per audience, all on by default |

- **Owner only.** `GET`/`PATCH /api/v1/management/settings` and `POST /settings/payments/verify` require `settings:manage`, which only the owner role holds.
- **Secrets are write-only.**
  - They are encrypted with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY`, and each ciphertext is bound to its setting name.
  - Responses show only whether a secret is set and its last four characters.
  - The audit log records that a secret was replaced or cleared, never its value.
  - A value that can't be decrypted (wrong key, or tampering) is reported as unreadable, and the provider stays off until the owner re-enters it.
- **Changes apply immediately on every replica.** Each process caches settings, and a version counter in Redis tells every replica to reload; without Redis they converge within 30 seconds.
- **Verify.** `POST /settings/payments/verify` asks the provider whether it accepts the saved key.

Each environment (dev, staging, production) needs its own database, Redis and provider keys. Keep every secret in the host's secret store, never in the web repository.

## How payments work

**Online booking (PRD §4.1)**

1. `POST /public/reservations` validates the stay against the Africa/Lagos business date, the maximum stay and the booking horizon.
2. It locks one free physical room of the requested type (`FOR UPDATE SKIP LOCKED`), prices the full stay on the server, and creates a `pending_payment` hold with a pending online payment.
3. It then commits, and only afterwards calls the provider. No database lock is held across the network.
4. If checkout cannot be started, the hold is released and the guest receives 502.
5. The `Idempotency-Key` is enforced in Redis and again in the database. A retry returns the same reservation and checkout URL; reusing the key with a different body returns 409.

**Settlement**
- A webhook is only a hint. It must carry a valid signature over the raw body (HMAC-SHA512 for Paystack, `verif-hash` for Flutterwave).
- The API then fetches the transaction from the provider and trusts only that response for status, reference, exact amount and NGN currency.
- Each provider event is processed exactly once, in the same transaction as the ledger change, so duplicates and retries return 2xx with no side effects.
- If the provider cannot be reached, the API returns 502 so the provider retries later.

**Results**

| Situation | What happens |
| --- | --- |
| Payment matches and the hold is still valid | Payment `settled`; reservation `confirmed` and `paid` |
| Payment arrives after the hold lapsed or the stay was cancelled | Money recorded as `settled`; reservation not confirmed against possibly resold inventory; `late_success` exception raised |
| Amount mismatch, currency mismatch, provider does not confirm, unknown reference, overpayment | Nothing settles; matching exception queued |

**Staff payments (PRD §4.2)**
- Cash and POS terminal payments settle immediately.
- Bank transfers stay `pending` until an owner or manager confirms them. Confirmation is conditional on the row still being pending, so two simultaneous confirmations cannot double-settle.
- Online payments can only be settled by the provider.
- Overpayments are rejected.
- Pending amounts never count as revenue.

**Restaurant (PRD §4.3)**
- Orders paid by bank transfer stay `pending_payment` and have no receipt until they are confirmed.

**Refunds**
- There is no refund operation anywhere. Resolving an exception records a person's decision and changes nothing else.

**Jobs.** Run these on a schedule. A platform cron (Railway) runs the job script from the API image directly. Any other scheduler can call the HTTP endpoint with `Authorization: Bearer $CRON_SECRET`.

| Endpoint | How often | What it does |
| --- | --- | --- |
| `node dist/scripts/run-job.js expire-payment-holds` or `POST /api/v1/cron/expire-payment-holds` | Every 2–5 minutes | Expires lapsed holds and fails their online payments. Availability already ignores lapsed holds, so a late run never oversells. |
| `node dist/scripts/run-job.js daily-summary` or `POST /api/v1/cron/daily-summary` | Daily, about 07:00 Africa/Lagos | Queues the morning summary email for owners and managers. Re-running the same day queues nothing new. |
| `node dist/scripts/run-job.js reconcile-payments` or `POST /api/v1/cron/reconcile-payments` | Hourly | Re-applies every successful provider transaction in the window through the same idempotent path as webhooks, so a missed webhook still settles. Also queues bank transfers still pending after the `payments.bank_transfer_review_hours` setting. |

**Provider setup**
1. Set `PUBLIC_WEB_URL` to the web origin. Guests return to `${PUBLIC_WEB_URL}/payment-result?reference=…`.
2. As the owner, open **Settings**:
   - paste the provider's secret key (and, for Flutterwave, the webhook secret hash)
   - choose the provider
   - save, then click **Check saved key**
3. Copy the webhook URL shown in Settings (`${PUBLIC_WEB_URL}/api/v1/webhooks/payments`) into the provider dashboard. The web app forwards it to the API with the raw body intact, so signatures verify.

## Shortlet apartments

An apartment is a listing (name, category, description, location, photos, amenities, features, facilities, house rules, caution fee, warranty and cancellation policies, minimum stay, check-in and check-out times) backed by one bookable unit in `rooms`. The API keeps the unit in step with the listing:

| Listing field | Unit (`rooms`) column | Why |
| --- | --- | --- |
| `unitCode` | `room_number` | Unique per property |
| `name` | `room_type` | Bookings choose a unit by type, so each apartment books as itself. Names must not match any other unit's type. |
| `nightlyRateKobo`, `maxGuests` | `nightly_rate_kobo`, `capacity` | Pricing and capacity checks |
| `status` | `active` | Only published apartments can be booked |

Because of this, everything that already works for rooms works for apartments: availability, the overlap constraint, online checkout, staff bookings and payments, check-in and check-out, housekeeping state, the payment register, emails and live updates. Book an apartment through the existing reservation endpoints: staff send its `roomId`, and the public site sends its `bookingRoomType` as `roomType`.

**Lifecycle**
1. `POST /management/apartments` creates a **draft**. Its unit exists but cannot be booked.
2. Upload photos: `POST /…/{id}/images` as `multipart/form-data` with `file` parts (JPEG, PNG or WebP, checked by content; up to 8 MB each, 10 per request, 24 per apartment). Identical re-uploads are ignored, and the first photo becomes the cover.
3. `PATCH … { "status": "published" }` opens it for booking and lists it publicly. Publishing needs at least one photo.
4. `PATCH … { "status": "archived" }` retires it. This is refused while it has upcoming bookings. Nothing is ever hard-deleted, so booking history stays intact.

**Rules**
- **Minimum stay** is enforced for staff bookings, online bookings and public availability.
- **Price and capacity changes** apply to new bookings only. Existing reservations keep their price.
- **The caution fee** is listed and shown to guests and in the booking tracker. It is not added to the stay total or collected through checkout.
- **Housekeeping** sees apartments without prices or guest names, as with rooms.
- **Public endpoints** never show the exact address, coordinates or directions. Guests get those in their booking confirmation email.

**Booking tracker.** `GET /management/apartments/bookings` lists apartment reservations, newest stay first. Each one has the booker's name, email and phone, dates, nights, guests, status, source, total, paid, pending and balance amounts, caution fee, and every payment (method, status, reference, who recorded and confirmed it). Filter by `apartmentId`, `from`/`to`, `status`, `paymentStatus` or a search (`q`) on name, email, phone or reference; `totals` cover all matches. `GET /management/apartments/{id}/calendar` gives the stays in a period (90 days by default) with occupancy and revenue.

**Photos** are stored in Cloudflare R2 when it is configured, otherwise in PostgreSQL. See [File storage](#file-storage-cloudflare-r2).

## File storage (Cloudflare R2)

Uploads still go through the API, which checks each file's content, size and the per-apartment limit, then stores it in an R2 bucket under `apartments/<apartment id>/<photo id>.<ext>` with a year-long immutable `Cache-Control`. The database row keeps only the object key.

- **Order of work:** bytes are uploaded before the database transaction, so no row lock is held across the network. If the transaction then fails, or the photo turns out to be a duplicate, the uploaded objects are deleted again.
- **R2 down:** the upload fails with `502 STORAGE_UNAVAILABLE` and nothing is recorded. Credentials never appear in errors or logs.
- **Deleting a photo:** the row is deleted first, then the object. If the object delete fails, it is logged as an orphan to remove by hand; the listing is already correct.
- **Serving:**
  - With `R2_PUBLIC_URL` (a custom domain on the bucket, or its r2.dev URL), photo URLs in API responses point straight at Cloudflare's CDN. The old `/api/v1/public/apartments/{id}/images/{imageId}` URL redirects there.
  - Without it, the bucket stays private and the API streams photos from R2 at that same URL.
- **Without R2** (local development and tests), photos are stored in `apartment_images.data`. Rows stored that way keep working after R2 is switched on, so no data migration is needed. New uploads go to R2.

**Setup**
1. Cloudflare dashboard → **R2** → create a bucket (for example `houzzhills-media`).
2. Optional, for CDN delivery: bucket → **Settings** → **Custom Domains** → connect a domain such as `media.houzzhills.com` (or enable the r2.dev URL for testing). Use that as `R2_PUBLIC_URL`.
3. **R2** → **Manage API tokens** → create a token with **Object Read & Write** on that bucket only. Note the access key id and secret.
4. Set `R2_ACCOUNT_ID` (shown on the R2 overview page), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and optionally `R2_PUBLIC_URL`, then restart. Set all four required variables or none; a partial set stops the API at boot. EU-jurisdiction buckets also need `R2_ENDPOINT=https://<account id>.eu.r2.cloudflarestorage.com`.
5. The boot log says `uploads stored in Cloudflare R2` once it is active.

## How email works

Emails use a **transactional outbox**: a service queues an email in `email_messages` inside the same transaction as the change it describes, so a rolled-back change never emails anyone and a committed one is never lost. A dispatcher in every API process then delivers due messages through Resend:

- Messages are claimed with `FOR UPDATE SKIP LOCKED` under a 3-minute lease, so any number of replicas can run it.
- Each message's id is sent as Resend's `Idempotency-Key`, so a crash or lease takeover never sends twice.
- Network errors, 429 and 5xx are retried with backoff (30 s doubling to 1 hour, 8 attempts). Other rejections, such as an unverified domain, fail at once and show in the delivery log.
- Sends are paced under Resend's default 2 requests per second.
- While email is off, or an audience's switch is off, queued messages are marked `skipped`, not held. Messages not sent within 48 hours are skipped too, so turning email on never sends a backlog of stale notices.
- Payloads (guest details, and temporary passwords, which are additionally sealed with `SETTINGS_ENCRYPTION_KEY`) are deleted once a message reaches a final state. The row stays as the delivery log.

| Audience | Emails | Sent when |
| --- | --- | --- |
| Guests (when the booking has an email) | Booking confirmed | Staff booking created; website booking paid within its hold |
| | Payment receipt / transfer being verified | Staff records cash, POS or transfer; owner confirms a transfer |
| | Checked in, checked out, cancelled, no-show | Front desk changes the stay status |
| | Booking not completed | A website checkout hold expires unpaid |
| | Payment arrived after the hold | Provider settles money for a lapsed or cancelled hold |
| Staff | Welcome with temporary password | Staff onboarded |
| | Password reset with temporary password | Manager issues a temporary password |
| | Password changed | A user changes a password they already chose |
| | Account paused, closed or reactivated | Employment status changes |
| Management | Payment exception | Any exception is queued (to `payments:confirm` holders) |
| | Bank transfer to confirm | Reservation or restaurant transfer recorded (to `payments:confirm` holders) |
| | New online booking | Website booking confirmed (owner, manager, front desk) |
| | Low stock | A sale, wastage or count takes an item to or below its reorder level (to `inventory:write` holders) |
| | Cash variance | A cashier shift closes with a variance (owner, manager, restaurant manager) |
| | Room out of service | Room set to maintenance or out of order (owner, manager, front desk) |
| | Daily summary | `daily-summary` job (owner, manager) |
| | Security notice | Payment or email keys, providers or sender change (owners; cannot be switched off) |

Templates live in `src/modules/email/templates.ts` and share one branded layout (`layout.ts`) that renders HTML and plain text, escaping all dynamic text.

**Email setup**
1. In Resend, verify your sending domain (add its SPF and DKIM records) and create an API key with sending access.
2. As the owner, open **Settings → Email notifications**, paste the key, enter the sender (for example `Houzz Hills <bookings@houzzhills.com>`) and optionally a reply-to address, then save.
3. Click **Send a test email to me**. Fix anything it reports, such as an unverified domain.
4. Choose **Resend** under Delivery and save. Every email is listed in the delivery log below the settings.

## Security model

- **Authentication.**
  - Access tokens are 15-minute HS256 JWTs.
  - Refresh tokens are HttpOnly, Secure, SameSite cookies scoped to `/api/v1/auth`. They rotate on every use; reusing an old one after the 30-second grace window revokes the session.
  - Sessions are re-checked on every request through a 60-second Redis cache with immediate revocation markers. If Redis is down, the check falls back to PostgreSQL.
  - Logout, password change, password reset and deactivation take effect immediately.
  - Login is throttled per IP and locked per email+IP pair. An unknown email takes the same time to reject as a wrong password.
- **Authorisation.**
  - Every protected route declares its permission (`app.authorize(...)`), and all data is scoped to the caller's property.
  - Only the owner can create or manage manager, finance and auditor accounts. Nobody can change their own account through the staff endpoints.
  - Temporary passwords lock the account until changed.
  - Payloads are filtered by role:
    - Housekeeping sees no rates or guest details.
    - Only staff managers see personal contact fields.
    - Dashboard money metrics appear only for payment and report readers.
    - Event-stream contents are filtered by permission.
- **Input.**
  - Every route has a JSON schema with unknown properties stripped.
  - Validation failures return 422 with field details.
  - Request bodies and string lengths are capped.
  - All SQL is parameterised.
  - The CSV export neutralises spreadsheet formulas.
- **Transport and abuse.**
  - Helmet headers and HSTS in production.
  - Credentialed CORS restricted to an exact allowlist.
  - CSRF origin checks on the cookie endpoints.
  - Redis-backed rate limits shared across replicas, with stricter per-route limits on login, booking, payment status, setup, exports and jobs.
  - Load shedding when the event loop saturates.
  - Request, handler and keep-alive timeouts.
- **Secrets.**
  - Provider keys appear only in outbound `Authorization` headers.
  - Every secret comparison is constant-time, done on SHA-256 digests.
  - Logs redact credentials, cookies and tokens.
  - Webhook payloads are stored without customer details.
- **Integrity.**
  - A PostgreSQL exclusion constraint makes overlapping active stays for the same room impossible, even under concurrency.
  - Writes take row locks; multi-row stock updates lock in id order to avoid deadlocks.
  - Serialization failures are retried.
  - Audit and outbox rows commit in the same transaction as each change.

## Data and migrations

- PostgreSQL is authoritative. Money is integer kobo, returned as strings. Timestamps are `timestamptz`, and business dates use Africa/Lagos.
- Migrations live in `src/db/migrations` and are listed in `index.ts`:

| Migration | What it does |
| --- | --- |
| `LegacyBaseline` | The original schema, idempotent and irreversible |
| `CreateSettings` | Owner-managed global settings, seeded with defaults |
| `CreateApiSessions` | Refresh-token sessions |
| `BookingIntegrityAndPaymentExceptions` | Exclusion constraint, online-checkout columns, POS lifecycle, the exception queue, and indexes for every list path |
| `CreateEmailMessages` | The email outbox and delivery log, and the email settings (off by default) |
| `CreateApartments` | Apartment listings and photos, linked one-to-one to their bookable unit |
| `ApartmentImagesObjectStorage` | Photos can hold an R2 object key instead of bytes. Reverting is refused while any photo exists only in R2. |

- Before applying `BookingIntegrityAndPaymentExceptions` to an existing database, resolve any genuinely overlapping active reservations; otherwise the migration stops with a constraint error.
- Migrations run as a release step, never on boot. `synchronize` is permanently off.
- Data access uses TypeORM query runners with hand-written, parameterised SQL (`src/db/sql.ts`). The auth tables also use `EntitySchema` entities.

## Operations runbook

**Deploying**
1. Build the image.
2. Run `node dist/scripts/migrate.js up` once.
3. Roll out the replicas behind TLS.
4. Point the readiness probe at `/health/ready`.

**Monitoring.** Scrape `/metrics` with `Authorization: Bearer $METRICS_TOKEN` and alert on:

| Condition | Likely meaning |
| --- | --- |
| `houzzhills_stale_payment_holds > 0` for 15 minutes | The hold-expiry scheduler is not running |
| `rate(houzzhills_payment_webhooks_total{outcome=~"error\|invalid_signature"}[15m]) > 0` | Webhook processing is failing or being probed |
| `houzzhills_open_payment_exceptions > 0` | People need to act on the exception queue |
| `houzzhills_email_backlog > 0` | Emails are stuck: Resend is failing or rate-limiting, or no API replica is running |
| `houzzhills_emails_failed_24h > 0` | Resend rejected emails; the delivery log in Settings shows why |
| 5xx rate or p95 latency on `houzzhills_http_request_duration_seconds` | API errors or slowness |

Logs are structured JSON with a `reqId` on every line. Clients can supply `X-Request-Id`, and every response echoes it.

**If webhooks were missed**
1. Fix the delivery problem.
2. Call `POST /cron/reconcile-payments`. It is safe to repeat.
3. Work through the exception queue.

**Backups**
- Use managed PostgreSQL with point-in-time recovery, or schedule `pg_dump -Fc` at least daily, with copies kept off-site.
- Run Redis with AOF persistence. Redis holds rate-limit state, idempotency records and session caches; losing it never loses money records, because the database keeps its own unique keys.

**Restore drill (quarterly)**
1. Restore the latest backup into a fresh instance.
2. Run `node dist/scripts/migrate.js status`.
3. Start an API against it and check `/health/ready`.
4. Sign in, open the payment register, and compare its totals with the source.
5. Record how long the restore took.

**Retention.** Audit and outbox rows grow without bound. Archive `outbox_events` older than 90 days and `provider_webhook_events` older than 1 year, once they are no longer needed for reconciliation. `email_messages` rows keep only the recipient, subject and status after delivery; delete those older than a year.

## Not implemented yet

These are later scope in PRD §8 P1/P2, or decisions Houzz Hills still has to make:
- SMS or WhatsApp notifications (email is implemented)
- MFA
- deposits and partial online payment
- folios and incidentals
- rate plans, promotions and taxes
- supplier purchase orders
- housekeeping task assignment
- automated owner financial reports
- a multi-property tenancy model (the public endpoints serve the first property)

Settlement reconciliation compares provider transactions with local records. Matching against company bank statements remains a manual task, supported by the CSV export.
