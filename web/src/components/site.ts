import type { BookedRange, PublicApartment } from "@/lib/api";

/** Helpers for the public website. Dates are business dates (YYYY-MM-DD). */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isStay(checkIn: string | null, checkOut: string | null): boolean {
  return Boolean(checkIn && checkOut && ISO_DATE.test(checkIn) && ISO_DATE.test(checkOut) && checkOut > checkIn);
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
}

const shortDate = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Tue, 13 Oct" */
export function stayDate(isoDate: string): string {
  return shortDate.format(Date.parse(`${isoDate}T00:00:00Z`));
}

/** Whether a stay takes any night already booked. Check-out days are free for a new check-in. */
export function overlapsBooked(ranges: readonly BookedRange[], checkIn: string, checkOut: string): boolean {
  return ranges.some((range) => checkIn < range.checkOut && checkOut > range.checkIn);
}

export function coverImage(apartment: PublicApartment) {
  return apartment.images.find((image) => image.isCover) ?? apartment.images[0] ?? null;
}

const HANDOFF_KEY = "hh:booking";

/** Remembers a just-made booking for this tab, so /bookings can open it without asking for the email again. */
export function rememberBooking(reference: string, email: string): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ reference, email }));
  } catch {
    // Private mode or storage blocked: the guest types their email on /bookings instead.
  }
}

/** The email remembered for a booking reference in this tab, if any. */
export function rememberedEmail(reference: string): string | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? "null") as { reference?: string; email?: string } | null;
    return stored?.reference === reference && stored.email ? stored.email : null;
  } catch {
    return null;
  }
}

/** "My bookings" link for one booking. */
export function bookingHref(reference: string): string {
  return `/bookings?reference=${encodeURIComponent(reference)}`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
