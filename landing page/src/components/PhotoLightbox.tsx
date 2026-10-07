"use client";

import Image from "next/image";
import { Expand, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

type PhotoLightboxProps = {
  src: string;
  alt: string;
  className: string;
  imageClassName?: string;
  sizes?: string;
  children?: ReactNode;
};

export default function PhotoLightbox({
  src,
  alt,
  className,
  imageClassName = "object-cover",
  sizes = "(max-width: 640px) 100vw, (max-width: 1024px) 80vw, 60vw",
  children,
}: PhotoLightboxProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label={`View larger image: ${alt}`}
        onClick={() => setOpen(true)}
        className={`group relative block cursor-zoom-in overflow-hidden text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#dfb56f] ${className}`}
      >
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          className={`transition duration-700 ease-out group-hover:scale-[1.06] group-hover:brightness-105 group-active:scale-[1.02] motion-reduce:transform-none ${imageClassName}`}
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#172d27]/45 via-transparent to-transparent opacity-40 transition-opacity duration-500 group-hover:opacity-100 group-focus-visible:opacity-100" />
        <span aria-hidden="true" className="pointer-events-none absolute right-4 top-4 inline-flex translate-y-1 items-center gap-2 rounded-full border border-white/25 bg-[#172d27]/65 px-3 py-2 text-[11px] font-medium text-white opacity-0 shadow-lg backdrop-blur-md transition duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <Expand size={13} /> View photo
        </span>
        {children}
      </button>

      <dialog
        ref={dialogRef}
        aria-label={alt}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        className="fixed inset-0 m-auto max-h-none max-w-none overflow-visible bg-transparent p-0 text-white backdrop:bg-[#101d18]/90"
      >
        <div className="relative mx-auto h-[78dvh] w-[94vw] max-w-6xl">
          <button
            type="button"
            aria-label="Close enlarged image"
            autoFocus
            onClick={() => setOpen(false)}
            className="absolute -top-12 right-0 z-10 grid h-10 w-10 place-items-center rounded-full border border-white/20 bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dfb56f] sm:-right-12 sm:top-0"
          >
            <X size={19} />
          </button>
          <Image src={src} alt={alt} fill sizes="94vw" className="object-contain" />
          <p className="absolute inset-x-0 -bottom-8 truncate text-center text-xs text-white/70 sm:-bottom-7">
            {alt}
          </p>
        </div>
      </dialog>
    </>
  );
}
