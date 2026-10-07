import Link from "next/link";
import MobileMenu from "@/components/MobileMenu";

/** Light-on-dark site navigation. `base` is "/" on pages other than the home page, so section links lead back to it. */
export default function SiteNav({ base = "" }: { base?: "" | "/" }) {
  return (
    <nav className="relative z-50 mx-auto flex w-full min-w-0 max-w-7xl items-center justify-between px-4 py-6 sm:px-6 lg:px-10">
      <Link href="/" className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d4a25e] font-serif text-xl font-bold text-[#25372f]">H</span>
        <span>
          <b className="block font-serif text-lg tracking-tight">Houzzhills</b>
          <small className="block text-[10px] uppercase tracking-[.25em] text-[#c8d3cd]">Apartments · Kaduna</small>
        </span>
      </Link>
      <div className="hidden items-center gap-8 text-[15px] text-[#d1dbd5] md:flex">
        <a href={`${base}#apartments`} className="hover:text-white">Apartments</a>
        <a href={`${base}#gallery`} className="hover:text-white">Gallery</a>
        <a href={`${base}#experience`} className="hover:text-white">The experience</a>
        <Link href="/bookings" className="rounded-full border border-white/20 px-4 py-2 hover:border-white/40 hover:text-white">My bookings</Link>
      </div>
      <MobileMenu base={base} />
    </nav>
  );
}
