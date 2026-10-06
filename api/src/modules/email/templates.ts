import { nightsBetween, BUSINESS_TIMEZONE } from "../../lib/dates.js";
import { EXCEPTION_TITLES, PAYMENT_STATUS_LABELS, ROOM_STATUS_LABELS } from "../reference/labels.js";
import { renderEmail, type Block, type Brand, type EmailContent, type RenderedEmail } from "./layout.js";

/**
 * Every email the system sends. Each template takes the data captured when the
 * message was queued (so it describes the moment of the change, not whatever
 * the row says later) and returns content for the shared layout.
 */

export type Audience = "guest" | "staff" | "management";

/** A reservation as the guest and staff see it in emails. */
export type StaySummary = {
  reference: string;
  /** Only website bookings have a reference the public status page accepts. */
  publicReference: boolean;
  guestName: string;
  roomType: string;
  roomNumber: string | null;
  checkIn: string;
  checkOut: string;
  guests: number;
  amountKobo: string;
  paidKobo: string;
  paymentStatus: string;
};

export type PaymentSummary = { amountKobo: string; method: string; reference: string | null; at: string };

export type TemplateData = {
  "guest.booking_confirmed": { stay: StaySummary };
  "guest.checked_in": { stay: StaySummary };
  "guest.checked_out": { stay: StaySummary };
  "guest.cancelled": { stay: StaySummary };
  "guest.no_show": { stay: StaySummary };
  "guest.hold_expired": { stay: StaySummary };
  "guest.late_payment": { stay: StaySummary; amountKobo: string };
  "guest.payment_received": { stay: StaySummary; payment: PaymentSummary };
  "guest.transfer_pending": { stay: StaySummary; payment: PaymentSummary };
  "staff.welcome": { fullName: string; email: string; roleLabel: string; invitedBy: string; temporaryPassword?: string };
  "staff.password_reset": { fullName: string; email: string; resetBy: string; temporaryPassword?: string };
  "staff.password_changed": { fullName: string; email: string; at: string };
  "staff.status_changed": { fullName: string; status: "active" | "on_leave" | "terminated"; changedBy: string };
  "alert.payment_exception": { kind: string; reference: string | null; provider: string | null; expectedKobo: string | null; receivedKobo: string | null; at: string };
  "alert.transfer_pending": { source: "accommodation" | "restaurant"; reference: string; amountKobo: string; senderReference: string | null; recordedBy: string; guestName: string | null };
  "alert.new_booking": { stay: StaySummary };
  "alert.low_stock": { items: Array<{ name: string; unit: string; quantity: string; reorderLevel: string }>; cause: string };
  "alert.cash_variance": { cashier: string; openingFloatKobo: string; expectedKobo: string; countedKobo: string; varianceKobo: string; closedAt: string };
  "alert.room_out_of_service": { roomNumber: string; status: string; note: string | null; changedBy: string };
  "alert.settings_changed": { changes: string[]; changedBy: string; at: string };
  "alert.daily_summary": DailySummary;
  "system.test": { requestedBy: string };
};

export type DailySummary = {
  date: string;
  arrivals: number;
  departures: number;
  inHouse: number;
  occupancyPercent: number | null;
  roomsOutOfService: number;
  newBookings: number;
  settledYesterdayKobo: string;
  accommodationYesterdayKobo: string;
  restaurantYesterdayKobo: string;
  pendingTransfers: number;
  pendingTransfersKobo: string;
  openExceptions: number;
  lowStockItems: number;
};

export type TemplateName = keyof TemplateData;

export const TEMPLATE_AUDIENCE: Readonly<Record<TemplateName, Audience>> = {
  "guest.booking_confirmed": "guest",
  "guest.checked_in": "guest",
  "guest.checked_out": "guest",
  "guest.cancelled": "guest",
  "guest.no_show": "guest",
  "guest.hold_expired": "guest",
  "guest.late_payment": "guest",
  "guest.payment_received": "guest",
  "guest.transfer_pending": "guest",
  "staff.welcome": "staff",
  "staff.password_reset": "staff",
  "staff.password_changed": "staff",
  "staff.status_changed": "staff",
  "alert.payment_exception": "management",
  "alert.transfer_pending": "management",
  "alert.new_booking": "management",
  "alert.low_stock": "management",
  "alert.cash_variance": "management",
  "alert.room_out_of_service": "management",
  "alert.settings_changed": "management",
  "alert.daily_summary": "management",
  "system.test": "management",
};

export function isTemplateName(value: string): value is TemplateName {
  return Object.hasOwn(TEMPLATE_AUDIENCE, value);
}

export type TemplateContext = {
  brand: Brand;
  recipientName: string | null;
  /** Staff sign-in page, when PUBLIC_WEB_URL is configured. */
  managementUrl: string | null;
  /** Guest-facing booking page, when PUBLIC_WEB_URL is configured. */
  bookingUrl: string | null;
  /** The public payment status page for a website booking reference. */
  statusUrl: (reference: string) => string | null;
};

// ---- Formatting ----

/** Exact naira from integer kobo (no floating point), e.g. ₦12,500.00 or −₦500.00. */
export function naira(kobo: string | number | bigint): string {
  const value = BigInt(kobo);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / 100n).toLocaleString("en-NG");
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}₦${whole}.${fraction}`;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const longDayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const momentFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIMEZONE });

/** A business date (YYYY-MM-DD) such as "Tue, 6 Oct 2026". */
export function day(isoDate: string): string {
  return dayFormat.format(Date.parse(`${isoDate}T00:00:00Z`));
}

function longDay(isoDate: string): string {
  return longDayFormat.format(Date.parse(`${isoDate}T00:00:00Z`));
}

/** An instant in the property's timezone, such as "6 Oct 2026, 14:05 (WAT)". */
export function moment(iso: string): string {
  return `${momentFormat.format(new Date(iso))} (WAT)`;
}

const METHOD_LABELS: Record<string, string> = { cash: "Cash", pos: "POS terminal", bank_transfer: "Bank transfer", online: "Online card payment" };
const PROVIDER_LABELS: Record<string, string> = { paystack: "Paystack", flutterwave: "Flutterwave" };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
function firstName(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return first.length > 0 ? first : "there";
}

function roomLabel(stay: StaySummary): string {
  return stay.roomNumber ? `${stay.roomType} · Room ${stay.roomNumber}` : stay.roomType;
}

function stayRows(stay: StaySummary, options: { money?: boolean } = {}): Array<readonly [string, string]> {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const rows: Array<readonly [string, string]> = [
    ["Booking reference", stay.reference],
    ["Guest", stay.guestName],
    ["Room", roomLabel(stay)],
    ["Check-in", day(stay.checkIn)],
    ["Check-out", day(stay.checkOut)],
    ["Stay", `${plural(nights, "night")} · ${plural(stay.guests, "guest")}`],
  ];
  if (options.money !== false) {
    const balance = BigInt(stay.amountKobo) - BigInt(stay.paidKobo);
    rows.push(["Total", naira(stay.amountKobo)], ["Paid", naira(stay.paidKobo)]);
    if (balance > 0n) rows.push(["Balance due", naira(balance)]);
  }
  return rows;
}

function stayDetails(stay: StaySummary, title = "Your booking"): Block {
  return { kind: "details", title, rows: stayRows(stay) };
}

function statusButton(stay: StaySummary, ctx: TemplateContext): Block[] {
  const url = stay.publicReference ? ctx.statusUrl(stay.reference) : null;
  return url ? [{ kind: "button", label: "View booking status", url }] : [];
}

function workspaceButton(ctx: TemplateContext, label = "Open the workspace"): Block[] {
  return ctx.managementUrl ? [{ kind: "button", label, url: ctx.managementUrl }] : [];
}

const GUEST_REASON = (ctx: TemplateContext) => `You are receiving this because you have a booking with ${ctx.brand.propertyName}.`;
const STAFF_REASON = (ctx: TemplateContext) => `This is an account notice from the ${ctx.brand.propertyName} staff workspace.`;
const ALERT_REASON = (ctx: TemplateContext) =>
  `You receive ${ctx.brand.propertyName} management alerts because of your role. The owner can turn them off in Settings.`;

type Templates = { [K in TemplateName]: (data: TemplateData[K], ctx: TemplateContext) => EmailContent };

const TEMPLATES: Templates = {
  "guest.booking_confirmed": ({ stay }, ctx) => {
    const paid = stay.paymentStatus === "paid";
    return {
      subject: `Booking confirmed · ${day(stay.checkIn)} · ${stay.reference}`,
      preheader: `Your ${stay.roomType} is reserved from ${day(stay.checkIn)} to ${day(stay.checkOut)}.`,
      eyebrow: "Booking confirmed",
      tone: "success",
      heading: `We look forward to welcoming you, ${firstName(stay.guestName)}`,
      blocks: [
        { kind: "paragraph", text: `Your stay at ${ctx.brand.propertyName} is confirmed. Keep this email; your booking reference is ${stay.reference}.` },
        stayDetails(stay),
        paid
          ? { kind: "callout", tone: "success", title: "Fully paid", text: "Your payment has been received. Nothing more is due for the room." }
          : { kind: "callout", tone: "warning", title: "Balance due", text: `${naira(BigInt(stay.amountKobo) - BigInt(stay.paidKobo))} is payable at the front desk on arrival.` },
        { kind: "paragraph", text: "If your plans change or you have any special requests, simply reply to this email and our front desk will help." },
        ...statusButton(stay, ctx),
      ],
      reason: GUEST_REASON(ctx),
    };
  },

  "guest.checked_in": ({ stay }, ctx) => ({
    subject: `Welcome to ${ctx.brand.propertyName}`,
    preheader: `You're checked in to ${roomLabel(stay)} until ${day(stay.checkOut)}.`,
    eyebrow: "Checked in",
    tone: "success",
    heading: `Welcome, ${firstName(stay.guestName)}`,
    blocks: [
      { kind: "paragraph", text: `You're all checked in. We hope you have a restful and pleasant stay with us.` },
      { kind: "details", title: "Your stay", rows: stayRows(stay, { money: false }) },
      ...(BigInt(stay.amountKobo) > BigInt(stay.paidKobo)
        ? [{ kind: "callout", tone: "warning", title: "Outstanding balance", text: `${naira(BigInt(stay.amountKobo) - BigInt(stay.paidKobo))} remains on your room. You can settle it at the front desk at any time.` } as const]
        : []),
      { kind: "paragraph", text: "Need anything during your stay? Reply to this email or call the front desk. Our team is happy to help." },
    ],
    reason: GUEST_REASON(ctx),
  }),

  "guest.checked_out": ({ stay }, ctx) => ({
    subject: `Thank you for staying with us · ${stay.reference}`,
    preheader: `Your stay summary from ${ctx.brand.propertyName}.`,
    eyebrow: "Checked out",
    tone: "neutral",
    heading: `Thank you, ${firstName(stay.guestName)}`,
    blocks: [
      { kind: "paragraph", text: `It was a pleasure hosting you. Here is a summary of your stay for your records.` },
      stayDetails(stay, "Stay summary"),
      { kind: "paragraph", text: "We would love to welcome you back. Safe travels!" },
      ...(ctx.bookingUrl ? [{ kind: "button", label: "Book your next stay", url: ctx.bookingUrl } as const] : []),
    ],
    reason: GUEST_REASON(ctx),
  }),

  "guest.cancelled": ({ stay }, ctx) => ({
    subject: `Booking cancelled · ${stay.reference}`,
    preheader: `Your booking for ${day(stay.checkIn)} has been cancelled.`,
    eyebrow: "Booking cancelled",
    tone: "danger",
    heading: "Your booking has been cancelled",
    blocks: [
      { kind: "paragraph", text: `Dear ${stay.guestName}, your booking ${stay.reference} has been cancelled and the room has been released.` },
      { kind: "details", title: "Cancelled booking", rows: stayRows(stay) },
      {
        kind: "callout",
        tone: "neutral",
        text: "If you did not request this, or you have questions about a payment you made, please reply to this email and our team will get back to you.",
      },
      ...(ctx.bookingUrl ? [{ kind: "button", label: "Make a new booking", url: ctx.bookingUrl } as const] : []),
    ],
    reason: GUEST_REASON(ctx),
  }),

  "guest.no_show": ({ stay }, ctx) => ({
    subject: `We missed you · ${stay.reference}`,
    preheader: `Your booking for ${day(stay.checkIn)} was marked as a no-show.`,
    eyebrow: "No-show",
    tone: "warning",
    heading: "We missed you",
    blocks: [
      { kind: "paragraph", text: `Dear ${stay.guestName}, we were expecting you on ${day(stay.checkIn)}, but you didn't arrive, so your booking has been closed as a no-show.` },
      { kind: "details", title: "Booking", rows: stayRows(stay) },
      { kind: "paragraph", text: "If this is a mistake or your plans have changed, reply to this email and we'll do our best to help." },
    ],
    reason: GUEST_REASON(ctx),
  }),

  "guest.hold_expired": ({ stay }, ctx) => ({
    subject: "Your booking wasn't completed",
    preheader: `We held a ${stay.roomType} for you, but payment wasn't completed in time.`,
    eyebrow: "Booking not completed",
    tone: "warning",
    heading: "Your room hold has expired",
    blocks: [
      {
        kind: "paragraph",
        text: `Hi ${firstName(stay.guestName)}, we held a ${stay.roomType} for ${day(stay.checkIn)} to ${day(stay.checkOut)} while you checked out, but we didn't receive payment in time, so the room has been released.`,
      },
      { kind: "callout", tone: "neutral", text: "No money has been taken for this booking. If your bank shows a charge, reply to this email with your reference and we'll sort it out right away." },
      { kind: "details", title: "Released booking", rows: stayRows(stay, { money: false }) },
      ...(ctx.bookingUrl ? [{ kind: "button", label: "Try booking again", url: ctx.bookingUrl } as const] : []),
    ],
    reason: GUEST_REASON(ctx),
  }),

  "guest.late_payment": ({ stay, amountKobo }, ctx) => ({
    subject: `We received your payment · ${stay.reference}`,
    preheader: "Your payment arrived after the room hold expired. Our team will contact you.",
    eyebrow: "Payment received",
    tone: "warning",
    heading: "Your payment arrived after the hold expired",
    blocks: [
      {
        kind: "paragraph",
        text: `Hi ${firstName(stay.guestName)}, we received your payment of ${naira(amountKobo)}, but it reached us after your room hold had expired, so we couldn't confirm the booking automatically.`,
      },
      { kind: "callout", tone: "warning", title: "No action needed from you", text: "Your payment is safely recorded. A member of our team will contact you shortly to confirm your room or agree the next steps with you." },
      { kind: "details", title: "Booking", rows: stayRows(stay, { money: false }) },
    ],
    reason: GUEST_REASON(ctx),
  }),

  "guest.payment_received": ({ stay, payment }, ctx) => {
    const balance = BigInt(stay.amountKobo) - BigInt(stay.paidKobo);
    return {
      subject: `Payment receipt · ${naira(payment.amountKobo)} · ${stay.reference}`,
      preheader: balance > 0n ? `${naira(balance)} remains on your booking.` : "Your booking is fully paid.",
      eyebrow: "Payment receipt",
      tone: "success",
      heading: `Thank you, we received ${naira(payment.amountKobo)}`,
      blocks: [
        { kind: "paragraph", text: `Hi ${firstName(stay.guestName)}, this is your receipt for a payment towards booking ${stay.reference}.` },
        {
          kind: "details",
          title: "Receipt",
          rows: [
            ["Date", moment(payment.at)],
            ["Method", METHOD_LABELS[payment.method] ?? payment.method],
            ...(payment.reference ? [["Payment reference", payment.reference] as const] : []),
            ["Amount received", naira(payment.amountKobo)],
          ],
          total: true,
        },
        stayDetails(stay),
        balance > 0n
          ? { kind: "callout", tone: "warning", title: "Balance due", text: `${naira(balance)} is still due. You can pay at the front desk.` }
          : { kind: "callout", tone: "success", title: "Fully paid", text: "Your booking is fully paid. Thank you!" },
        ...statusButton(stay, ctx),
      ],
      reason: GUEST_REASON(ctx),
    };
  },

  "guest.transfer_pending": ({ stay, payment }, ctx) => ({
    subject: `Bank transfer received for verification · ${stay.reference}`,
    preheader: `We're verifying your transfer of ${naira(payment.amountKobo)}.`,
    eyebrow: "Transfer being verified",
    tone: "warning",
    heading: "We're verifying your bank transfer",
    blocks: [
      {
        kind: "paragraph",
        text: `Hi ${firstName(stay.guestName)}, we've recorded your bank transfer of ${naira(payment.amountKobo)}. Our accounts team will confirm it as soon as it reaches our account, and we'll email you a receipt.`,
      },
      {
        kind: "details",
        title: "Transfer",
        rows: [["Recorded", moment(payment.at)], ...(payment.reference ? [["Sender / reference", payment.reference] as const] : []), ["Amount", naira(payment.amountKobo)]],
      },
      { kind: "details", title: "Booking", rows: stayRows(stay, { money: false }) },
    ],
    reason: GUEST_REASON(ctx),
  }),

  "staff.welcome": (data, ctx) => ({
    subject: `Your ${ctx.brand.propertyName} staff account`,
    preheader: `${data.invitedBy} created a ${data.roleLabel} account for you.`,
    eyebrow: "Welcome to the team",
    tone: "success",
    heading: `Welcome aboard, ${firstName(data.fullName)}`,
    blocks: [
      { kind: "paragraph", text: `${data.invitedBy} has created your ${ctx.brand.propertyName} workspace account. You'll use it for your daily work as ${data.roleLabel}.` },
      { kind: "details", rows: [["Sign-in email", data.email], ["Role", data.roleLabel]] },
      ...(data.temporaryPassword
        ? [{ kind: "code", label: "Temporary password", value: data.temporaryPassword } as const]
        : [{ kind: "paragraph", text: `${data.invitedBy} will give you your temporary password.` } as const]),
      { kind: "callout", tone: "neutral", title: "First sign-in", text: "You'll be asked to choose your own password straight away. Never share your password with anyone, including managers." },
      ...workspaceButton(ctx, "Sign in"),
    ],
    reason: STAFF_REASON(ctx),
  }),

  "staff.password_reset": (data, ctx) => ({
    subject: "Your password has been reset",
    preheader: `${data.resetBy} issued you a temporary password.`,
    eyebrow: "Password reset",
    tone: "warning",
    heading: "Your password has been reset",
    blocks: [
      { kind: "paragraph", text: `Hi ${firstName(data.fullName)}, ${data.resetBy} reset the password for ${data.email}. You've been signed out everywhere.` },
      ...(data.temporaryPassword ? [{ kind: "code", label: "Temporary password", value: data.temporaryPassword } as const] : []),
      { kind: "paragraph", text: "Sign in with this temporary password and you'll be asked to choose a new one." },
      ...workspaceButton(ctx, "Sign in"),
      { kind: "callout", tone: "danger", title: "Didn't expect this?", text: "Tell the owner or your manager straight away." },
    ],
    reason: STAFF_REASON(ctx),
  }),

  "staff.password_changed": (data, ctx) => ({
    subject: "Your password was changed",
    preheader: `The password for ${data.email} was changed on ${moment(data.at)}.`,
    eyebrow: "Security notice",
    tone: "neutral",
    heading: "Your password was changed",
    blocks: [
      { kind: "paragraph", text: `Hi ${firstName(data.fullName)}, the password for your ${ctx.brand.propertyName} account (${data.email}) was changed on ${moment(data.at)}. Other devices have been signed out.` },
      { kind: "callout", tone: "danger", title: "Wasn't you?", text: "Contact the owner or your manager immediately so they can reset your password and secure your account." },
    ],
    reason: STAFF_REASON(ctx),
  }),

  "staff.status_changed": (data, ctx) => {
    const copy = {
      active: { eyebrow: "Account reactivated", tone: "success", heading: "Your account is active again", text: "You can sign in to the workspace again." },
      on_leave: { eyebrow: "On leave", tone: "neutral", heading: "Your account is paused while you're on leave", text: "Your sign-in is paused until you return. Enjoy your time off." },
      terminated: { eyebrow: "Account closed", tone: "neutral", heading: "Your workspace account has been closed", text: "Your access to the workspace has ended. Thank you for your work with us." },
    } as const;
    const entry = copy[data.status];
    return {
      subject: entry.heading,
      preheader: `${data.changedBy} updated your employment status.`,
      eyebrow: entry.eyebrow,
      tone: entry.tone,
      heading: entry.heading,
      blocks: [
        { kind: "paragraph", text: `Hi ${firstName(data.fullName)}, ${data.changedBy} updated your status at ${ctx.brand.propertyName}. ${entry.text}` },
        ...(data.status === "active" ? workspaceButton(ctx, "Sign in") : []),
        { kind: "paragraph", text: "If you have questions, please speak with your manager." },
      ],
      reason: STAFF_REASON(ctx),
    };
  },

  "alert.payment_exception": (data, ctx) => {
    const title = EXCEPTION_TITLES[data.kind] ?? data.kind;
    const rows: Array<readonly [string, string]> = [["Issue", title], ["Detected", moment(data.at)]];
    if (data.reference) rows.push(["Reference", data.reference]);
    if (data.provider) rows.push(["Provider", PROVIDER_LABELS[data.provider] ?? data.provider]);
    if (data.expectedKobo !== null) rows.push(["Expected", naira(data.expectedKobo)]);
    if (data.receivedKobo !== null) rows.push(["Received", naira(data.receivedKobo)]);
    return {
      subject: `Action needed: ${title}${data.reference ? ` · ${data.reference}` : ""}`,
      preheader: "A payment needs a person to review it in the exception queue.",
      eyebrow: "Payment exception",
      tone: "danger",
      heading: title,
      blocks: [
        { kind: "paragraph", text: `Hi ${firstName(ctx.recipientName)}, a payment needs review. Nothing has been refunded or changed automatically, so please decide what to do and record it in the exception queue.` },
        { kind: "details", rows },
        ...workspaceButton(ctx, "Review the exception"),
      ],
      reason: ALERT_REASON(ctx),
    };
  },

  "alert.transfer_pending": (data, ctx) => ({
    subject: `Confirm bank transfer · ${naira(data.amountKobo)} · ${data.reference}`,
    preheader: `${data.recordedBy} recorded a bank transfer that needs confirming.`,
    eyebrow: "Transfer to confirm",
    tone: "warning",
    heading: `A ${naira(data.amountKobo)} bank transfer needs confirming`,
    blocks: [
      { kind: "paragraph", text: `Hi ${firstName(ctx.recipientName)}, please check the company account and confirm this transfer once the money has arrived. It doesn't count as revenue until it's confirmed.` },
      {
        kind: "details",
        rows: [
          ["For", data.source === "accommodation" ? `Booking ${data.reference}` : `Restaurant receipt ${data.reference}`],
          ...(data.guestName ? [["Guest", data.guestName] as const] : []),
          ["Sender / reference", data.senderReference ?? "Not given"],
          ["Recorded by", data.recordedBy],
          ["Amount", naira(data.amountKobo)],
        ],
        total: true,
      },
      ...workspaceButton(ctx, "Open the payment register"),
    ],
    reason: ALERT_REASON(ctx),
  }),

  "alert.new_booking": ({ stay }, ctx) => ({
    subject: `New online booking · ${roomLabel(stay)} · ${day(stay.checkIn)}`,
    preheader: `${stay.guestName} booked and paid ${naira(stay.paidKobo)} online.`,
    eyebrow: "New online booking",
    tone: "success",
    heading: `${stay.guestName} booked online`,
    blocks: [
      { kind: "paragraph", text: `A guest has booked and paid through the website. The room is confirmed and assigned.` },
      { kind: "details", rows: [...stayRows(stay), ["Payment", PAYMENT_STATUS_LABELS[stay.paymentStatus as keyof typeof PAYMENT_STATUS_LABELS] ?? stay.paymentStatus]] },
      ...workspaceButton(ctx, "View reservations"),
    ],
    reason: ALERT_REASON(ctx),
  }),

  "alert.low_stock": (data, ctx) => {
    const out = data.items.filter((item) => Number(item.quantity) <= 0);
    const first = data.items[0];
    return {
      subject:
        data.items.length === 1 && first
          ? `${Number(first.quantity) <= 0 ? "Out of stock" : "Low stock"}: ${first.name}`
          : `Low stock: ${data.items.length} items need reordering`,
      preheader: `${data.items.map((item) => item.name).join(", ")} reached the reorder level.`,
      eyebrow: out.length > 0 ? "Out of stock" : "Low stock",
      tone: out.length > 0 ? "danger" : "warning",
      heading: data.items.length === 1 ? "An item needs reordering" : `${data.items.length} items need reordering`,
      blocks: [
        { kind: "paragraph", text: `Hi ${firstName(ctx.recipientName)}, stock fell to or below the reorder level after ${data.cause}.` },
        { kind: "table", headers: ["Item", "In stock", "Reorder at"], rows: data.items.map((item) => [item.name, `${item.quantity} ${item.unit}`, `${item.reorderLevel} ${item.unit}`]) },
        ...(out.length > 0 ? [{ kind: "callout", tone: "danger", text: `${out.map((item) => item.name).join(", ")} ${out.length === 1 ? "is" : "are"} out of stock; menu items that use ${out.length === 1 ? "it" : "them"} can't be sold until restocked.` } as const] : []),
        ...workspaceButton(ctx, "Open inventory"),
      ],
      reason: ALERT_REASON(ctx),
    };
  },

  "alert.cash_variance": (data, ctx) => {
    const short = BigInt(data.varianceKobo) < 0n;
    return {
      subject: `Cash ${short ? "shortage" : "overage"} of ${naira(short ? -BigInt(data.varianceKobo) : data.varianceKobo)} · ${data.cashier}`,
      preheader: `${data.cashier}'s shift closed with a cash variance.`,
      eyebrow: "Cash variance",
      tone: short ? "danger" : "warning",
      heading: `${data.cashier}'s drawer was ${short ? "short" : "over"}`,
      blocks: [
        { kind: "paragraph", text: `Hi ${firstName(ctx.recipientName)}, a restaurant cashier shift closed on ${moment(data.closedAt)} and the counted cash didn't match what was expected.` },
        {
          kind: "details",
          rows: [
            ["Cashier", data.cashier],
            ["Opening float", naira(data.openingFloatKobo)],
            ["Expected in drawer", naira(data.expectedKobo)],
            ["Counted", naira(data.countedKobo)],
            ["Variance", naira(data.varianceKobo)],
          ],
          total: true,
        },
        ...workspaceButton(ctx, "Review the shift"),
      ],
      reason: ALERT_REASON(ctx),
    };
  },

  "alert.room_out_of_service": (data, ctx) => {
    const status = ROOM_STATUS_LABELS[data.status as keyof typeof ROOM_STATUS_LABELS] ?? data.status;
    return {
      subject: `Room ${data.roomNumber} is ${status.toLowerCase()}`,
      preheader: `${data.changedBy} took Room ${data.roomNumber} out of service.`,
      eyebrow: "Room out of service",
      tone: "warning",
      heading: `Room ${data.roomNumber} can't be sold`,
      blocks: [
        { kind: "paragraph", text: `Hi ${firstName(ctx.recipientName)}, ${data.changedBy} set Room ${data.roomNumber} to ${status.toLowerCase()}. It won't be offered to guests until it's back in service.` },
        { kind: "details", rows: [["Room", data.roomNumber], ["Status", status], ["Note", data.note ?? "None given"], ["Changed by", data.changedBy]] },
        ...workspaceButton(ctx, "View rooms"),
      ],
      reason: ALERT_REASON(ctx),
    };
  },

  "alert.settings_changed": (data, ctx) => ({
    subject: "Security notice: settings changed",
    preheader: `${data.changedBy} changed ${data.changes.join(", ")}.`,
    eyebrow: "Security notice",
    tone: "warning",
    heading: "Sensitive settings were changed",
    blocks: [
      { kind: "paragraph", text: `Hi ${firstName(ctx.recipientName)}, ${data.changedBy} changed these settings on ${moment(data.at)}:` },
      { kind: "details", rows: data.changes.map((change) => ["Changed", change] as const) },
      { kind: "callout", tone: "danger", title: "Didn't make this change?", text: "Sign in now, re-enter your payment and email keys, and change your password." },
      ...workspaceButton(ctx, "Open settings"),
    ],
    reason: `This security notice goes to every ${ctx.brand.propertyName} owner and cannot be turned off.`,
  }),

  "alert.daily_summary": (data, ctx) => ({
    subject: `Daily summary · ${day(data.date)}`,
    preheader: `${plural(data.arrivals, "arrival")}, ${plural(data.departures, "departure")}, ${naira(data.settledYesterdayKobo)} received yesterday.`,
    eyebrow: "Daily summary",
    tone: data.openExceptions > 0 ? "warning" : "neutral",
    heading: longDay(data.date),
    blocks: [
      { kind: "paragraph", text: `Good morning ${firstName(ctx.recipientName)}, here's where ${ctx.brand.propertyName} stands today.` },
      {
        kind: "details",
        title: "Today",
        rows: [
          ["Arrivals", String(data.arrivals)],
          ["Departures", String(data.departures)],
          ["Guests in house", String(data.inHouse)],
          ["Occupancy tonight", data.occupancyPercent === null ? "No rooms" : `${data.occupancyPercent}%`],
          ["Rooms out of service", String(data.roomsOutOfService)],
        ],
      },
      {
        kind: "details",
        title: "Yesterday",
        rows: [
          ["New bookings", String(data.newBookings)],
          ["Accommodation received", naira(data.accommodationYesterdayKobo)],
          ["Restaurant received", naira(data.restaurantYesterdayKobo)],
          ["Total received", naira(data.settledYesterdayKobo)],
        ],
        total: true,
      },
      ...(data.openExceptions + data.pendingTransfers + data.lowStockItems > 0
        ? [
            {
              kind: "callout",
              tone: "warning",
              title: "Needs attention",
              text: [
                data.openExceptions > 0 ? `${plural(data.openExceptions, "payment exception")} open` : null,
                data.pendingTransfers > 0 ? `${plural(data.pendingTransfers, "bank transfer")} (${naira(data.pendingTransfersKobo)}) awaiting confirmation` : null,
                data.lowStockItems > 0 ? `${plural(data.lowStockItems, "stock item")} at or below the reorder level` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            } as const,
          ]
        : [{ kind: "callout", tone: "success", text: "Nothing needs attention: no open exceptions, unconfirmed transfers or low stock." } as const]),
      ...workspaceButton(ctx),
    ],
    reason: ALERT_REASON(ctx),
  }),

  "system.test": (data, ctx) => ({
    subject: `Test email from ${ctx.brand.propertyName}`,
    preheader: "Your email settings work.",
    eyebrow: "Email is working",
    tone: "success",
    heading: "Your email settings work",
    blocks: [
      { kind: "paragraph", text: `${data.requestedBy} sent this test from Settings. Guests, staff and managers will now receive emails like this one.` },
      { kind: "callout", tone: "neutral", text: "If this landed in spam, add SPF, DKIM and DMARC records for your sending domain in Resend, then mark this message as not spam." },
    ],
    reason: `Sent from ${ctx.brand.propertyName} Settings.`,
  }),
};

export function renderTemplate(name: TemplateName, data: unknown, ctx: TemplateContext): RenderedEmail {
  const template = TEMPLATES[name] as (data: unknown, ctx: TemplateContext) => EmailContent;
  return renderEmail(template(data, ctx), ctx.brand);
}
