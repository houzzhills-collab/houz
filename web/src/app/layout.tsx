import type { Metadata } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import "./globals.css";

// Self-hosted at build time; the browser never calls Google.
const ui = DM_Sans({ subsets: ["latin"], display: "swap", variable: "--font-ui", axes: ["opsz"] });
const display = Fraunces({ subsets: ["latin"], display: "swap", variable: "--font-display", axes: ["opsz", "SOFT"] });

export const metadata: Metadata = {
  title: { default: "Houzz Hills Operations", template: "%s | Houzz Hills" },
  description: "Property operations workspace and online booking.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-NG" className={`${ui.variable} ${display.variable}`}>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
