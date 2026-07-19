import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font → bundled into the static export, so
// the desktop app renders with the right type even fully offline. Body/display
// type intentionally uses the OS system font stack (see globals.css) to match
// Instagram's own UI — no web font needed for that.
const mono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Instagram Agent",
  description: "Plan, create, and schedule Instagram posts with an AI copilot.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body>{children}</body>
    </html>
  );
}
