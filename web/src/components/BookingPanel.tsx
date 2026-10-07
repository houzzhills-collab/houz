"use client";

import { useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, CalendarDays, CheckCircle2, ShieldCheck, Users, XCircle } from "lucide-react";
import { api, errorMessage, type BookedRange, type PublicApartment } from "@/lib/api";
import { money, propertyDate } from "@/app/management/workspace/format";
import { isStay, nightsBetween, overlapsBooked, plural, stayDate } from "@/components/site";

type Stay = { checkIn: string; checkOut: string; guests: number };
type Check = { key: string; available: boolean };

const stayKey = (stay: Stay) => `${stay.checkIn}/${stay.checkOut}/${stay.guests}`;

/** Dates, a live availability check, guest details, then the payment provider's hosted checkout. */
export default function BookingPanel({ apartment, bookedRanges, initial }: { apartment: PublicApartment; bookedRanges: BookedRange[]; initial: { checkIn: string; checkOut: string } | null }) {
  const { capacity, stayRules, pricing } = apartment;
  const [stay, setStay] = useState<Stay>({ checkIn: initial?.checkIn ?? "", checkOut: initial?.checkOut ?? "", guests: Math.min(2, capacity.maxGuests) });
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per booking attempt, so a double-click or retry never creates a second booking or charge.
  const attemptKey = useRef<{ key: string; value: string } | null>(null);

  const today = propertyDate(0);
  const valid = isStay(stay.checkIn, stay.checkOut);
  const nights = valid ? nightsBetween(stay.checkIn, stay.checkOut) : 0;
  const total = valid ? BigInt(pricing.nightlyRateKobo) * BigInt(nights) : 0n;
  const caution = BigInt(pricing.cautionFeeKobo);
  // Problems we can see before asking the server.
  const problem = !valid
    ? stay.checkIn && stay.checkOut ? "Check-out must be after check-in." : ""
    : stay.checkIn < today
      ? "Choose a check-in date from today onwards."
      : nights < stayRules.minimumNights
        ? `This apartment has a minimum stay of ${plural(stayRules.minimumNights, "night")}.`
        : overlapsBooked(bookedRanges, stay.checkIn, stay.checkOut)
          ? "Some of these nights are already booked. Try other dates."
          : "";
  const confirmed = check?.key === stayKey(stay) ? check : null;
  const upcoming = bookedRanges.filter((range) => range.checkOut > today).slice(0, 6);

  const change = (next: Partial<Stay>) => {
    setStay((current) => ({ ...current, ...next }));
    setError("");
  };

  const checkAvailability = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || problem) return;
    setBusy(true);
    setError("");
    try {
      const free = await api.publicBooking.apartments(stay);
      setCheck({ key: stayKey(stay), available: free.some((item) => item.id === apartment.id) });
    } catch (caught) {
      setError(errorMessage(caught, "Unable to check availability"));
    } finally {
      setBusy(false);
    }
  };

  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const field = (name: string) => String(values.get(name) ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const key = stayKey(stay);
      if (attemptKey.current?.key !== key) attemptKey.current = { key, value: crypto.randomUUID() };
      const booking = await api.publicBooking.reserve(
        {
          name: field("name"),
          email: field("email"),
          ...(field("phone") ? { phone: field("phone") } : {}),
          roomType: apartment.bookingRoomType,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          guests: stay.guests,
          ...(field("notes") ? { notes: field("notes") } : {}),
        },
        attemptKey.current.value,
      );
      window.location.assign(booking.checkoutUrl);
    } catch (caught) {
      setError(errorMessage(caught, "We could not start your booking"));
      setBusy(false);
    }
  };

  const input = "min-w-0 w-full bg-transparent text-sm font-semibold text-[#202b28] outline-none";
  const label = "mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[.16em] text-stone-500";
  const field = "block rounded-2xl border border-[#e6dfd2] bg-white px-4 py-3 text-sm text-[#202b28] outline-none placeholder:text-stone-400 focus:border-[#b28247]";

  return (
    <div id="book" className="scroll-mt-6 rounded-[28px] border border-[#e6dfd2] bg-white p-6 shadow-[0_18px_40px_rgb(38_59_52/8%)]">
      <p>
        <b className="font-serif text-3xl text-[#263b34]">{money(pricing.nightlyRateKobo)}</b>
        <span className="text-sm text-stone-500"> / night</span>
      </p>

      <form onSubmit={(event) => void checkAvailability(event)} className="mt-6">
        <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-[#e6dfd2]">
          <label className="min-w-0 border-b border-r border-[#e6dfd2] p-4">
            <span className={label}>
              <CalendarDays size={13} /> Check in
            </span>
            <input aria-label="Check in date" required type="date" min={today} value={stay.checkIn} onChange={(event) => change({ checkIn: event.target.value })} className={input} />
          </label>
          <label className="min-w-0 border-b border-[#e6dfd2] p-4">
            <span className={label}>
              <CalendarDays size={13} /> Check out
            </span>
            <input aria-label="Check out date" required type="date" min={stay.checkIn || today} value={stay.checkOut} onChange={(event) => change({ checkOut: event.target.value })} className={input} />
          </label>
          <label className="col-span-2 min-w-0 p-4">
            <span className={label}>
              <Users size={13} /> Guests
            </span>
            <select value={stay.guests} onChange={(event) => change({ guests: Number(event.target.value) })} className={input}>
              {Array.from({ length: capacity.maxGuests }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {plural(count, "guest")}
                </option>
              ))}
            </select>
          </label>
        </div>

        {problem && <p className="mt-3 rounded-xl bg-[#fbf1ec] px-4 py-2.5 text-xs text-[#a35f53]">{problem}</p>}

        {valid && !problem && (
          <dl className="mt-5 space-y-2 text-sm text-stone-600">
            <div className="flex justify-between">
              <dt>
                {money(pricing.nightlyRateKobo)} × {plural(nights, "night")}
              </dt>
              <dd>{money(total)}</dd>
            </div>
            <div className="flex justify-between border-t border-[#efeadf] pt-2 font-semibold text-[#263b34]">
              <dt>Total</dt>
              <dd>{money(total)}</dd>
            </div>
            {caution > 0n && (
              <div className="flex justify-between text-xs text-stone-500">
                <dt>Caution fee (separate from the total)</dt>
                <dd>{money(caution)}</dd>
              </div>
            )}
          </dl>
        )}

        {!confirmed && (
          <button type="submit" disabled={busy || !valid || Boolean(problem)} className="mt-5 flex w-full items-center justify-between rounded-full bg-[#263b34] px-6 py-4 text-sm font-semibold text-white hover:bg-[#1a2c26] disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? "Checking…" : "Check availability"} <ArrowUpRight size={16} />
          </button>
        )}
      </form>

      {confirmed && !confirmed.available && (
        <p className="mt-5 flex gap-2 rounded-xl bg-[#fbf1ec] px-4 py-3 text-xs leading-5 text-[#a35f53]">
          <XCircle size={16} className="shrink-0" /> Not available for {stayDate(stay.checkIn)} – {stayDate(stay.checkOut)}. Try other dates.
        </p>
      )}

      {confirmed?.available && (
        <form onSubmit={(event) => void book(event)} className="mt-5 space-y-3">
          <p className="flex items-center gap-2 rounded-xl bg-[#eef5f1] px-4 py-3 text-xs font-semibold text-[#31715d]">
            <CheckCircle2 size={16} /> Available · {stayDate(stay.checkIn)} – {stayDate(stay.checkOut)}
          </p>
          <input name="name" aria-label="Full name" placeholder="Full name" autoComplete="name" required maxLength={120} className={`${field} w-full`} />
          <input name="email" aria-label="Email" placeholder="Email (for your confirmation)" type="email" autoComplete="email" required maxLength={254} className={`${field} w-full`} />
          <input name="phone" aria-label="Phone" placeholder="Phone (optional)" type="tel" autoComplete="tel" maxLength={32} pattern="[\+0-9 \(\)\-]*" className={`${field} w-full`} />
          <textarea name="notes" aria-label="Notes" placeholder="Anything we should know? (optional)" rows={2} maxLength={2000} className={`${field} w-full resize-none`} />
          <button type="submit" disabled={busy} className="flex w-full items-center justify-between rounded-full bg-[#dfb56f] px-6 py-4 text-sm font-semibold text-[#263b34] hover:bg-[#edc98e] disabled:opacity-60">
            {busy ? "Opening secure checkout…" : `Book and pay ${money(total)}`} <ArrowRight size={16} />
          </button>
          <p className="flex gap-2 text-[11px] leading-5 text-stone-500">
            <ShieldCheck size={15} className="shrink-0 text-[#31715d]" /> You&apos;ll pay securely on our payment partner&apos;s page. Your dates are held while you pay, and we email your confirmation.
          </p>
        </form>
      )}

      {error && <p className="mt-4 rounded-xl bg-[#fbf1ec] px-4 py-2.5 text-xs text-[#a35f53]">{error}</p>}

      {upcoming.length > 0 && (
        <div className="mt-6 border-t border-[#efeadf] pt-5">
          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#b28247]">Already booked</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {upcoming.map((range) => (
              <span key={range.checkIn} className="rounded-full bg-[#f4f0e8] px-3 py-1.5 text-[11px] text-stone-600">
                {stayDate(range.checkIn)} – {stayDate(range.checkOut)}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-stone-400">Check-out days are free for a new arrival.</p>
        </div>
      )}
    </div>
  );
}
