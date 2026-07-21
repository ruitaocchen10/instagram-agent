import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Socialite",
  description: "Plan, create, and schedule Instagram posts with an AI copilot.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
