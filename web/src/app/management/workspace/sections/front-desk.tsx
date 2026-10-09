"use client";

import { AlarmClock, ArrowDownRight, ArrowUpRight, BedDouble } from "lucide-react";
import type { StaySummary, StayView } from "@/lib/api";
import { Tip } from "../ui";
import { stayIntent } from "./reservations";

const TILES: ReadonlyArray<{ view: StayView; label: string; foot: string; icon: typeof BedDouble; tip: string }> = [
  { view: "arrivals", label: "To check in", foot: "Confirmed, arriving today", icon: ArrowDownRight, tip: "Confirmed guests due to check in today, including late arrivals whose stay hasn't ended." },
  { view: "in_house", label: "In house", foot: "Checked in now", icon: BedDouble, tip: "Guests checked in right now." },
  { view: "departing", label: "Due out", foot: "Today or tomorrow", icon: ArrowUpRight, tip: "Checked-in guests due to check out today or tomorrow." },
  { view: "overstay", label: "Overstays", foot: "Past their check-out date", icon: AlarmClock, tip: "Checked-in guests whose check-out date has passed. Check them out (an overstay incident is suggested) or extend the stay." },
];

/** Today's check-ins, in-house guests, departures and overstays; each tile opens that list in Reservations. */
export function FrontDesk({ summary, onOpen }: { summary: StaySummary; onOpen: (intent: string) => void }) {
  return (
    <section className="panel front-desk-panel" aria-label="Front desk">
      <div className="panel-heading">
        <div>
          <h2>
            Front desk
            <Tip text="Who is arriving, staying, leaving and overstaying today. Select a tile to see those guests and check them in or out." />
          </h2>
          <p>Check-ins, departures and overstays</p>
        </div>
      </div>
      <div className="front-desk-tiles">
        {TILES.map(({ view, label, foot, icon: Icon, tip }) => (
          <button key={view} className={`front-desk-tile ${view === "overstay" && summary.overstay > 0 ? "is-alert" : ""}`} onClick={() => onOpen(stayIntent(view))} data-tip={tip}>
            <span>
              <Icon size={15} /> {label}
            </span>
            <strong>{summary[view]}</strong>
            <small>{foot}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
