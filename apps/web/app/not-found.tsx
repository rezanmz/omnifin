import { ArrowLeft, Telescope } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "../components/brand-mark";
import { CinematicBackdrop } from "../components/cinematic-backdrop";
import "./not-found.css";

export default function NotFound() {
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";

  return (
    <div className="utility-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="utility-card" id="main-content" tabIndex={-1}>
        <BrandMark />
        <span className="utility-card__icon" aria-hidden="true">
          <Telescope size={24} />
        </span>
        <p className="eyebrow">Signal not found</p>
        <h1>This route is beyond the map.</h1>
        <p>
          The address may have changed, or the destination may not exist in this release. Your
          services and settings were not changed.
        </p>
        <Link className="button button--glass" href="/">
          <ArrowLeft aria-hidden="true" size={17} /> Return home
        </Link>
      </main>
    </div>
  );
}
