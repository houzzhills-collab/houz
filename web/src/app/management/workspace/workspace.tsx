"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, BedDouble, Building2, CalendarDays, Check, Clock3, Coffee, CreditCard, HelpCircle, KeyRound, LayoutDashboard, LogOut, Menu, Search, Settings2, Users, Utensils, X } from "lucide-react";
import { api, errorMessage, type Permission, type Property, type Reference, type User } from "@/lib/api";
import { applyProperty, initials, longDateLabel, optionLabel, propertyHour, text } from "./format";
import { CommandPalette, Tour, tourSeen, type Focus, type PaletteAction, type TourStep } from "./assist";
import { Field, Modal, useAction, type SectionProps } from "./ui";
import { ApartmentsSection } from "./sections/apartments";
import { InventorySection } from "./sections/inventory";
import { OverviewSection } from "./sections/overview";
import { PaymentsSection } from "./sections/payments";
import { PosSection } from "./sections/pos";
import { ReservationsSection } from "./sections/reservations";
import { RoomsSection } from "./sections/rooms";
import { SettingsSection } from "./sections/settings";
import { TeamSection } from "./sections/team";

const NAVIGATION: ReadonlyArray<{ label: string; icon: typeof LayoutDashboard; permission: Permission; description: string }> = [
  { label: "Overview", icon: LayoutDashboard, permission: "dashboard:read", description: "Here’s what’s happening across your property today." },
  { label: "Reservations", icon: CalendarDays, permission: "reservations:read", description: "Stays, arrivals, departures and guest payments." },
  { label: "Payments", icon: CreditCard, permission: "payments:read", description: "The payment register, transfer confirmation and exceptions." },
  { label: "Apartments", icon: Building2, permission: "rooms:read", description: "Website listings: details, photos, prices, publishing and bookings." },
  { label: "Rooms", icon: BedDouble, permission: "rooms:read", description: "Room readiness, rates and current stays." },
  { label: "Restaurant POS", icon: Utensils, permission: "pos:read", description: "Restaurant sales, receipts and cashier shifts." },
  { label: "Inventory", icon: Coffee, permission: "inventory:read", description: "Store items and the stock movement ledger." },
  { label: "Team & attendance", icon: Users, permission: "staff:read", description: "Staff accounts and attendance." },
  { label: "Settings", icon: Settings2, permission: "settings:manage", description: "Online payments and booking rules. Visible to the owner only." },
];
const LIVE_REFRESH_DEBOUNCE_MS = 600;
const WEBSITE_URL = process.env.NEXT_PUBLIC_WEBSITE_URL ?? "https://houzzhills.com";

function SignIn({ property, setupRequired, onSignedIn }: { property: Property | null; setupRequired: boolean; onSignedIn: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      onSignedIn(await api.auth.login({ email: text(values.get("email")), password: String(values.get("password") ?? "") }));
    } catch (caught) {
      setError(errorMessage(caught, "Unable to sign in"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="management-auth-shell">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <div className="brand-mark">
          H<span>.</span>
        </div>
        {property && <p className="auth-eyebrow">{property.name.toUpperCase()}</p>}
        <h1>Welcome back</h1>
        <p className="auth-copy">Sign in to your property workspace.</p>
        {error && <div className="form-error">{error}</div>}
        <Field label="Work email">
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <button className="button-primary auth-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in securely"}
        </button>
        {setupRequired && (
          <p className="auth-setup">
            First time here? <Link href="/management/setup">Set up the owner account</Link>
          </p>
        )}
        <Link className="auth-public-link" href={WEBSITE_URL}>
          Back to the public website <ArrowRight size={13} />
        </Link>
      </form>
    </div>
  );
}

function PasswordDialog({ required, onClose, onChanged }: { required: boolean; onClose?: () => void; onChanged: () => void }) {
  const action = useAction();
  return (
    <Modal
      title={required ? "Choose your own password" : "Change password"}
      description={required ? "Your account uses a temporary password. Replace it to continue." : "Your other devices will be signed out."}
      busy={action.busy}
      error={action.error}
      onClose={onClose}
      onSubmit={(values) =>
        action.run(async () => {
          await api.auth.changePassword({ currentPassword: String(values.get("currentPassword") ?? ""), newPassword: String(values.get("newPassword") ?? "") });
          onChanged();
        })
      }
    >
      <Field label="Current password">
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="New password (12+ characters)">
        <input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={256} required />
      </Field>
    </Modal>
  );
}

/**
 * A full page inside the workspace shell, for work too long for a drawer or
 * modal (e.g. adding an apartment). `section` is highlighted in the sidebar.
 */
export type WorkspacePage = {
  section: string;
  title: string;
  description: string;
  /** Shown only to users with this permission. */
  permission: Permission;
  render: (props: SectionProps) => ReactNode;
};

/** The section to open, e.g. /management?section=Apartments after leaving a page. */
function requestedSection(): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("section");
}

/** A record or form to open on arrival: /management?section=Rooms&open=<id> or &intent=create. */
function requestedFocus(section: string): Focus | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const id = params.get("open") ?? undefined;
  const intent = params.get("intent") ?? undefined;
  if (!id && !intent) return null;
  window.history.replaceState(null, "", `/management?section=${encodeURIComponent(section)}`);
  return { section, id, query: params.get("q") ?? undefined, intent, nonce: Date.now() };
}

function tourSteps(firstName: string): TourStep[] {
  return [
    { title: `Welcome, ${firstName}`, body: "This short tour shows where everything is. It takes under a minute, and you can replay it any time from the ? button at the top." },
    { target: '[data-tour="nav"]', title: "Your sections", body: "Everything you can work on is listed here. You only see the sections your role allows. Hover over one for a short description." },
    { target: '[data-tour="search"]', title: "Search and jump anywhere", body: "Press Ctrl + K (⌘K on Mac) or / to find a guest, booking reference, apartment, room, stock item or team member, start an action, or read how something works." },
    { target: '[data-tour="heading"]', title: "Where you are", body: "The page title and the date. Buttons to add new things sit at the top right of each panel below." },
    { target: '[data-tour="content"]', title: "Open any record", body: "Click a row in any list to open it in a side panel with its full details, history and actions such as edit, archive or record payment." },
    { target: '[data-tour="live"]', title: "Live updates", body: "When this dot is green, changes made by anyone on the team appear on your screen straight away. No need to refresh." },
    { target: '[data-tour="clock"]', title: "Clock in and out", body: "Record the start and end of your shift here." },
    { target: '[data-tour="help"]', title: "Help is always here", body: "Replay this tour from here. Hover over buttons and labels for tips, and use search to look up how things work." },
  ];
}

export function Workspace({ page }: { page?: WorkspacePage } = {}) {
  const router = useRouter();
  // Stable values: `page` itself is a new object on every render.
  const onPage = page !== undefined;
  const pageSection = page?.section;
  const [user, setUser] = useState<User | null>(null);
  const [property, setProperty] = useState<Property | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "offline">("loading");
  const [setupRequired, setSetupRequired] = useState(false);
  const [active, setActive] = useState("Overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [clockedIn, setClockedIn] = useState<boolean | null>(null);
  const [live, setLive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [touring, setTouring] = useState(false);

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  }, []);
  const can = useCallback((permission: Permission) => user?.permissions.includes(permission) ?? false, [user]);
  const allowed = useMemo(() => NAVIGATION.filter((item) => user?.permissions.includes(item.permission)), [user]);

  const enter = useCallback(async (signedIn: User | null) => {
    if (!signedIn) {
      const setup = await api.setup.status();
      setSetupRequired(setup.setupRequired);
      setUser(null);
      setState("signed-out");
      return;
    }
    if (!signedIn.mustChangePassword) {
      const [loadedProperty, loadedReference] = await Promise.all([api.publicBooking.property(), api.reference.get()]);
      applyProperty(loadedProperty);
      setProperty(loadedProperty);
      setReference(loadedReference);
    }
    setUser(signedIn);
    const permitted = NAVIGATION.filter((item) => signedIn.permissions.includes(item.permission));
    const requested = pageSection ?? requestedSection();
    const section = permitted.find((item) => item.label === requested)?.label ?? permitted[0]?.label ?? "Overview";
    setActive(section);
    if (!onPage) setFocus(requestedFocus(section));
    // First visit: offer the guided tour once per user and browser.
    if (!onPage && !signedIn.mustChangePassword && !tourSeen.get(signedIn.id)) window.setTimeout(() => setTouring(true), 900);
    setState("ready");
    if (!signedIn.mustChangePassword) {
      // Only staff with an attendance profile get a clock state; others see no clock control.
      setClockedIn((await api.attendance.self().catch(() => null))?.clockedIn ?? null);
    }
  }, [onPage, pageSection]);

  useEffect(() => {
    // The property is shown on the sign-in screen; it does not exist until setup is done.
    api.publicBooking
      .property()
      .then((loaded) => {
        applyProperty(loaded);
        setProperty(loaded);
      })
      .catch(() => undefined);
    api.auth.session().then(enter, () => setState("offline"));
  }, [enter]);

  /** Opens a section, optionally a record's drawer or a "new" form, from anywhere (including full pages). */
  const go = useCallback(
    (target: Omit<Focus, "nonce">) => {
      setMenuOpen(false);
      if (onPage) {
        const params = new URLSearchParams({ section: target.section, ...(target.id ? { open: target.id } : {}), ...(target.query ? { q: target.query } : {}), ...(target.intent ? { intent: target.intent } : {}) });
        router.push(`/management?${params.toString()}`);
        return;
      }
      setActive(target.section);
      setFocus(target.id || target.intent ? { ...target, nonce: Date.now() } : null);
    },
    [onPage, router],
  );

  // Ctrl/⌘+K, or "/" outside a text field, opens the search palette.
  useEffect(() => {
    if (state !== "ready") return;
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if ((event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state]);

  const endTour = useCallback(() => {
    setTouring(false);
    if (user) tourSeen.set(user.id);
  }, [user]);

  // Live updates: committed changes from any user refresh the open section.
  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    let timer: number | undefined;
    const stop = api.events.subscribe(
      () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setRefreshKey((key) => key + 1), LIVE_REFRESH_DEBOUNCE_MS);
      },
      (connected) => setLive(connected),
    );
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [user]);

  const signOut = async () => {
    await api.auth.logout().catch(() => undefined);
    setClockedIn(null);
    setLive(false);
    await enter(null).catch(() => setState("offline"));
  };

  const clock = async () => {
    try {
      const next = clockedIn ? "clock_out" : "clock_in";
      await api.attendance.record(next);
      setClockedIn(next === "clock_in");
      notify(next === "clock_in" ? "You are clocked in" : "You are clocked out");
    } catch (error) {
      notify(errorMessage(error, "Attendance could not be recorded"));
    }
  };

  if (state === "loading") {
    return (
      <div className="management-auth-shell">
        <div className="auth-card">
          <div className="brand-mark">
            H<span>.</span>
          </div>
          <strong>Connecting…</strong>
        </div>
      </div>
    );
  }
  if (state === "offline") {
    return (
      <div className="management-auth-shell">
        <div className="auth-card">
          <div className="brand-mark">
            H<span>.</span>
          </div>
          <div className="form-error">The service is not reachable right now. Check your connection and try again.</div>
          <button className="button-primary auth-submit" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (state === "signed-out" || !user) return <SignIn property={property} setupRequired={setupRequired} onSignedIn={(signedIn) => void enter(signedIn).catch(() => setState("offline"))} />;

  if (user.mustChangePassword) {
    return (
      <div className="management-auth-shell">
        <PasswordDialog required onChanged={() => void api.auth.session().then(enter).catch(() => setState("offline"))} />
      </div>
    );
  }

  if (!property || !reference) {
    return (
      <div className="management-auth-shell">
        <div className="auth-card">
          <strong>Loading your workspace…</strong>
        </div>
      </div>
    );
  }

  const current = allowed.find((item) => item.label === active) ?? allowed[0];
  const sectionProps = { user, notify, refreshKey, can, reference, property, focus: focus && focus.section === current?.label ? focus : null };
  const sectionKey = focus && focus.section === current?.label ? `${current?.label}:${focus.nonce}` : current?.label;
  const paletteActions: PaletteAction[] = [
    ...(can("reservations:write") ? [{ id: "new-reservation", label: "New reservation", hint: "Book a guest into a room", keywords: "create booking add guest", run: () => go({ section: "Reservations", intent: "create" }) }] : []),
    ...(can("rooms:create") ? [{ id: "new-apartment", label: "Add an apartment", hint: "Create a website listing with photos", keywords: "create listing", run: () => router.push("/management/apartments/new") }] : []),
    ...(can("rooms:create") ? [{ id: "new-room", label: "Add a room", hint: "A room number, category, rate and capacity", keywords: "create", run: () => go({ section: "Rooms", intent: "create" }) }] : []),
    ...(can("inventory:write") ? [{ id: "new-stock", label: "Add a stock item", hint: "A store item such as drinks or supplies", keywords: "create inventory", run: () => go({ section: "Inventory", intent: "create" }) }] : []),
    ...(can("inventory:write") ? [{ id: "stock-movement", label: "Record a stock movement", hint: "Receive a delivery, write off wastage or correct a count", keywords: "inventory receive wastage adjust", run: () => go({ section: "Inventory", intent: "movement" }) }] : []),
    ...(reference.assignableRoles.length > 0 && can("staff:write") ? [{ id: "new-staff", label: "Onboard a staff member", hint: "Create their workspace account", keywords: "create employee team user", run: () => go({ section: "Team & attendance", intent: "create" }) }] : []),
    { id: "tour", label: "Take the tour", hint: "A one-minute walk through the workspace", keywords: "help guide onboarding", run: () => setTouring(true) },
    { id: "password", label: "Change your password", hint: "Other devices are signed out", keywords: "account security", run: () => setPasswordOpen(true) },
    { id: "website", label: "Open the public website", hint: "See what guests see", keywords: "site homepage", run: () => window.open("/", "_blank", "noopener") },
    { id: "signout", label: "Sign out", hint: "End this session", keywords: "logout log out", run: () => void signOut() },
  ];
  const hour = propertyHour();

  return (
    <div className="management-shell">
      <aside className={`management-sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="management-brand">
          <div className="brand-mark">
            H<span>.</span>
          </div>
          <div>
            <strong>{property.name.toUpperCase()}</strong>
            <small>PROPERTY OPERATIONS</small>
          </div>
          <button className="mobile-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="side-label">WORKSPACE</div>
        <nav className="management-nav" data-tour="nav">
          {allowed.map(({ label, icon: Icon, description }) => (
            <button
              key={label}
              className={current?.label === label ? "selected" : ""}
              data-tip={description}
              data-tip-pos="right"
              onClick={() => go({ section: label })}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="side-label tools-label">ACCOUNT</div>
        <nav className="management-nav">
          <button onClick={() => setPasswordOpen(true)} data-tip="Choose a new password. Your other devices are signed out." data-tip-pos="right">
            <KeyRound size={17} />
            <span>Change password</span>
          </button>
          <button onClick={() => void signOut()}>
            <LogOut size={17} />
            <span>Sign out</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="side-user">
            <div className="user-avatar">{initials(user.fullName)}</div>
            <div>
              <strong>{user.fullName}</strong>
              <span>{optionLabel(reference.roles, user.role)}</span>
            </div>
          </div>
        </div>
      </aside>
      {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <main className="management-main">
        <header className="management-topbar">
          <button className="mobile-menu" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <b>/</b>
            {page && (
              <>
                <Link href={`/management?section=${encodeURIComponent(page.section)}`}>{page.section}</Link>
                <b>/</b>
              </>
            )}
            <strong>{page ? page.title : current?.label}</strong>
          </div>
          <button className="search-trigger" data-tour="search" onClick={() => setPaletteOpen(true)} data-tip="Find guests, bookings, rooms, stock, staff, actions and help" data-tip-pos="bottom">
            <Search size={15} />
            <span>Search or jump to…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="topbar-actions">
            <button className="help-trigger" data-tour="help" aria-label="Take the tour" data-tip="Take the tour" data-tip-pos="bottom" onClick={() => setTouring(true)}>
              <HelpCircle size={18} />
            </button>
            <div
              className={`live-indicator ${live ? "" : "is-offline"}`}
              data-tour="live"
              data-tip={live ? "Live: changes by anyone appear instantly" : "Reconnecting: updates are paused and will catch up"}
              data-tip-pos="bottom"
            >
              <i /> {live ? "Live" : "Reconnecting"}
            </div>
            <div className="top-divider" />
            <span className="top-role" data-tip="Your role decides which sections and actions you can use" data-tip-pos="bottom">
              {optionLabel(reference.roles, user.role)}
            </span>
            {clockedIn !== null && (
              <button
                className={`clock-chip ${clockedIn ? "is-clocked" : ""}`}
                data-tour="clock"
                data-tip={clockedIn ? "End your shift" : "Start your shift"}
                data-tip-pos="bottom"
                onClick={() => void clock()}
              >
                <Clock3 size={14} />
                {clockedIn ? "Clock out" : "Clock in"}
              </button>
            )}
          </div>
        </header>
        <div className="management-content" data-tour="content">
          <div className="page-heading" data-tour="heading">
            <div>
              <div className="eyebrow">
                <span /> {longDateLabel().toUpperCase()} <span className="heading-dot">·</span> {property.name.toUpperCase()}
              </div>
              <h1>{page ? page.title : current?.label === "Overview" ? `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${user.fullName.split(" ")[0] ?? ""}` : current?.label}</h1>
              <p>{page ? page.description : current?.description}</p>
            </div>
          </div>
          {page && (user.permissions.includes(page.permission) ? page.render(sectionProps) : <div className="empty-state">You don&apos;t have access to this page.</div>)}
          {!page && current?.label === "Overview" && <OverviewSection {...sectionProps} onOpen={(section) => go({ section })} />}
          {!page && current?.label === "Reservations" && <ReservationsSection key={sectionKey} {...sectionProps} />}
          {!page && current?.label === "Payments" && <PaymentsSection key={sectionKey} {...sectionProps} />}
          {!page && current?.label === "Apartments" && <ApartmentsSection key={sectionKey} {...sectionProps} />}
          {!page && current?.label === "Rooms" && <RoomsSection key={sectionKey} {...sectionProps} />}
          {!page && current?.label === "Restaurant POS" && <PosSection key={sectionKey} {...sectionProps} />}
          {!page && current?.label === "Inventory" && <InventorySection key={sectionKey} {...sectionProps} />}
          {!page && current?.label === "Team & attendance" && <TeamSection key={sectionKey} {...sectionProps} clockedIn={clockedIn} onClock={() => void clock()} />}
          {!page && current?.label === "Settings" && <SettingsSection key={sectionKey} {...sectionProps} />}
          <footer className="management-footer">
            <span>
              © {new Date().getFullYear()} {property.name}
            </span>
            <span>
              <span className="footer-status">
                <i /> {live ? "Live updates on" : "Live updates reconnecting"}
              </span>
            </span>
          </footer>
        </div>
      </main>
      {passwordOpen && (
        <PasswordDialog
          required={false}
          onClose={() => setPasswordOpen(false)}
          onChanged={() => {
            setPasswordOpen(false);
            notify("Password updated");
          }}
        />
      )}
      {/* Mounted only while open, so each search starts empty with fresh records. */}
      {paletteOpen && <CommandPalette open onClose={() => setPaletteOpen(false)} sections={allowed} actions={paletteActions} can={can} go={go} />}
      {touring && <Tour steps={tourSteps(user.fullName.split(" ")[0] ?? "")} onClose={endTour} />}
      {notice && (
        <div role="status" className="management-toast">
          <Check size={16} />
          {notice}
        </div>
      )}
    </div>
  );
}
