import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
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
  colorScheme: "dark",
  themeColor: "#060807",
  viewportFit: "cover",
  width: "device-width",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html data-scroll-behavior="smooth" lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
