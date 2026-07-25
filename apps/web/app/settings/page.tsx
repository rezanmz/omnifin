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
        <p className="eyebrow">Secure foundation</p>
        <h1>Account setup arrives in Phase 1.</h1>
        <p>
          This foundation build is ready for deployment review, but it does not yet accept
          credentials or connect to media services. Phase 1 introduces OIDC and Jellyfin sign-in,
          explicit account pairing, local roles, encrypted administration, and audit trails after
          those flows pass their security and integration gates.
        </p>
        <Link className="button button--glass" href="/">
          <ArrowLeft aria-hidden="true" size={17} /> Return home
        </Link>
      </main>
    </div>
  );
}
