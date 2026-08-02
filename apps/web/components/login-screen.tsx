import type { AuthProvider } from "@omnifin/contracts/auth";
import {
  ArrowRight,
  CircleAlert,
  CloudOff,
  KeyRound,
  Link2,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LoginProviderList } from "./login-provider-list";

export type LoginAuthError =
  | "account_not_authorized"
  | "authentication_failed"
  | "authorization_denied"
  | "invalid_request"
  | "provider_unavailable"
  | "session_limit_reached";

const AUTH_ERROR_MESSAGES: Readonly<Record<LoginAuthError, string>> = Object.freeze({
  account_not_authorized:
    "Your identity was verified, but this account is not authorized to use Omnifin.",
  authentication_failed: "Sign-in could not be completed. Please start a new attempt.",
  authorization_denied: "Sign-in was cancelled before access was granted.",
  invalid_request: "That sign-in attempt expired or was already used. Please try again.",
  provider_unavailable: "The selected identity provider is temporarily unavailable.",
  session_limit_reached:
    "This account reached the sign-in safety limit. Wait before trying again or ask an administrator to revoke older sessions.",
});

function providerDescription(provider: AuthProvider): string {
  if (provider.state === "misconfigured") return "Needs administrator attention";
  if (provider.state === "unavailable") return "Temporarily unavailable";
  if (provider.kind === "oidc") return "OpenID Connect · secure redirect";
  if (provider.passwordLoginAvailable && provider.quickConnectAvailable) {
    return "Password or Quick Connect";
  }
  return provider.quickConnectAvailable ? "Quick Connect" : "Jellyfin credentials";
}

function ProviderIcon({ kind }: Pick<AuthProvider, "kind">) {
  return kind === "oidc" ? <ShieldCheck size={19} /> : <KeyRound size={19} />;
}

function ProviderContent({ provider }: { provider: AuthProvider }) {
  return (
    <>
      <span className="login-provider__icon" aria-hidden="true">
        <ProviderIcon kind={provider.kind} />
      </span>
      <span className="login-provider__copy">
        <strong title={provider.displayName}>
          {provider.state === "available" ? "Continue with " : ""}
          {provider.displayName}
        </strong>
        <small>{providerDescription(provider)}</small>
      </span>
    </>
  );
}

function ProviderRow({ provider }: { provider: AuthProvider }) {
  if (provider.kind === "oidc" && provider.state === "unavailable") {
    return (
      <li className="login-provider__item">
        <a
          aria-label={`Retry ${provider.displayName} sign-in`}
          className="login-provider login-provider--retry"
          data-directional-item
          data-provider-state="unavailable"
          href={`/api/auth/oidc/${encodeURIComponent(provider.id)}/start`}
        >
          <ProviderContent provider={provider} />
          <RefreshCw aria-hidden="true" size={17} />
        </a>
      </li>
    );
  }
  if (provider.state !== "available") {
    return (
      <li className="login-provider__item">
        <div
          className="login-provider login-provider--disabled"
          data-provider-state={provider.state}
        >
          <ProviderContent provider={provider} />
          <Settings2 aria-hidden="true" size={17} />
        </div>
      </li>
    );
  }
  const href =
    provider.kind === "oidc"
      ? `/api/auth/oidc/${encodeURIComponent(provider.id)}/start`
      : "/login/jellyfin";
  return (
    <li className="login-provider__item">
      <a
        className="login-provider"
        data-directional-item
        data-provider-state="available"
        href={href}
      >
        <ProviderContent provider={provider} />
        <ArrowRight aria-hidden="true" size={17} />
      </a>
    </li>
  );
}

function ProviderEmptyState({ state }: { state: "ready" | "unavailable" }) {
  const unavailable = state === "unavailable";
  return (
    <div
      className="login-card__unconfigured"
      data-severity={unavailable ? "danger" : "warning"}
      role="status"
    >
      {unavailable ? (
        <CloudOff aria-hidden="true" size={22} />
      ) : (
        <Link2 aria-hidden="true" size={22} />
      )}
      <div>
        <strong>
          {unavailable ? "The control plane is unavailable" : "No sign-in providers are configured"}
        </strong>
        <p>
          {unavailable
            ? "Omnifin could not load the safe provider catalogue. No credentials were requested."
            : "An administrator needs to configure OIDC or connect Jellyfin before sign-in is available."}
        </p>
        {unavailable ? (
          <a className="login-card__retry" href="/login">
            Try again
            <ArrowRight aria-hidden="true" size={15} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function LoginHeader() {
  return (
    <header className="login-card__header">
      <BrandMark />
      <p className="eyebrow">Private by design</p>
      <h1>Welcome to your control room.</h1>
      <p>Sign in through your identity provider or directly with Jellyfin.</p>
    </header>
  );
}

function LoginFooter() {
  return (
    <footer className="login-card__footer">
      <span>No telemetry</span>
      <span aria-hidden="true">·</span>
      <span>Credentials stay in the gateway</span>
      <span aria-hidden="true">·</span>
      <a href="/about">About Omnifin</a>
    </footer>
  );
}

export function LoginScreenSkeleton({
  displayProfile = "standard",
}: {
  displayProfile?: DisplayProfile;
}) {
  return (
    <div className="login-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main aria-busy="true" className="login-card" id="main-content" tabIndex={-1}>
        <LoginHeader />
        <div className="sr-only" role="status">
          Loading secure sign-in options…
        </div>
        <div aria-hidden="true" className="login-card__providers">
          {[0, 1].map((index) => (
            <div className="login-provider login-provider--skeleton" key={index}>
              <span className="login-provider__skeleton-icon" />
              <span className="login-provider__skeleton-copy">
                <span />
                <span />
              </span>
              <span className="login-provider__skeleton-action" />
            </div>
          ))}
        </div>
        <LoginFooter />
      </main>
    </div>
  );
}

export function LoginScreen({
  authError,
  displayProfile = "standard",
  providerLoadState = "ready",
  providers,
}: {
  authError?: LoginAuthError;
  displayProfile?: DisplayProfile;
  providerLoadState?: "ready" | "unavailable";
  providers: readonly AuthProvider[];
}) {
  return (
    <div className="login-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="login-card" id="main-content" tabIndex={-1}>
        <LoginHeader />
        {authError ? (
          <div className="login-card__auth-error" role="alert">
            <CircleAlert aria-hidden="true" size={19} />
            <p>{AUTH_ERROR_MESSAGES[authError]}</p>
          </div>
        ) : null}
        {providers.length > 0 ? (
          <LoginProviderList>
            {providers.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} />
            ))}
          </LoginProviderList>
        ) : (
          <div className="login-card__providers login-card__providers--empty">
            <ProviderEmptyState state={providerLoadState} />
          </div>
        )}
        <LoginFooter />
      </main>
    </div>
  );
}
