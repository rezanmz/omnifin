import { ArrowRight, KeyRound, Layers3, ShieldCheck } from "lucide-react";
import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

const steps = [
  {
    copy: "Sign in with OIDC or Jellyfin, then pair, relink, or revoke your media identity with proof instead of guesswork.",
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
              Secure sign-in, Jellyfin Quick Connect, account pairing, service connections, and
              local authorization are ready for configuration. Start with identity, then connect
              each media service and validate it before enablement.
            </p>
            <a className="button button--primary" href="/settings">
              Review account access <ArrowRight aria-hidden="true" size={17} />
            </a>
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
