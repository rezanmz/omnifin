import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { readThemePreference } from "../lib/theme-server";
import "./globals.css";

// Per-request rendering is required so the proxy's CSP nonce reaches every
// framework and application script, including not-found and error surfaces.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  applicationName: "Omnifin",
  description: "A cinematic, secure control plane for your self-hosted media stack.",
  metadataBase: new URL(process.env.OMNIFIN_BASE_URL ?? "http://localhost:3000"),
  robots: { follow: false, index: false },
  title: { default: "Omnifin", template: "%s · Omnifin" },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  viewportFit: "cover",
  width: "device-width",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const preference = await readThemePreference();
  const explicitTheme = preference === "system" ? undefined : preference;

  return (
    <html
      data-scroll-behavior="smooth"
      data-theme={explicitTheme}
      data-theme-preference={preference}
      lang="en"
    >
      <head>
        <meta
          content={explicitTheme === "dark" ? "#070a0d" : "#eef3f5"}
          media="(prefers-color-scheme: light)"
          name="theme-color"
        />
        <meta
          content={explicitTheme === "light" ? "#eef3f5" : "#070a0d"}
          media="(prefers-color-scheme: dark)"
          name="theme-color"
        />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
