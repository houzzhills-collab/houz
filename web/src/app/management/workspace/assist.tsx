"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, CornerDownLeft, Search, Sparkles, X } from "lucide-react";
import { api, type Permission } from "@/lib/api";
import { dateLabel, money } from "./format";

/** What the palette can open: a section, optionally with one record's drawer. */
export type Focus = { section: string; id?: string; query?: string; intent?: string; nonce: number };

export type PaletteAction = { id: string; label: string; hint: string; keywords?: string; run: () => void };

type Item = {
  key: string;
  group: "Go to" | "Actions" | "Records" | "Reference";
  label: string;
  hint: string;
  keywords: string;
  /** Reference entries expand in place instead of navigating. */
  detail?: string;
  run?: () => void;
};

/** Short explanations of how the workspace works, searchable from the palette. */
export const REFERENCE: ReadonlyArray<{ title: string; body: string; keywords: string }> = [
  {
    title: "Archive, retire and cancel instead of delete",
    body: "Records with history are never erased. Archiving or retiring hides an apartment, room, stock or menu item and can be undone from the “Show archived” filter. A reservation is removed by cancelling it with a reason.",
    keywords: "delete remove archive restore retire undo",
  },
  {
    title: "How stock goes down on a sale",
    body: "Each menu item lists the stock it uses (its recipe). Selling it deducts those quantities. An item marked “Not linked to stock” changes nothing: edit it and pick its stock item, quantity 1 for a bottled drink.",
    keywords: "pos inventory stock recipe deduct sale link quantity",
  },
  {
    title: "Room and apartment statuses",
    body: "Vacant clean / inspected: ready to sell. Vacant dirty: needs housekeeping. Occupied: set only by check-in. Maintenance and out of order take it off sale and alert managers.",
    keywords: "room status clean dirty occupied maintenance out of order housekeeping",
  },
  {
    title: "Payment statuses",
    body: "Unpaid: nothing received. Part paid: some money in. Pending: a bank transfer waits for an owner or manager to confirm it. Paid: settled in full. Cash and POS terminal payments settle at once.",
    keywords: "payment paid unpaid pending transfer confirm part",
  },
  {
    title: "Publishing an apartment",
    body: "New apartments start as drafts. Add at least one photo (up to 24), then publish to show it on the website and open it for booking. Unpublish hides it; archive retires it.",
    keywords: "apartment publish draft photos website listing",
  },
  {
    title: "Changing a booking",
    body: "Open a reservation and choose Edit. Confirmed stays can change room, dates and guests; the stay is re-checked and re-priced. Checked-in guests can only change check-out. Online bookings awaiting payment can only change guest details.",
    keywords: "reservation edit change dates room move extend",
  },
  {
    title: "Live updates",
    body: "The green Live dot means changes made by anyone appear on your screen within a second. “Reconnecting” means updates are paused; the page catches up when the connection returns.",
    keywords: "live realtime refresh update reconnecting",
  },
  {
    title: "Keyboard shortcuts",
    body: "Ctrl/⌘ + K or / opens this search. ↑ ↓ to move, Enter to open, Esc to close. Esc also closes the topmost panel or dialog.",
    keywords: "keyboard shortcut hotkey search",
  },
];


function useRecordIndex(open: boolean, can: (permission: Permission) => boolean, go: (focus: Omit<Focus, "nonce">) => void) {
  const [records, setRecords] = useState<Item[]>([]);
  const loaded = useRef(false);
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    const sources: Array<Promise<Item[]>> = [];
    if (can("rooms:read")) {
      sources.push(
        api.apartments.list().then((list) =>
          list.map((apartment) => ({
            key: `apartment-${apartment.id}`,
            group: "Records" as const,
            label: apartment.name,
            hint: `Apartment · ${apartment.category} · ${apartment.status}`,
            keywords: `${apartment.unitCode} ${apartment.category} ${apartment.location.area ?? ""}`,
            run: () => go({ section: "Apartments", id: apartment.id }),
          })),
        ),
        api.rooms.list().then((list) =>
          list.map((room) => ({
            key: `room-${room.id}`,
            group: "Records" as const,
            label: `Room ${room.room_number}`,
            hint: `Room · ${room.room_type}`,
            keywords: room.room_type,
            run: () => go({ section: "Rooms", id: room.id }),
          })),
        ),
      );
    }
    if (can("inventory:read")) {
      sources.push(
        api.inventory.list({ includeArchived: true }).then((list) =>
          list.map((item) => ({
            key: `stock-${item.id}`,
            group: "Records" as const,
            label: item.name,
            hint: `Stock · ${Number(item.quantity)} ${item.unit}${item.active === false ? " · archived" : ""}`,
            keywords: `${item.sku ?? ""} inventory`,
            run: () => go({ section: "Inventory", id: item.id }),
          })),
        ),
      );
    }
    if (can("staff:read")) {
      sources.push(
        api.staff.list().then((list) =>
          list.map((member) => ({
            key: `staff-${member.id}`,
            group: "Records" as const,
            label: member.full_name,
            hint: `Staff · ${member.job_title}`,
            keywords: `${member.email} ${member.employee_number} ${member.department}`,
            run: () => go({ section: "Team & attendance", id: member.id }),
          })),
        ),
      );
    }
    void Promise.allSettled(sources).then((results) => setRecords(results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))));
  }, [open, can, go]);
  return records;
}

/** Reservations are searched on the server as you type (guest name or reference). */
function useReservationSearch(query: string, enabled: boolean, go: (focus: Omit<Focus, "nonce">) => void) {
  const [found, setFound] = useState<{ query: string; items: Item[] }>({ query: "", items: [] });
  useEffect(() => {
    const term = query.trim();
    if (!enabled || term.length < 2) return;
    const timer = window.setTimeout(() => {
      api.reservations
        .list({ q: term })
        .then((rows) =>
          setFound({
            query: term,
            items: rows.slice(0, 6).map((row) => ({
              key: `reservation-${row.id}`,
              group: "Records" as const,
              label: row.guest_name,
              hint: `Reservation · ${row.room_type} · ${dateLabel(row.check_in)}–${dateLabel(row.check_out)} · ${money(row.amount_kobo)}`,
              keywords: `${row.reference} ${row.guest_name}`,
              run: () => go({ section: "Reservations", id: row.id, query: row.reference }),
            })),
          }),
        )
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, enabled, go]);
  return found.query === query.trim() ? found.items : [];
}

function matches(item: Item, terms: string[]): boolean {
  const haystack = `${item.label} ${item.hint} ${item.keywords}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Ctrl/⌘+K or "/": jump to a section, run an action, find a record, or read how something works. */
export function CommandPalette({
  open,
  onClose,
  sections,
  actions,
  can,
  go,
}: {
  open: boolean;
  onClose: () => void;
  sections: ReadonlyArray<{ label: string; description: string }>;
  actions: PaletteAction[];
  can: (permission: Permission) => boolean;
  go: (focus: Omit<Focus, "nonce">) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const records = useRecordIndex(open, can, go);
  const reservations = useReservationSearch(query, open && can("reservations:read"), go);

  const items = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all: Item[] = [
      ...sections.map((section) => ({ key: `go-${section.label}`, group: "Go to" as const, label: section.label, hint: section.description, keywords: "section page open", run: () => go({ section: section.label }) })),
      ...actions.map((action) => ({ key: `action-${action.id}`, group: "Actions" as const, label: action.label, hint: action.hint, keywords: action.keywords ?? "", run: action.run })),
      ...reservations,
      ...records,
      ...REFERENCE.map((entry) => ({ key: `ref-${entry.title}`, group: "Reference" as const, label: entry.title, hint: "How it works", keywords: entry.keywords, detail: entry.body })),
    ];
    if (terms.length === 0) return all.filter((item) => item.group !== "Records").slice(0, 40);
    return all.filter((item) => matches(item, terms)).slice(0, 40);
  }, [query, sections, actions, records, reservations, go]);

  const active = Math.min(selected, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.detail) {
      setExpanded((current) => (current === item.key ? null : item.key));
      return;
    }
    item.run?.();
    onClose();
  };

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Search the workspace">
        <div className="palette-search">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder="Search sections, actions, guests, apartments, rooms, stock, staff or help…"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
              setExpanded(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected(Math.min(items.length - 1, active + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected(Math.max(0, active - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(items[active]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            aria-label="Search the workspace"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {items.length === 0 && <div className="palette-empty">Nothing matches “{query}”. Try a guest name, booking reference, room number or a word like “stock”.</div>}
          {items.map((item, index) => {
            const heading = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {heading && <div className="palette-group">{heading}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className={`palette-item ${index === active ? "is-active" : ""}`}
                  onMouseMove={() => setSelected(index)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-icon">{item.group === "Reference" ? <BookOpen size={15} /> : item.group === "Actions" ? <Sparkles size={15} /> : <ArrowRight size={15} />}</span>
                  <span className="palette-text">
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                    {expanded === item.key && item.detail && <span className="palette-detail">{item.detail}</span>}
                  </span>
                  {index === active && <CornerDownLeft size={14} className="palette-enter" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

export type TourStep = { target?: string; title: string; body: ReactNode };

/** A guided walk through the workspace, highlighting one element per step. Steps whose element is missing are skipped. */
export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const visible = useMemo(() => steps.filter((step) => !step.target || document.querySelector(step.target)), [steps]);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = visible[Math.min(index, visible.length - 1)];

  const measure = useCallback(() => {
    const element = step?.target ? document.querySelector(step.target) : null;
    setRect(element ? element.getBoundingClientRect() : null);
  }, [step]);

  useLayoutEffect(() => {
    const element = step?.target ? document.querySelector(step.target) : null;
    element?.scrollIntoView({ block: "nearest", behavior: "auto" });
    const frame = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, measure]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setIndex((current) => Math.min(visible.length - 1, current + 1));
      if (event.key === "ArrowLeft") setIndex((current) => Math.max(0, current - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible.length, onClose]);

  if (!step) return null;
  const last = index >= visible.length - 1;
  const pad = 8;
  const spot = rect ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 } : null;
  // Card beside the highlight: right of tall/left elements, otherwise below (or above when near the bottom).
  const card: React.CSSProperties = !spot
    ? { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
    : spot.left + spot.width + 380 < window.innerWidth && spot.height > 200
      ? { top: Math.max(16, Math.min(spot.top, window.innerHeight - 280)), left: spot.left + spot.width + 16 }
      : spot.top + spot.height + 240 < window.innerHeight
        ? { top: spot.top + spot.height + 14, left: Math.max(16, Math.min(spot.left, window.innerWidth - 376)) }
        : { top: Math.max(16, spot.top - 250), left: Math.max(16, Math.min(spot.left, window.innerWidth - 376)) };

  return (
    <div className="tour-layer" role="dialog" aria-modal="true" aria-label={`Tour: ${step.title}`}>
      {spot ? <div className="tour-spot" style={spot} /> : <div className="tour-dim" />}
      <div className="tour-card" style={card}>
        <div className="tour-progress">
          Step {index + 1} of {visible.length}
          <button type="button" aria-label="End tour" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <h3>{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        <div className="tour-actions">
          <button type="button" className="text-link" onClick={onClose}>
            Skip tour
          </button>
          <span className="spacer" />
          {index > 0 && (
            <button type="button" className="button-secondary" onClick={() => setIndex(index - 1)}>
              Back
            </button>
          )}
          <button type="button" className="button-primary" onClick={() => (last ? onClose() : setIndex(index + 1))} autoFocus>
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Remembers per user and browser whether the tour was seen. Storage can be unavailable; then the tour simply isn't auto-started twice in one visit. */
export const tourSeen = {
  key: (userId: string) => `hh-workspace-tour:${userId}`,
  get(userId: string): boolean {
    try {
      return window.localStorage.getItem(this.key(userId)) === "done";
    } catch {
      return false;
    }
  },
  set(userId: string): void {
    try {
      window.localStorage.setItem(this.key(userId), "done");
    } catch {
      // Private mode or blocked storage: nothing to remember.
    }
  },
};

