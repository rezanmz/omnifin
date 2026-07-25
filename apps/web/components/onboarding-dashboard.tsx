import { ArrowRight, KeyRound, Layers3, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

const steps = [
  {
    copy: "Phase 1 adds OIDC and Jellyfin sign-in with explicit account pairing and local roles.",
    icon: ShieldCheck,
    label: "Identity without lock-in",
  },
  {
    copy: "Library, request, acquisition, subtitle, and download signals will meet in one calm workspace.",
    icon: Layers3,
    label: "One place for every signal",
  },
  {
    copy: "No telemetry leaves your deployment, and service credentials stay behind the gateway boundary.",
    icon: KeyRound,
    label: "Private from first boot",
  },
] as const;

export function OnboardingDashboard({
  displayProfile = "standard",
}: {
  displayProfile?: DisplayProfile;
}) {
  return (
    <div className="onboarding-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <header className="onboarding-masthead">
        <BrandMark />
        <span className="onboarding-masthead__status">
          <ShieldCheck aria-hidden="true" size={16} /> Secure foundation
        </span>
      </header>
      <main className="onboarding" id="main-content" tabIndex={-1}>
        <section className="onboarding__hero" aria-labelledby="onboarding-title">
          <div className="onboarding__orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="onboarding__copy">
            <p className="eyebrow">A private control plane</p>
            <h1 id="onboarding-title">Your media control room is being prepared.</h1>
            <p>
              This foundation release is ready for deployment review. It does not accept account
              credentials or connect to media services, keeping your stack untouched until secure
              setup passes the Phase 1 security and integration gates.
            </p>
            <Link className="button button--primary" href="/settings">
              View release readiness <ArrowRight aria-hidden="true" size={17} />
            </Link>
          </div>
        </section>
        <section className="onboarding__steps" aria-label="What comes next">
          {steps.map(({ copy, icon: Icon, label }, index) => (
            <article className="onboarding-step" key={label}>
              <span className="onboarding-step__index">0{index + 1}</span>
              <Icon aria-hidden="true" size={22} strokeWidth={1.45} />
              <h2>{label}</h2>
              <p>{copy}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
