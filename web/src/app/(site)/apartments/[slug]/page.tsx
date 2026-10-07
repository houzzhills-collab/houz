"use client";

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Bath, BedDouble, Check, Clock3, MapPin, Moon, Ruler, Users } from "lucide-react";
import { api, ApiError, errorMessage, type Property, type PublicApartmentDetail } from "@/lib/api";
import { applyProperty, money } from "@/app/management/workspace/format";
import ApartmentGallery from "@/components/ApartmentGallery";
import BookingPanel from "@/components/BookingPanel";
import SiteFooter from "@/components/SiteFooter";
import SiteNav from "@/components/SiteNav";
import { isStay, plural } from "@/components/site";

const REFRESH_MS = 60_000;

type Loaded = { slug: string; detail: PublicApartmentDetail | null; error: string; missing: boolean };

function ApartmentPage() {
  const { slug } = useParams<{ slug: string }>();
  const params = useSearchParams();
  const checkIn = params.get("checkIn");
  const checkOut = params.get("checkOut");
  const initial = isStay(checkIn, checkOut) ? { checkIn: checkIn as string, checkOut: checkOut as string } : null;
  const [loaded, setLoaded] = useState<Loaded>({ slug: "", detail: null, error: "", missing: false });
  // Re-renders once the property's timezone is known, so business dates follow it.
  const [, setProperty] = useState<Property | null>(null);

  useEffect(() => {
    api.publicBooking
      .property()
      .then((value) => {
        applyProperty(value);
        setProperty(value);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    api.publicBooking
      .apartment(slug)
      .then((detail) => setLoaded({ slug, detail, error: "", missing: false }))
      .catch((caught: unknown) =>
        setLoaded((current) => ({
          slug,
          detail: current.slug === slug ? current.detail : null,
          error: errorMessage(caught, "We couldn't load this apartment"),
          missing: caught instanceof ApiError && caught.status === 404,
        })),
      );
  }, [slug]);

  // Booked dates stay current while the guest is choosing.
  useEffect(() => {
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const current = loaded.slug === slug ? loaded : null;
  const detail = current?.missing ? null : current?.detail;
  const apartment = detail?.apartment;

  useEffect(() => {
    if (apartment) document.title = `${apartment.name} | Houzzhills`;
  }, [apartment]);

  return (
    <div className="site min-h-screen bg-[#f8f6f1] text-[#202b28]">
      <section className="relative overflow-hidden bg-[#263b34] text-[#f7f4ed]">
        <div className="absolute right-[-8%] top-[-40%] h-[520px] w-[58%] rotate-[-16deg] rounded-[45%] border border-white/10" />
        <SiteNav base="/" />
        <div className="relative z-10 mx-auto max-w-7xl px-6 pb-14 pt-6 lg:px-10 lg:pb-16">
          <Link href="/#apartments" className="inline-flex items-center gap-2 text-sm text-[#d6dfd9] hover:text-white">
            <ArrowLeft size={15} /> All apartments
          </Link>
          {apartment ? (
            <>
              <p className="mt-8 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[.28em] text-[#e0b876]">
                <span className="h-px w-8 bg-[#e0b876]" /> {apartment.category}
              </p>
              <h1 className="mt-4 max-w-3xl font-serif text-[clamp(2.5rem,8vw,4.5rem)] leading-[1] tracking-[-.03em]">{apartment.name}</h1>
              {apartment.summary && <p className="mt-5 max-w-xl text-base leading-7 text-[#cad5cf]">{apartment.summary}</p>}
              <div className="mt-7 flex flex-wrap gap-2 text-xs text-[#dce5df]">
                <Chip icon={<MapPin size={13} />}>{[apartment.location.area, apartment.location.city, apartment.location.state].filter(Boolean).join(", ")}</Chip>
                <Chip icon={<Users size={13} />}>Up to {plural(apartment.capacity.maxGuests, "guest")}</Chip>
                <Chip icon={<BedDouble size={13} />}>{plural(apartment.capacity.bedrooms, "bedroom")}</Chip>
                {apartment.capacity.sizeSqm && <Chip icon={<Ruler size={13} />}>{apartment.capacity.sizeSqm} sqm</Chip>}
              </div>
            </>
          ) : (
            <div className="mt-8 h-40" />
          )}
        </div>
      </section>

      {current?.missing ? (
        <section className="mx-auto max-w-3xl px-6 py-24 text-center">
          <p className="font-serif text-4xl text-[#263b34]">This apartment isn&apos;t available.</p>
          <p className="mx-auto mt-4 max-w-md text-sm leading-7 text-stone-500">It may have been renamed or taken off the site. Our other apartments are a click away.</p>
          <Link href="/#apartments" className="site-cta mt-8 inline-flex items-center gap-3 rounded-full bg-[#263b34] px-7 py-4 text-sm font-semibold text-white hover:bg-[#1a2c26]">
            See all apartments <ArrowUpRight size={16} />
          </Link>
        </section>
      ) : !apartment ? (
        <section className="mx-auto max-w-7xl px-6 py-14 lg:px-10">
          {current?.error ? (
            <div className="rounded-[28px] border border-[#e6dfd2] bg-white/60 px-6 py-14 text-center">
              <p className="font-serif text-2xl text-[#263b34]">{current.error}</p>
              <button type="button" onClick={load} className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#31715d] hover:text-[#1f4d3f]">
                Try again <ArrowUpRight size={15} />
              </button>
            </div>
          ) : (
            <div className="h-[280px] animate-pulse rounded-[28px] bg-[#e9e3d7] sm:h-[460px]" aria-busy="true" aria-label="Loading apartment" />
          )}
        </section>
      ) : (
        <>
          <section className="mx-auto max-w-7xl px-6 pt-10 lg:px-10 lg:pt-14">
            <ApartmentGallery name={apartment.name} images={apartment.images} />
          </section>

          <section className="mx-auto grid max-w-7xl gap-12 px-6 py-14 lg:grid-cols-[1fr_400px] lg:px-10 lg:py-20">
            <div className="min-w-0 space-y-12">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Fact icon={<Users size={18} />} label="Guests" value={`Up to ${apartment.capacity.maxGuests}`} />
                <Fact icon={<BedDouble size={18} />} label="Bedrooms" value={`${apartment.capacity.bedrooms} · ${plural(apartment.capacity.beds, "bed")}`} />
                <Fact icon={<Bath size={18} />} label="Bathrooms" value={String(apartment.capacity.bathrooms)} />
                {apartment.capacity.sizeSqm && <Fact icon={<Ruler size={18} />} label="Size" value={`${apartment.capacity.sizeSqm} sqm`} />}
                <Fact icon={<Moon size={18} />} label="Minimum stay" value={plural(apartment.stayRules.minimumNights, "night")} />
                <Fact icon={<Clock3 size={18} />} label="Check-in / out" value={`${apartment.stayRules.checkInTime} / ${apartment.stayRules.checkOutTime}`} />
              </div>

              {apartment.description && (
                <Block eyebrow="About this apartment" title="Make yourself at home.">
                  <p className="whitespace-pre-line text-sm leading-7 text-stone-600">{apartment.description}</p>
                </Block>
              )}

              <List eyebrow="In the apartment" title="Amenities" items={apartment.amenities} />
              <List eyebrow="Why guests love it" title="Features" items={apartment.features} />
              <List eyebrow="On site" title="Facilities" items={apartment.facilities} />

              <Block eyebrow="Good to know" title="Your stay">
                <dl className="divide-y divide-[#e6dfd2] rounded-2xl bg-white/60 text-sm">
                  <Row label="Check-in" value={`From ${apartment.stayRules.checkInTime}`} />
                  <Row label="Check-out" value={`By ${apartment.stayRules.checkOutTime}`} />
                  <Row label="Minimum stay" value={plural(apartment.stayRules.minimumNights, "night")} />
                  {BigInt(apartment.pricing.cautionFeeKobo) > 0n && <Row label="Caution fee" value={`${money(apartment.pricing.cautionFeeKobo)} · separate from the stay total`} />}
                  <Row label="Location" value={[apartment.location.area, apartment.location.city, apartment.location.state, apartment.location.country].filter(Boolean).join(", ")} />
                </dl>
                <p className="mt-3 text-xs text-stone-500">The exact address and directions are in your confirmation email.</p>
              </Block>

              <List eyebrow="Please note" title="House rules" items={apartment.houseRules} />

              {(apartment.policies.cancellation || apartment.policies.warranty) && (
                <Block eyebrow="Policies" title="The fine print, kept simple.">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {apartment.policies.cancellation && <Policy title="Cancellation" text={apartment.policies.cancellation} />}
                    {apartment.policies.warranty && <Policy title="Damage & warranty" text={apartment.policies.warranty} />}
                  </div>
                </Block>
              )}
            </div>

            <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
              <BookingPanel key={apartment.id} apartment={apartment} bookedRanges={detail.bookedRanges} initial={initial} />
            </aside>
          </section>

          <div className="sticky bottom-0 z-40 flex items-center justify-between gap-4 border-t border-[#e6dfd2] bg-[#f8f6f1]/95 px-6 py-4 backdrop-blur-md lg:hidden">
            <p>
              <b className="font-serif text-xl text-[#263b34]">{money(apartment.pricing.nightlyRateKobo)}</b>
              <span className="text-xs text-stone-500"> / night</span>
            </p>
            <a href="#book" className="inline-flex items-center gap-2 rounded-full bg-[#263b34] px-5 py-3 text-sm font-semibold text-white">
              Check availability <ArrowUpRight size={15} />
            </a>
          </div>
        </>
      )}

      <SiteFooter base="/" />
    </div>
  );
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 backdrop-blur-md">
      {icon} {children}
    </span>
  );
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/60 p-4">
      <span className="text-[#31715d]">{icon}</span>
      <span className="mt-3 block text-xs text-stone-500">{label}</span>
      <b className="mt-1 block text-sm">{value}</b>
    </div>
  );
}

function Block({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[.25em] text-[#b28247]">{eyebrow}</p>
      <h2 className="mb-6 mt-3 font-serif text-3xl tracking-tight text-[#263b34]">{title}</h2>
      {children}
    </div>
  );
}

function List({ eyebrow, title, items }: { eyebrow: string; title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Block eyebrow={eyebrow} title={title}>
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-3 text-sm text-stone-700">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#e3eee8] text-[#31715d]">
              <Check size={14} />
            </span>
            {item}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-[#263b34] sm:text-right">{value}</dd>
    </div>
  );
}

function Policy({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl bg-white/60 p-5">
      <b className="text-sm text-[#263b34]">{title}</b>
      <p className="mt-2 whitespace-pre-line text-xs leading-6 text-stone-600">{text}</p>
    </div>
  );
}

export default function ApartmentRoute() {
  return (
    <Suspense>
      <ApartmentPage />
    </Suspense>
  );
}
