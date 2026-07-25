import { ArrowRight, KeyRound, Link2, ShieldCheck } from "lucide-react";
import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

export interface LoginProvider {
  id: string;
  label: string;
  slug: string;
  type: "oidc" | "jellyfin";
}

export function LoginScreen({
  displayProfile = "standard",
  providers,
}: {
  displayProfile?: DisplayProfile;
  providers: LoginProvider[];
}) {
  return (
    <div className="login-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="login-card" id="main-content" tabIndex={-1}>
        <header className="login-card__header">
          <BrandMark />
          <p className="eyebrow">Private by design</p>
          <h1>Welcome to your control room.</h1>
          <p>Sign in through your identity provider or directly with Jellyfin.</p>
        </header>
        <div className="login-card__providers">
          {providers.length > 0 ? (
            providers.map((provider) => (
              <a
                className="login-provider"
                href={
                  provider.type === "oidc"
                    ? `/api/auth/oidc/${provider.slug}/start`
                    : "/login/jellyfin"
                }
                key={provider.id}
              >
                <span className="login-provider__icon" aria-hidden="true">
                  {provider.type === "oidc" ? <ShieldCheck size={19} /> : <KeyRound size={19} />}
                </span>
                <span>
                  <strong>{provider.label}</strong>
                  <small>
                    {provider.type === "oidc" ? "OpenID Connect" : "Direct or Quick Connect"}
                  </small>
                </span>
                <ArrowRight aria-hidden="true" size={17} />
              </a>
            ))
          ) : (
            <div className="login-card__unconfigured" role="status">
              <Link2 aria-hidden="true" size={22} />
              <div>
                <strong>Sign-in arrives in Phase 1</strong>
                <p>
                  This foundation build does not accept account credentials. OIDC and Jellyfin
                  connection setup arrive after the Phase 1 security and integration gates pass.
                </p>
              </div>
            </div>
          )}
        </div>
        <footer className="login-card__footer">
          <span>No telemetry</span>
          <span aria-hidden="true">·</span>
          <span>Credentials stay in the gateway</span>
        </footer>
      </main>
    </div>
  );
}
