import type { Metadata, Viewport } from "next";
import "./site.css";

export const metadata: Metadata = {
  title: { absolute: "Houzzhills | Serviced Apartments in Kaduna" },
  description: "Thoughtful serviced apartments for long weekends, longer stays, and everything in between.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#263b34",
};

/** The public website: home page and apartment pages. */
export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
