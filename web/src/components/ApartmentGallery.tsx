"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight, Expand, Images, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiAssetUrl, type PublicApartment } from "@/lib/api";

type Photo = PublicApartment["images"][number];

/** The apartment's photos: a mosaic that opens a full-screen viewer with previous/next. */
export default function ApartmentGallery({ name, images }: { name: string; images: Photo[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const count = images.length;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open !== null && !dialog.open) dialog.showModal();
    if (open === null && dialog.open) dialog.close();
  }, [open]);

  if (count === 0) return <div className="h-[280px] rounded-[28px] bg-gradient-to-br from-[#c9a982] via-[#96795b] to-[#3b4c43] sm:h-[460px]" />;

  const step = (by: number) => setOpen((index) => (index === null ? null : (index + by + count) % count));
  const alt = (photo: Photo, index: number) => photo.caption ?? `${name}, photo ${index + 1} of ${count}`;
  const tiles = images.slice(0, 3);
  const current = open === null ? null : images[open];

  return (
    <>
      <div className={`grid gap-4 ${count > 1 ? "sm:grid-cols-[1.35fr_.65fr]" : ""}`}>
        {tiles.map((photo, index) => (
          <button
            key={photo.id}
            type="button"
            aria-label={`View larger image: ${alt(photo, index)}`}
            onClick={() => setOpen(index)}
            className={`group relative block cursor-zoom-in overflow-hidden rounded-[28px] bg-[#c9a982] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#dfb56f] ${
              index === 0 ? `h-[280px] sm:h-[460px] ${count > 2 ? "sm:row-span-2" : ""}` : `hidden h-[222px] sm:block ${count === 2 ? "sm:h-[460px]" : ""}`
            }`}
          >
            <Image
              src={apiAssetUrl(photo.url)}
              alt={alt(photo, index)}
              fill
              unoptimized
              preload={index === 0}
              className="object-cover transition duration-700 ease-out group-hover:scale-[1.06] group-hover:brightness-105 motion-reduce:transform-none"
            />
            <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#172d27]/45 via-transparent to-transparent opacity-40 transition-opacity duration-500 group-hover:opacity-100" />
            <span aria-hidden="true" className="pointer-events-none absolute right-4 top-4 inline-flex translate-y-1 items-center gap-2 rounded-full border border-white/25 bg-[#172d27]/65 px-3 py-2 text-xs font-medium text-white opacity-0 shadow-lg backdrop-blur-md transition duration-300 group-hover:translate-y-0 group-hover:opacity-100">
              <Expand size={13} /> View photo
            </span>
            {photo.caption && <span className="pointer-events-none absolute bottom-5 left-5 right-5 truncate text-[15px] font-medium text-white">{photo.caption}</span>}
          </button>
        ))}
      </div>
      {count > 1 && (
        <button type="button" onClick={() => setOpen(0)} className="mt-4 inline-flex items-center gap-2 text-[15px] font-semibold text-[#31715d] hover:text-[#1f4d3f]">
          <Images size={15} /> View all {count} photos
        </button>
      )}

      <dialog
        ref={dialogRef}
        aria-label={`${name} photos`}
        onClose={() => setOpen(null)}
        onClick={(event) => event.target === event.currentTarget && setOpen(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") step(1);
          if (event.key === "ArrowLeft") step(-1);
        }}
        className="fixed inset-0 m-auto max-h-none max-w-none overflow-visible bg-transparent p-0 text-white backdrop:bg-[#101d18]/90"
      >
        {current && open !== null && (
          <div className="relative mx-auto h-[78dvh] w-[94vw] max-w-6xl">
            <button
              type="button"
              aria-label="Close photos"
              autoFocus
              onClick={() => setOpen(null)}
              className="absolute -top-12 right-0 z-10 grid h-10 w-10 place-items-center rounded-full border border-white/20 bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20 sm:-right-12 sm:top-0"
            >
              <X size={19} />
            </button>
            <Image key={current.id} src={apiAssetUrl(current.url)} alt={alt(current, open)} fill unoptimized sizes="94vw" className="object-contain" />
            {count > 1 && (
              <>
                <button type="button" aria-label="Previous photo" onClick={() => step(-1)} className="absolute left-2 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-[#172d27]/60 backdrop-blur-md hover:bg-[#172d27]/80 sm:-left-14">
                  <ChevronLeft size={20} />
                </button>
                <button type="button" aria-label="Next photo" onClick={() => step(1)} className="absolute right-2 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-[#172d27]/60 backdrop-blur-md hover:bg-[#172d27]/80 sm:-right-14">
                  <ChevronRight size={20} />
                </button>
              </>
            )}
            <p className="absolute inset-x-0 -bottom-8 truncate text-center text-[13px] text-white/70 sm:-bottom-7">
              {open + 1} / {count}
              {current.caption ? ` · ${current.caption}` : ""}
            </p>
          </div>
        )}
      </dialog>
    </>
  );
}
