"use client";

import { FormEvent, useMemo, useState } from "react";
import { ArrowUpRight, CalendarDays } from "lucide-react";

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function AvailabilityWidget() {
  const minimumDate = useMemo(() => today(), []);
  const [dates, setDates] = useState({ checkIn: "", checkOut: "" });
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dates.checkIn || !dates.checkOut) return;
    if (dates.checkIn < minimumDate) return setError("Choose a check-in date from today onwards.");
    if (dates.checkOut <= dates.checkIn) return setError("Check-out must be after check-in.");
    setError("");
    document.getElementById("apartments")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <form onSubmit={submit} className="grid w-full min-w-0 overflow-hidden rounded-2xl border border-white/15 bg-white/10 backdrop-blur-lg sm:grid-cols-[1fr_1fr_auto]">
      <label className="min-w-0 border-b border-white/10 p-5 text-left sm:border-b-0 sm:border-r">
        <span className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[.16em] text-[#bfcfc6]"><CalendarDays size={13} /> Check in</span>
        <input aria-label="Check in date" required type="date" min={minimumDate} value={dates.checkIn} onChange={(event) => { setDates({ ...dates, checkIn: event.target.value }); setError(""); }} className="min-w-0 w-full bg-transparent text-sm font-semibold text-white outline-none [color-scheme:dark]" />
      </label>
      <label className="min-w-0 border-b border-white/10 p-5 text-left sm:border-b-0 sm:border-r">
        <span className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[.16em] text-[#bfcfc6]"><CalendarDays size={13} /> Check out</span>
        <input aria-label="Check out date" required type="date" min={dates.checkIn || minimumDate} value={dates.checkOut} onChange={(event) => { setDates({ ...dates, checkOut: event.target.value }); setError(""); }} className="min-w-0 w-full bg-transparent text-sm font-semibold text-white outline-none [color-scheme:dark]" />
      </label>
      <button type="submit" className="flex min-h-[76px] min-w-0 items-center justify-between gap-6 p-5 text-left text-sm font-semibold text-[#e4bc7b] transition hover:bg-white/10">Check availability <ArrowUpRight size={17} /></button>
      {error && <p className="col-span-full border-t border-red-200/20 bg-red-950/20 px-5 py-2 text-left text-xs text-red-100">{error}</p>}
    </form>
  );
}
