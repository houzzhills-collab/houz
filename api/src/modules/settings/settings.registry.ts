/**
 * Global settings managed by the owner (PRD: payment provider and keys belong
 * to Houzz Hills, not to the deployment). Each definition declares its type,
 * default, validation and whether it is a secret. Secrets are encrypted at
 * rest and never returned to any client.
 */
export type SettingGroup = "payments" | "booking" | "email";

type Base = { key: string; group: SettingGroup; label: string; description: string };
export type StringSetting = Base & {
  type: "string";
  secret: boolean;
  /** The payment provider a credential belongs to, so clients show it with that provider. */
  provider?: string;
  pattern?: RegExp;
  patternHint?: string;
  minLength: number;
  maxLength: number;
};
export type EnumSetting = Base & { type: "enum"; secret: false; values: readonly string[]; labels: Readonly<Record<string, string>>; default: string };
export type IntegerSetting = Base & { type: "integer"; secret: false; minimum: number; maximum: number; default: number };
export type SettingDefinition = StringSetting | EnumSetting | IntegerSetting;

export const PAYMENT_PROVIDERS = ["none", "paystack", "flutterwave"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const EMAIL_PROVIDERS = ["none", "resend"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

const SWITCH = { values: ["on", "off"] as const, labels: { on: "On", off: "Off" } };
/** A bare address, or "Display Name <address>". */
const MAILBOX = /^(?:[^\s<>@",;]+@[^\s<>@",;]+\.[A-Za-z]{2,}|[^<>@"\r\n,;]{1,80} <[^\s<>@",;]+@[^\s<>@",;]+\.[A-Za-z]{2,}>)$/;
const ADDRESS = /^[^\s<>@",;]+@[^\s<>@",;]+\.[A-Za-z]{2,}$/;

export const SETTINGS = [
  {
    key: "payments.provider",
    group: "payments",
    type: "enum",
    secret: false,
    values: PAYMENT_PROVIDERS,
    labels: { none: "Off (no online payment)", paystack: "Paystack", flutterwave: "Flutterwave" },
    default: "none",
    label: "Online payment provider",
    description: "Hosted checkout for public bookings. Choose none to disable online booking.",
  },
  {
    key: "payments.paystack_secret_key",
    group: "payments",
    type: "string",
    secret: true,
    provider: "paystack",
    pattern: /^sk_(test|live)_[A-Za-z0-9]{8,}$/,
    patternHint: "a Paystack secret key (sk_test_… or sk_live_…)",
    minLength: 16,
    maxLength: 200,
    label: "Paystack secret key",
    description: "Dashboard → Settings → API Keys & Webhooks. Also signs Paystack webhooks.",
  },
  {
    key: "payments.flutterwave_secret_key",
    group: "payments",
    type: "string",
    secret: true,
    provider: "flutterwave",
    pattern: /^FLWSECK(_TEST)?-[A-Za-z0-9-]{8,}$/,
    patternHint: "a Flutterwave secret key (FLWSECK-… or FLWSECK_TEST-…)",
    minLength: 16,
    maxLength: 200,
    label: "Flutterwave secret key",
    description: "Dashboard → Settings → API Keys.",
  },
  {
    key: "payments.flutterwave_webhook_hash",
    group: "payments",
    type: "string",
    secret: true,
    provider: "flutterwave",
    minLength: 16,
    maxLength: 200,
    label: "Flutterwave webhook secret hash",
    description: "Dashboard → Settings → Webhooks → Secret hash. Must match exactly.",
  },
  {
    key: "booking.hold_minutes",
    group: "booking",
    type: "integer",
    secret: false,
    minimum: 5,
    maximum: 120,
    default: 20,
    label: "Checkout hold (minutes)",
    description: "How long a room is held while a guest pays online.",
  },
  {
    key: "booking.pay_later_hours",
    group: "booking",
    type: "integer",
    secret: false,
    minimum: 0,
    maximum: 168,
    default: 24,
    label: "Pay-later hold (hours)",
    description: "How long a website booking is held unpaid when the guest chooses to pay later. 0 turns pay later off.",
  },
  {
    key: "booking.max_stay_nights",
    group: "booking",
    type: "integer",
    secret: false,
    minimum: 1,
    maximum: 365,
    default: 90,
    label: "Maximum stay (nights)",
    description: "Longest stay accepted from the website or staff.",
  },
  {
    key: "booking.horizon_days",
    group: "booking",
    type: "integer",
    secret: false,
    minimum: 1,
    maximum: 730,
    default: 365,
    label: "Booking horizon (days)",
    description: "How far ahead check-in dates can be booked.",
  },
  {
    key: "payments.bank_transfer_review_hours",
    group: "payments",
    type: "integer",
    secret: false,
    minimum: 1,
    maximum: 720,
    default: 48,
    label: "Transfer review window (hours)",
    description: "Pending bank transfers older than this are queued as payment exceptions.",
  },
  {
    key: "email.provider",
    group: "email",
    type: "enum",
    secret: false,
    values: EMAIL_PROVIDERS,
    labels: { none: "Off (no email)", resend: "Resend" },
    default: "none",
    label: "Email delivery",
    description: "Sends booking confirmations, receipts, staff account emails and management alerts.",
  },
  {
    key: "email.resend_api_key",
    group: "email",
    type: "string",
    secret: true,
    provider: "resend",
    pattern: /^re_[A-Za-z0-9_]{8,}$/,
    patternHint: "a Resend API key (re_…)",
    minLength: 11,
    maxLength: 200,
    label: "Resend API key",
    description: "resend.com → API Keys. Sending access is enough.",
  },
  {
    key: "email.from_address",
    group: "email",
    type: "string",
    secret: false,
    pattern: MAILBOX,
    patternHint: "an address such as bookings@houzzhills.com or Houzz Hills <bookings@houzzhills.com>",
    minLength: 6,
    maxLength: 200,
    label: "Sender",
    description: "Who emails come from. Its domain must be verified in Resend.",
  },
  {
    key: "email.reply_to",
    group: "email",
    type: "string",
    secret: false,
    pattern: ADDRESS,
    patternHint: "an email address",
    minLength: 6,
    maxLength: 200,
    label: "Reply-to address",
    description: "Where guest replies go, such as the front desk inbox. Optional.",
  },
  {
    key: "email.guest_notifications",
    group: "email",
    type: "enum",
    secret: false,
    ...SWITCH,
    default: "on",
    label: "Guest emails",
    description: "Booking confirmations, payment receipts, check-in, check-out and cancellation notices.",
  },
  {
    key: "email.staff_notifications",
    group: "email",
    type: "enum",
    secret: false,
    ...SWITCH,
    default: "on",
    label: "Staff account emails",
    description: "Welcome emails with temporary passwords, password resets and account security notices.",
  },
  {
    key: "email.management_alerts",
    group: "email",
    type: "enum",
    secret: false,
    ...SWITCH,
    default: "on",
    label: "Management alerts",
    description: "Payment exceptions, transfers to confirm, new online bookings, low stock, cash variances and the daily summary.",
  },
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTINGS)[number]["key"];

export const SETTING_KEYS: readonly SettingKey[] = SETTINGS.map((setting) => setting.key);

export function definitionOf(key: string): SettingDefinition | undefined {
  return (SETTINGS as readonly SettingDefinition[]).find((setting) => setting.key === key);
}

/** The typed, decrypted settings the server works with. */
export type GlobalSettings = Readonly<{
  provider: PaymentProviderName;
  paystackSecretKey: string | null;
  flutterwaveSecretKey: string | null;
  flutterwaveWebhookHash: string | null;
  holdMinutes: number;
  /** 0 when pay later is off. */
  payLaterHours: number;
  maxStayNights: number;
  horizonDays: number;
  bankTransferReviewHours: number;
  email: Readonly<{
    provider: EmailProviderName;
    resendApiKey: string | null;
    from: string | null;
    replyTo: string | null;
    guestNotifications: boolean;
    staffNotifications: boolean;
    managementAlerts: boolean;
  }>;
}>;
