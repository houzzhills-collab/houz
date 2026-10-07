"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BedDouble, CalendarDays, Users } from "lucide-react";
import Link from "next/link";
import { api, errorMessage, type AvailableRoomType, type PaymentOption, type Property } from "@/lib/api";
import { bookingHref, plural, rememberBooking } from "@/components/site";
import { applyProperty, money, propertyDate } from "../management/workspace/format";

type Search = { checkIn: string; checkOut: string; guests: number };

function nights(search: Search): number {
  return Math.round((Date.parse(search.checkOut) - Date.parse(search.checkIn)) / 86_400_000);
}

/** Public booking: availability, guest details, then the provider's hosted checkout or a pay-later hold. */
export default function ReservePage() {
  const [property, setProperty] = useState<Property | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [results, setResults] = useState<AvailableRoomType[] | null>(null);
  const [chosen, setChosen] = useState<AvailableRoomType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<PaymentOption>("pay_now");
  // One key per booking attempt, so a double-click or retry never creates a second booking or charge.
  const attemptKey = useRef<{ option: PaymentOption; value: string } | null>(null);
  const payLaterHours = property?.payLaterHours ?? 0;
  const option: PaymentOption = payLaterHours > 0 ? choice : "pay_now";

  // Name, timezone and currency come from the API; dates default to the property's tomorrow.
  useEffect(() => {
    api.publicBooking
      .property()
      .then((loaded) => {
        applyProperty(loaded);
        setProperty(loaded);
        setSearch({ checkIn: propertyDate(1), checkOut: propertyDate(3), guests: 2 });
      })
      .catch((caught: unknown) => setError(errorMessage(caught, "Online booking is not available right now")));
  }, []);

  const find = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!search) return;
    setError("");
    setChosen(null);
    if (nights(search) < 1) {
      setError("Check-out must be after check-in.");
      return;
    }
    setBusy(true);
    try {
      setResults(await api.publicBooking.availability(search));
    } catch (caught) {
      setError(errorMessage(caught, "Unable to check availability"));
    } finally {
      setBusy(false);
    }
  };

  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen || !search) return;
    const values = new FormData(event.currentTarget);
    const field = (name: string) => String(values.get(name) ?? "").trim();
    setBusy(true);
    setError("");
    try {
      if (attemptKey.current?.option !== option) attemptKey.current = { option, value: crypto.randomUUID() };
      const booking = await api.publicBooking.reserve(
        {
          name: field("name"),
          email: field("email"),
          ...(field("phone") ? { phone: field("phone") } : {}),
          roomType: chosen.room_type,
          checkIn: search.checkIn,
          checkOut: search.checkOut,
          guests: search.guests,
          ...(field("notes") ? { notes: field("notes") } : {}),
          paymentOption: option,
        },
        attemptKey.current.value,
      );
      if (booking.checkoutUrl) {
        window.location.assign(booking.checkoutUrl);
        return;
      }
      rememberBooking(booking.reservation.reference, field("email"));
      window.location.assign(bookingHref(booking.reservation.reference));
    } catch (caught) {
      setError(errorMessage(caught, "We could not start your booking"));
      setBusy(false);
    }
  };

  return (
    <div className="public-shell">
      <header className="public-header">
        <div className="brand-mark">
          H<span>.</span>
        </div>
        <div>
          <strong>{property?.name ?? ""}</strong>
          <small>Book online</small>
        </div>
      </header>
      <main className="public-main">
        <h1>Book your stay</h1>
        <p className="auth-copy">
          Choose your dates, pick a room and pay securely online{payLaterHours > 0 ? ", or reserve now and pay later" : ""}. Already booked? <Link href="/bookings">Find your booking</Link>.
        </p>
        {error && <div className="form-error">{error}</div>}
        {!search && !error && <div className="empty-state">Loading…</div>}

        {search && (
        <form className="public-card search-card" onSubmit={(event) => void find(event)}>
          <label className="form-field">
            <span>
              <CalendarDays size={13} /> Check in
            </span>
            <input type="date" min={propertyDate(0)} value={search.checkIn} onChange={(event) => setSearch({ ...search, checkIn: event.target.value })} required />
          </label>
          <label className="form-field">
            <span>
              <CalendarDays size={13} /> Check out
            </span>
            <input type="date" min={search.checkIn} value={search.checkOut} onChange={(event) => setSearch({ ...search, checkOut: event.target.value })} required />
          </label>
          <label className="form-field">
            <span>
              <Users size={13} /> Guests
            </span>
            <input type="number" min={1} max={12} value={search.guests} onChange={(event) => setSearch({ ...search, guests: Number(event.target.value) })} required />
          </label>
          <button className="button-primary" disabled={busy}>
            {busy && !chosen ? "Checking…" : "Check availability"}
          </button>
        </form>
        )}

        {results && search && (
          <section className="room-results">
            {results.length === 0 && <div className="empty-state">No rooms are free for those dates. Try different dates or contact the property.</div>}
            {results.map((type) => (
              <article key={type.room_type} className={`public-card room-option ${chosen?.room_type === type.room_type ? "selected" : ""}`}>
                <div>
                  <h2>
                    <BedDouble size={16} /> {type.room_type}
                  </h2>
                  <p>
                    Sleeps up to {type.capacity} · {type.available_count} available
                  </p>
                </div>
                <div className="room-price">
                  <strong>{money(BigInt(type.nightly_rate_kobo) * BigInt(nights(search)))}</strong>
                  <small>
                    {money(type.nightly_rate_kobo)} × {nights(search)} night{nights(search) === 1 ? "" : "s"}
                  </small>
                  <button className="button-secondary" onClick={() => setChosen(type)} type="button">
                    {chosen?.room_type === type.room_type ? "Selected" : "Select"}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}

        {chosen && search && (
          <form className="public-card guest-card" onSubmit={(event) => void book(event)}>
            <h2>Your details</h2>
            <div className="form-row">
              <label className="form-field">
                <span>Full name</span>
                <input name="name" autoComplete="name" required maxLength={120} />
              </label>
              <label className="form-field">
                <span>Email (for your receipt)</span>
                <input name="email" type="email" autoComplete="email" required maxLength={254} />
              </label>
            </div>
            <div className="form-row">
              <label className="form-field">
                <span>Phone</span>
                <input name="phone" type="tel" autoComplete="tel" maxLength={32} pattern="[\+0-9 \(\)\-]*" />
              </label>
              <label className="form-field">
                <span>Notes (optional)</span>
                <input name="notes" maxLength={2000} />
              </label>
            </div>
            {payLaterHours > 0 && (
              <fieldset className="pay-options">
                <legend>How would you like to pay?</legend>
                <label className={option === "pay_now" ? "selected" : ""}>
                  <input type="radio" name="paymentOption" value="pay_now" checked={option === "pay_now"} onChange={() => setChoice("pay_now")} />
                  <span>
                    <strong>Pay now</strong>
                    <small>Confirmed as soon as you pay</small>
                  </span>
                </label>
                <label className={option === "pay_later" ? "selected" : ""}>
                  <input type="radio" name="paymentOption" value="pay_later" checked={option === "pay_later"} onChange={() => setChoice("pay_later")} />
                  <span>
                    <strong>Pay later</strong>
                    <small>Held for {plural(payLaterHours, "hour")}</small>
                  </span>
                </label>
              </fieldset>
            )}
            <button className="button-primary auth-submit" disabled={busy}>
              {option === "pay_later" ? (busy ? "Reserving…" : "Reserve now, pay later") : busy ? "Opening secure checkout…" : "Continue to secure payment"} <ArrowRight size={15} />
            </button>
            <p className="modal-help">
              {option === "pay_later"
                ? `We hold your room for ${plural(payLaterHours, "hour")} and email your booking reference and receipt. Pay the full stay of ${money(BigInt(chosen.nightly_rate_kobo) * BigInt(nights(search)))} before then from My bookings; unpaid bookings are released automatically.`
                : `You will pay the full stay of ${money(BigInt(chosen.nightly_rate_kobo) * BigInt(nights(search)))} on the payment provider's page.`}{" "}
              Bookings are non-refundable.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
