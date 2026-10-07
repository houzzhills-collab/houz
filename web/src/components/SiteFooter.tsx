import Link from "next/link";

export default function SiteFooter({ base = "" }: { base?: "" | "/" }) {
  return (
    <footer className="border-t border-[#e6dfd2] bg-[#f1ede5]">
      <div className="mx-auto flex max-w-7xl flex-col justify-between gap-8 px-6 py-10 md:flex-row md:items-end lg:px-10">
        <div>
          <Link href="/" className="font-serif text-2xl text-[#263b34]">Houzzhills.</Link>
          <p className="mt-2 text-xs text-stone-500">Serviced apartments, thoughtfully finished.</p>
        </div>
        <div className="flex flex-wrap gap-6 text-xs text-stone-500">
          <a href={`${base}#apartments`} className="hover:text-[#263b34]">Apartments</a>
          <a href={`${base}#gallery`} className="hover:text-[#263b34]">Gallery</a>
          <a href={`${base}#experience`} className="hover:text-[#263b34]">Experience</a>
        </div>
        <p className="text-xs text-stone-400">© {new Date().getFullYear()} Houzzhills Apartments · Kaduna</p>
      </div>
    </footer>
  );
}
