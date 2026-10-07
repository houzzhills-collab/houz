"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, BedDouble, Users, X } from "lucide-react";
import { api, apiAssetUrl, errorMessage, type PublicApartment } from "@/lib/api";
import { money } from "@/app/management/workspace/format";
import { coverImage, isStay, nightsBetween, plural, stayDate } from "@/components/site";

const REFRESH_MS = 60_000;

type Loaded = { key: string; apartments: PublicApartment[] | null; error: string };

/** Published apartments, live from the API. With dates in the URL, only apartments free for the whole stay. */
export default function ApartmentsSection() {
  const params = useSearchParams();
  const checkIn = params.get("checkIn");
  const checkOut = params.get("checkOut");
  const dated = isStay(checkIn, checkOut) ? { checkIn: checkIn as string, checkOut: checkOut as string } : null;
  const key = dated ? `${dated.checkIn}/${dated.checkOut}` : "all";
  const [loaded, setLoaded] = useState<Loaded>({ key: "", apartments: null, error: "" });

  const load = useCallback(() => {
    const [from, to] = key.split("/");
    api.publicBooking
      .apartments(to ? { checkIn: from, checkOut: to } : {})
      .then((apartments) => setLoaded({ key, apartments, error: "" }))
      .catch((caught: unknown) => setLoaded((current) => ({ key, apartments: current.key === key ? current.apartments : null, error: errorMessage(caught, "We couldn't load the apartments") })));
  }, [key]);

  // Stay current while the page is open: refresh periodically and whenever the guest comes back to the tab.
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

  const apartments = loaded.key === key ? loaded.apartments : null;
  const error = loaded.key === key ? loaded.error : "";
  const query = dated ? `?${new URLSearchParams(dated).toString()}` : "";

  const clearDates = () => window.history.replaceState(null, "", `${window.location.pathname}#apartments`);

  return (
    <>
      {dated && (
        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-2xl border border-[#e6dfd2] bg-[#efeadf] px-5 py-3 text-sm text-[#263b34]">
          <span>
            Free from <b>{stayDate(dated.checkIn)}</b> to <b>{stayDate(dated.checkOut)}</b> · {plural(nightsBetween(dated.checkIn, dated.checkOut), "night")}
          </span>
          <button type="button" onClick={clearDates} className="ml-auto flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1.5 text-xs font-semibold text-[#31715d] hover:bg-white">
            <X size={13} /> Show all apartments
          </button>
        </div>
      )}

      {error && !apartments && (
        <div className="mt-12 rounded-[28px] border border-[#e6dfd2] bg-white/60 px-6 py-14 text-center">
          <p className="font-serif text-2xl text-[#263b34]">{error}</p>
          <button type="button" onClick={load} className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#31715d] hover:text-[#1f4d3f]">
            Try again <ArrowUpRight size={15} />
          </button>
        </div>
      )}

      {!apartments && !error && <ApartmentsSkeleton />}

      {apartments && apartments.length === 0 && (
        <div className="mt-12 rounded-[28px] border border-[#e6dfd2] bg-white/60 px-6 py-14 text-center">
          <p className="font-serif text-2xl text-[#263b34]">{dated ? "Nothing is free for those dates." : "New apartments are on the way."}</p>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-stone-500">
            {dated ? "Try moving your dates by a day or two, or see every apartment and its open dates." : "Check back soon, or get in touch and we'll help you plan your stay."}
          </p>
          {dated && (
            <button type="button" onClick={clearDates} className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#31715d] hover:text-[#1f4d3f]">
              Show all apartments <ArrowUpRight size={15} />
            </button>
          )}
        </div>
      )}

      {apartments && apartments.length > 0 && (
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {apartments.map((apartment, index) => {
            const cover = coverImage(apartment);
            const { capacity } = apartment;
            return (
              <Link href={`/apartments/${apartment.slug}${query}`} key={apartment.id} className="apartment-card group block">
                <div
                  className="apartment-card-media relative h-[350px] overflow-hidden rounded-[28px] bg-[#c9a982] bg-cover bg-center"
                  style={cover ? { backgroundImage: `url(${JSON.stringify(apiAssetUrl(cover.url))})` } : undefined}
                  role="img"
                  aria-label={cover?.caption ?? apartment.name}
                >
                  <div className="absolute inset-0 opacity-40 [background:linear-gradient(145deg,transparent_25%,#101d1833_100%)]" />
                  <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#101d18]/55 to-transparent" />
                  <div className="absolute left-5 top-5 rounded-full bg-white/15 px-3 py-1.5 text-[10px] text-white backdrop-blur-md">
                    {String(index + 1).padStart(2, "0")} / {String(apartments.length).padStart(2, "0")}
                  </div>
                  <div className="absolute right-5 top-5 rounded-full bg-white/15 px-3 py-1.5 text-[10px] text-white backdrop-blur-md">{apartment.category}</div>
                  <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between text-white">
                    <div>
                      <p className="text-xs text-white/75">From</p>
                      <b className="font-serif text-2xl">{money(apartment.pricing.nightlyRateKobo)}</b>
                      <span className="text-xs text-white/75"> / night</span>
                    </div>
                    <span className="apartment-card-arrow grid h-10 w-10 place-items-center rounded-full bg-white text-[#263b34]">
                      <ArrowUpRight size={17} />
                    </span>
                  </div>
                </div>
                <h3 className="mt-5 font-serif text-2xl text-[#263b34]">{apartment.name}</h3>
                <p className="mt-1 line-clamp-2 text-sm text-stone-500">{apartment.summary ?? [apartment.location.area, apartment.location.city].filter(Boolean).join(", ")}</p>
                <div className="mt-4 flex flex-wrap gap-4 text-xs text-stone-500">
                  <span className="flex items-center gap-1.5">
                    <BedDouble size={13} /> {capacity.sizeSqm ? `${capacity.sizeSqm} sqm` : plural(capacity.bedrooms, "bedroom")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Users size={13} /> Up to {plural(capacity.maxGuests, "guest")}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

export function ApartmentsSkeleton() {
  return (
    <div className="mt-12 grid gap-5 md:grid-cols-3" aria-busy="true" aria-label="Loading apartments">
      {[0, 1, 2].map((index) => (
        <div key={index} className="animate-pulse">
          <div className="h-[350px] rounded-[28px] bg-[#e9e3d7]" />
          <div className="mt-5 h-6 w-2/3 rounded-full bg-[#e9e3d7]" />
          <div className="mt-3 h-4 w-1/2 rounded-full bg-[#efeadf]" />
        </div>
      ))}
    </div>
  );
}
