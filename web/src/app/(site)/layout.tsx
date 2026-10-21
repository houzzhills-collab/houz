import type { Metadata, Viewport } from "next";
import "./site.css";

export const metadata: Metadata = {
  title: { absolute: "Houzzhills | Serviced Apartments in Kaduna" },
  description: "Thoughtfully furnished serviced apartments for business trips, family visits and extended stays. Enjoy the privacy of your own space, with attentive support throughout your stay.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#263b34",
};

/** The public website: home page and apartment pages. */
export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
