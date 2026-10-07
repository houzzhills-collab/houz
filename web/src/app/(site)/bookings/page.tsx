"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, Clock3, CreditCard, LogOut, Mail, Printer, Search } from "lucide-react";
import { api, ApiError, errorMessage, type GuestBooking } from "@/lib/api";
import { applyProperty, dateTimeLabel, money } from "@/app/management/workspace/format";
import SiteFooter from "@/components/SiteFooter";
import SiteNav from "@/components/SiteNav";
import { plural, rememberedEmail } from "@/components/site";

/**
 * "My bookings" for guests, with no account: open one booking with its
 * reference and email, or get a one-time code by email to see them all.
 * The guest session lives in this tab only (sessionStorage) and lasts 30 minutes.
 */

type Session = { token: string; email: string; expiresAt: string };
type View = { kind: "find" } | { kind: "code"; email: string } | { kind: "list" } | { kind: "booking"; booking: GuestBooking };

const SESSION_KEY = "hh:guest-session";

function loadSession(): Session | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    return stored && Date.parse(stored.expiresAt) > Date.now() ? stored : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: the session simply lasts until the page is closed.
  }
}

const STATUS: Record<string, { label: string; tone: string }> = {
  hold: { label: "On hold", tone: "bg-[#fbf1df] text-[#94621f]" },
  pending_payment: { label: "Awaiting payment", tone: "bg-[#fbf1df] text-[#94621f]" },
  confirmed: { label: "Confirmed", tone: "bg-[#eef5f1] text-[#31715d]" },
  checked_in: { label: "Checked in", tone: "bg-[#eef5f1] text-[#31715d]" },
  checked_out: { label: "Completed", tone: "bg-[#f1efe9] text-stone-600" },
  cancelled: { label: "Cancelled", tone: "bg-[#fbf1ec] text-[#a35f53]" },
  no_show: { label: "No-show", tone: "bg-[#fbf1ec] text-[#a35f53]" },
  expired: { label: "Released · unpaid", tone: "bg-[#f1efe9] text-stone-500" },
};
const PAYMENT: Record<string, string> = { unpaid: "Unpaid", pending: "Payment in progress", part_paid: "Part paid", paid: "Paid in full" };
const METHOD: Record<string, string> = { online: "Online card payment", bank_transfer: "Bank transfer", cash: "Cash", pos: "POS terminal" };

const fullDate = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const day = (isoDate: string) => fullDate.format(Date.parse(`${isoDate}T00:00:00Z`));

const input = "block w-full rounded-2xl border border-[#e6dfd2] bg-white px-4 py-3 text-[15px] text-[#202b28] outline-none placeholder:text-stone-400 focus:border-[#b28247]";
const primary = "flex w-full items-center justify-between rounded-full bg-[#263b34] px-6 py-3.5 text-[15px] font-semibold text-white hover:bg-[#1a2c26] disabled:cursor-not-allowed disabled:opacity-50";
const gold = "inline-flex items-center gap-2 rounded-full bg-[#dfb56f] px-5 py-3 text-[15px] font-semibold text-[#263b34] hover:bg-[#edc98e] disabled:opacity-60";
const quiet = "inline-flex items-center gap-2 text-[14px] font-semibold text-[#31715d] hover:text-[#1f4d3f]";

function StatusBadge({ status }: { status: string }) {
  const entry = STATUS[status] ?? { label: status.replaceAll("_", " "), tone: "bg-[#f1efe9] text-stone-600" };
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${entry.tone}`}>{entry.label}</span>;
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[28px] border border-[#e6dfd2] bg-white p-6 shadow-[0_18px_40px_rgb(38_59_52/6%)] sm:p-8 ${className}`}>{children}</div>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-6 border-b border-[#f1ece2] py-2.5 text-[15px] last:border-0">
      <dt className="shrink-0 text-stone-500">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-[#263b34] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function MyBookings() {
  const params = useSearchParams();
  const linkedReference = params.get("reference") ?? "";
  const [view, setView] = useState<View>({ kind: "find" });
  // Read once on the client; the first render shows the loading state either way, so hydration matches.
  const [session, setSession] = useState<Session | null>(() => (typeof window === "undefined" ? null : loadSession()));
  const [bookings, setBookings] = useState<GuestBooking[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const openList = useCallback(async (active: Session) => {
    try {
      const result = await api.publicBooking.myBookings(active.token);
      setBookings(result.bookings);
      setView({ kind: "list" });
    } catch (caught) {
      saveSession(null);
      setSession(null);
      setView({ kind: "find" });
      if (caught instanceof ApiError && caught.status === 401) setNotice("Your session ended. Request a new code to see your bookings.");
      else setError(errorMessage(caught, "We couldn't load your bookings"));
    }
  }, []);

  // Opens a booking just made in this tab, or the guest's session, without asking again.
  useEffect(() => {
    document.title = "My bookings | Houzzhills";
    api.publicBooking.property().then(applyProperty).catch(() => undefined);
    const email = linkedReference ? rememberedEmail(linkedReference) : null;
    const active = loadSession();
    const start = async () => {
      if (linkedReference && email) {
        try {
          setView({ kind: "booking", booking: await api.publicBooking.lookup({ reference: linkedReference, email }) });
          return;
        } catch {
          // Fall through to the form, with the reference filled in.
        }
      }
      if (active && !linkedReference) await openList(active);
    };
    void start().finally(() => setLoading(false));
  }, [linkedReference, openList]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught, "Something went wrong. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const lookup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      const booking = await api.publicBooking.lookup({ reference: String(form.get("reference") ?? "").trim(), email: String(form.get("email") ?? "").trim() });
      setView({ kind: "booking", booking });
    });
  };

  const requestCode = (email: string) =>
    run(async () => {
      const { expiresMinutes } = await api.publicBooking.requestAccessCode(email);
      setView({ kind: "code", email });
      setNotice(`If ${email} has bookings with us, we've emailed a 6-digit code. It expires in ${expiresMinutes} minutes.`);
    });

  const verify = (event: FormEvent<HTMLFormElement>, email: string) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").replace(/\D/g, "");
    void run(async () => {
      const created = await api.publicBooking.verifyAccessCode({ email, code });
      saveSession(created);
      setSession(created);
      await openList(created);
    });
  };

  const signOut = () => {
    if (session) void api.publicBooking.endGuestSession(session.token).catch(() => undefined);
    saveSession(null);
    setSession(null);
    setBookings(null);
    setView({ kind: "find" });
  };

  const pay = (booking: GuestBooking) =>
    run(async () => {
      const { checkoutUrl } = await api.publicBooking.payBooking({ reference: booking.reference, email: booking.guest.email });
      window.location.assign(checkoutUrl);
    });

  const back = () => {
    setError("");
    setNotice("");
    if (session && bookings) setView({ kind: "list" });
    else setView({ kind: "find" });
  };

  return (
    <div className="site min-h-screen bg-[#f8f6f1] text-[#202b28]">
      <section className="relative overflow-hidden bg-[#263b34] text-[#f7f4ed] print:hidden">
        <div className="absolute right-[-8%] top-[-40%] h-[520px] w-[58%] rotate-[-16deg] rounded-[45%] border border-white/10" />
        <SiteNav base="/" />
        <div className="relative z-10 mx-auto max-w-5xl px-6 pb-12 pt-4 lg:px-10">
          <p className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[.28em] text-[#e0b876]">
            <span className="h-px w-8 bg-[#e0b876]" /> No account needed
          </p>
          <h1 className="mt-4 font-serif text-[clamp(2.25rem,7vw,3.75rem)] leading-[1.02] tracking-[-.03em]">My bookings</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-[#cad5cf]">View a booking, pay for a reserved stay or print your receipt with your booking reference and email.</p>
        </div>
      </section>

      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-10 lg:py-14">
        {notice && <p className="mb-5 rounded-2xl bg-[#eef5f1] px-5 py-3 text-[14px] leading-6 text-[#31715d] print:hidden">{notice}</p>}
        {error && <p className="mb-5 rounded-2xl bg-[#fbf1ec] px-5 py-3 text-[14px] leading-6 text-[#a35f53] print:hidden">{error}</p>}

        {loading ? (
          <div className="h-64 animate-pulse rounded-[28px] bg-[#e9e3d7]" aria-busy="true" aria-label="Loading" />
        ) : view.kind === "find" ? (
          <div className="grid gap-5 md:grid-cols-2">
            <Card>
              <Search size={20} className="text-[#b28247]" />
              <h2 className="mt-4 font-serif text-2xl text-[#263b34]">Find a booking</h2>
              <p className="mt-2 text-[14px] leading-6 text-stone-500">Use the reference from your booking email, such as HH-K7QM-4XPA-9C.</p>
              <form onSubmit={lookup} className="mt-6 space-y-3">
                <input name="reference" aria-label="Booking reference" placeholder="Booking reference" defaultValue={linkedReference} required maxLength={80} autoCapitalize="characters" className={`${input} uppercase placeholder:normal-case`} />
                <input name="email" aria-label="Email used for the booking" placeholder="Email used for the booking" type="email" autoComplete="email" required maxLength={254} className={input} />
                <button disabled={busy} className={primary}>
                  {busy ? "Finding…" : "View booking"} <ArrowRight size={16} />
                </button>
              </form>
            </Card>
            <Card>
              <Mail size={20} className="text-[#b28247]" />
              <h2 className="mt-4 font-serif text-2xl text-[#263b34]">See all your bookings</h2>
              <p className="mt-2 text-[14px] leading-6 text-stone-500">Lost your reference? We&apos;ll email you a one-time code to open your full booking history.</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void requestCode(String(new FormData(event.currentTarget).get("email") ?? "").trim());
                }}
                className="mt-6 space-y-3"
              >
                <input name="email" aria-label="Your email" placeholder="Your email" type="email" autoComplete="email" required maxLength={254} className={input} />
                <button disabled={busy} className={primary}>
                  {busy ? "Sending…" : "Email me a code"} <ArrowRight size={16} />
                </button>
              </form>
            </Card>
          </div>
        ) : view.kind === "code" ? (
          <Card className="mx-auto max-w-md">
            <Mail size={20} className="text-[#b28247]" />
            <h2 className="mt-4 font-serif text-2xl text-[#263b34]">Enter your code</h2>
            <p className="mt-2 text-[14px] leading-6 text-stone-500">
              We sent it to <b className="text-[#263b34]">{view.email}</b>. Check your spam folder if it hasn&apos;t arrived in a minute.
            </p>
            <form onSubmit={(event) => verify(event, view.email)} className="mt-6 space-y-3">
              <input
                name="code"
                aria-label="6-digit code"
                placeholder="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                required
                autoFocus
                className={`${input} text-center text-2xl font-semibold tracking-[.4em]`}
              />
              <button disabled={busy} className={primary}>
                {busy ? "Checking…" : "Show my bookings"} <ArrowRight size={16} />
              </button>
            </form>
            <div className="mt-5 flex flex-wrap justify-between gap-3">
              <button type="button" disabled={busy} onClick={() => void requestCode(view.email)} className={quiet}>
                Send a new code
              </button>
              <button type="button" onClick={back} className={quiet}>
                Use a different email
              </button>
            </div>
          </Card>
        ) : view.kind === "list" ? (
          <BookingList email={session?.email ?? ""} bookings={bookings ?? []} busy={busy} onOpen={(booking) => setView({ kind: "booking", booking })} onPay={pay} onSignOut={signOut} />
        ) : (
          <Receipt booking={view.booking} busy={busy} onPay={pay} onBack={back} backLabel={session && bookings ? "All my bookings" : "Find another booking"} />
        )}
      </main>
      <div className="print:hidden">
        <SiteFooter base="/" />
      </div>
    </div>
  );
}

function BookingList({
  email,
  bookings,
  busy,
  onOpen,
  onPay,
  onSignOut,
}: {
  email: string;
  bookings: GuestBooking[];
  busy: boolean;
  onOpen: (booking: GuestBooking) => void;
  onPay: (booking: GuestBooking) => void;
  onSignOut: () => void;
}) {
  const upcoming = bookings.filter((booking) => ["pending_payment", "hold", "confirmed", "checked_in"].includes(booking.status));
  const due = upcoming.reduce((sum, booking) => sum + BigInt(booking.payment.balanceKobo), 0n);
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.2em] text-[#b28247]">Signed in with a code</p>
          <h2 className="mt-2 font-serif text-3xl text-[#263b34] [overflow-wrap:anywhere]">{email}</h2>
        </div>
        <button type="button" onClick={onSignOut} className={quiet}>
          <LogOut size={15} /> Sign out
        </button>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        {[
          ["Bookings", String(bookings.length)],
          ["Upcoming", String(upcoming.length)],
          ["Balance due", money(due)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-white/70 p-4">
            <small className="block text-xs uppercase tracking-[.14em] text-stone-500">{label}</small>
            <b className="mt-2 block font-serif text-xl text-[#263b34] sm:text-2xl">{value}</b>
          </div>
        ))}
      </div>

      {bookings.length === 0 ? (
        <Card className="mt-6 text-center">
          <p className="font-serif text-2xl text-[#263b34]">No bookings yet.</p>
          <Link href="/#apartments" className={`${quiet} mt-4`}>
            Find an apartment <ArrowUpRight size={15} />
          </Link>
        </Card>
      ) : (
        <ul className="mt-6 space-y-3">
          {bookings.map((booking) => (
            <li key={booking.reference} className="rounded-[24px] border border-[#e6dfd2] bg-white p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <StatusBadge status={booking.status} />
                  <h3 className="mt-3 font-serif text-xl text-[#263b34]">{booking.stay.name}</h3>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-stone-500">
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays size={14} /> {day(booking.checkIn)} – {day(booking.checkOut)}
                    </span>
                    <span>
                      {plural(booking.nights, "night")} · {plural(booking.guests, "guest")}
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-[13px] text-stone-400">{booking.reference}</p>
                </div>
                <div className="text-right">
                  <b className="block font-serif text-xl text-[#263b34]">{money(booking.payment.amountKobo)}</b>
                  <span className="text-[13px] text-stone-500">{BigInt(booking.payment.balanceKobo) > 0n ? `${money(booking.payment.balanceKobo)} due` : (PAYMENT[booking.payment.status] ?? booking.payment.status)}</span>
                </div>
              </div>
              {booking.holdExpiresAt && (
                <p className="mt-4 flex items-center gap-2 rounded-xl bg-[#fbf6ee] px-4 py-2.5 text-[13px] text-[#94621f]">
                  <Clock3 size={14} /> Held until {dateTimeLabel(booking.holdExpiresAt)}. Pay before then to confirm.
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-4">
                {booking.canPay && (
                  <button type="button" disabled={busy} onClick={() => onPay(booking)} className={gold}>
                    <CreditCard size={15} /> Pay {money(booking.payment.balanceKobo)}
                  </button>
                )}
                <button type="button" onClick={() => onOpen(booking)} className={quiet}>
                  Details and receipt <ArrowRight size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Receipt({ booking, busy, onPay, onBack, backLabel }: { booking: GuestBooking; busy: boolean; onPay: (booking: GuestBooking) => void; onBack: () => void; backLabel: string }) {
  const { stay, payment, guest } = booking;
  const balance = BigInt(payment.balanceKobo);
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <button type="button" onClick={onBack} className={quiet}>
          <ArrowLeft size={15} /> {backLabel}
        </button>
        <button type="button" onClick={() => window.print()} className={quiet}>
          <Printer size={15} /> Print or save receipt
        </button>
      </div>

      {booking.canPay && booking.holdExpiresAt && (
        <div className="mb-5 flex flex-col gap-4 rounded-[24px] border border-[#ecd9b6] bg-[#fbf6ee] p-5 sm:flex-row sm:items-center sm:justify-between print:hidden">
          <div>
            <b className="flex items-center gap-2 text-[15px] text-[#7a5016]">
              <Clock3 size={16} /> Reserved until {dateTimeLabel(booking.holdExpiresAt)}
            </b>
            <p className="mt-1 text-[14px] leading-6 text-[#94621f]">Pay before then to confirm your stay. Unpaid bookings are released automatically and nothing is charged.</p>
          </div>
          <button type="button" disabled={busy} onClick={() => onPay(booking)} className={`${gold} shrink-0 justify-center`}>
            <CreditCard size={15} /> {busy ? "Opening checkout…" : `Pay ${money(balance)} now`}
          </button>
        </div>
      )}

      <Card className="print:border-0 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#efeadf] pb-6">
          <div>
            <p className="font-serif text-2xl text-[#263b34]">Houzzhills.</p>
            <p className="mt-1 text-xs uppercase tracking-[.22em] text-stone-500">Booking receipt</p>
          </div>
          <div className="text-right">
            <StatusBadge status={booking.status} />
            <p className="mt-2 font-mono text-lg font-semibold tracking-wide text-[#263b34]">{booking.reference}</p>
            <p className="text-[13px] text-stone-500">Booked {dateTimeLabel(booking.bookedAt)}</p>
          </div>
        </div>

        <div className="grid gap-8 pt-6 md:grid-cols-2">
          <section>
            <h3 className="text-xs font-bold uppercase tracking-[.2em] text-[#b28247]">Stay</h3>
            <dl className="mt-3">
              <Row label={stay.apartmentSlug ? "Apartment" : "Room"}>
                {stay.name}
                {stay.unitCode ? ` · ${stay.apartmentSlug ? "Unit" : "Room"} ${stay.unitCode}` : ""}
              </Row>
              {stay.address && <Row label="Address">{stay.address}</Row>}
              <Row label="Check-in">
                {day(booking.checkIn)}
                {stay.checkInTime ? ` · from ${stay.checkInTime}` : ""}
              </Row>
              <Row label="Check-out">
                {day(booking.checkOut)}
                {stay.checkOutTime ? ` · by ${stay.checkOutTime}` : ""}
              </Row>
              <Row label="Length">
                {plural(booking.nights, "night")} · {plural(booking.guests, "guest")}
              </Row>
            </dl>
            <h3 className="mt-8 text-xs font-bold uppercase tracking-[.2em] text-[#b28247]">Guest</h3>
            <dl className="mt-3">
              <Row label="Name">{guest.name}</Row>
              <Row label="Email">{guest.email}</Row>
              {guest.phone && <Row label="Phone">{guest.phone}</Row>}
              {booking.notes && <Row label="Notes">{booking.notes}</Row>}
            </dl>
          </section>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-[.2em] text-[#b28247]">Payment</h3>
            <dl className="mt-3">
              <Row label="Option">{booking.payLater ? "Reserve now, pay later" : booking.bookedOnline ? "Paid online at booking" : "Booked with the property"}</Row>
              <Row label="Status">{PAYMENT[payment.status] ?? payment.status}</Row>
              <Row label="Stay total">{money(payment.amountKobo)}</Row>
              <Row label="Paid">{money(payment.paidKobo)}</Row>
              <Row label="Balance due">{money(balance)}</Row>
            </dl>
            {payment.payments.length > 0 && (
              <>
                <h3 className="mt-8 text-xs font-bold uppercase tracking-[.2em] text-[#b28247]">Payments received</h3>
                <ul className="mt-3 divide-y divide-[#f1ece2] text-[14px]">
                  {payment.payments.map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className="flex justify-between gap-4 py-2.5">
                      <span className="text-stone-600">
                        {METHOD[entry.method] ?? entry.method}
                        <small className="block text-[12px] text-stone-400">
                          {dateTimeLabel(entry.at)}
                          {entry.status === "pending" ? " · being verified" : ""}
                        </small>
                      </span>
                      <b className="text-[#263b34]">{money(entry.amountKobo)}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {BigInt(payment.cautionFeeKobo) > 0n && (
              <p className="mt-6 rounded-xl bg-[#f6f3ec] px-4 py-3 text-[13px] leading-5 text-stone-600">
                This apartment has a caution fee of {money(payment.cautionFeeKobo)}, separate from the stay total.
              </p>
            )}
          </section>
        </div>

        <p className="mt-8 border-t border-[#efeadf] pt-5 text-[13px] leading-6 text-stone-500">
          Keep your reference <b className="text-[#263b34]">{booking.reference}</b> to find this booking again. Questions? Reply to any of our booking emails.
        </p>
      </Card>

      {!booking.canPay && booking.status === "expired" && (
        <p className="mt-5 text-center text-[14px] text-stone-500 print:hidden">
          This booking was released because it wasn&apos;t paid in time.{" "}
          <Link href={stay.apartmentSlug ? `/apartments/${stay.apartmentSlug}` : "/#apartments"} className="font-semibold text-[#31715d] underline">
            Book again
          </Link>
        </p>
      )}
    </div>
  );
}

export default function MyBookingsPage() {
  return (
    <Suspense>
      <MyBookings />
    </Suspense>
  );
}
