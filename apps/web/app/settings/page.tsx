import { ArrowLeft, Construction } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import { BrandMark } from "../../components/brand-mark";
import { CinematicBackdrop } from "../../components/cinematic-backdrop";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  return (
    <div className="utility-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="utility-card" id="main-content" tabIndex={-1}>
        <BrandMark />
        <span className="utility-card__icon" aria-hidden="true">
          <Construction size={24} />
        </span>
        <p className="eyebrow">Identity foundation</p>
        <h1>Account setup is still being secured.</h1>
        <p>
          OIDC sign-in, local sessions, and recovery now run behind the gateway boundary, but this
          pre-release checkpoint has no supported provider or account administration. Direct
          Jellyfin password sign-in is available for a deployment-configured server; Quick Connect,
          OIDC pairing, identity-provider logout, connector setup, and media operations remain
          gated.
        </p>
        <Link className="button button--glass" href="/">
          <ArrowLeft aria-hidden="true" size={17} /> Return home
        </Link>
      </main>
    </div>
  );
}
