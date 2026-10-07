"use client";

import { Menu, X } from "lucide-react";
import { useState } from "react";

export default function MobileMenu() {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative md:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="grid h-10 w-10 place-items-center rounded-full border border-white/20 text-white"
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-black/20"
          />
          <div className="absolute right-0 top-12 z-50 w-52 rounded-2xl bg-white p-3 text-sm text-stone-700 shadow-2xl">
            <a href="#apartments" onClick={() => setOpen(false)} className="block rounded-xl px-3 py-3 hover:bg-stone-100">
              Apartments
            </a>
            <a href="#gallery" onClick={() => setOpen(false)} className="block rounded-xl px-3 py-3 hover:bg-stone-100">
              Gallery
            </a>
            <a href="#experience" onClick={() => setOpen(false)} className="block rounded-xl px-3 py-3 hover:bg-stone-100">
              The experience
            </a>
            <a href="#availability" onClick={() => setOpen(false)} className="mt-1 block rounded-xl bg-[#263b34] px-3 py-3 font-semibold text-white">
              Check availability
            </a>
          </div>
        </>
      )}
    </div>
  );
}
