"use client";

import type { AuthenticatedSessionResponse } from "@omnifin/contracts/auth";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RadioTower,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

export type JellyfinCredentialStatus =
  "idle" | "invalid_credentials" | "rate_limited" | "submitting" | "unavailable";

type CredentialOutcome = Exclude<JellyfinCredentialStatus, "idle" | "submitting"> | "success";

export interface JellyfinCredentials {
  password: string;
  username: string;
}

export interface JellyfinCredentialScreenProperties {
  displayProfile?: DisplayProfile;
  initialStatus?: JellyfinCredentialStatus;
  onAuthenticated?: () => void;
  submitCredentials?: (credentials: JellyfinCredentials) => Promise<CredentialOutcome>;
}

const STATUS_MESSAGES: Readonly<
  Record<Exclude<JellyfinCredentialStatus, "idle" | "submitting">, string>
> = Object.freeze({
  invalid_credentials: "That Jellyfin username or password was not accepted.",
  rate_limited: "Too many attempts were made. Wait a moment, then try again.",
  unavailable: "Jellyfin authentication is temporarily unavailable.",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthenticatedSessionResponse(value: unknown): value is AuthenticatedSessionResponse {
  if (!isRecord(value) || !/^[A-Za-z0-9_-]{43,128}$/.test(String(value.csrfToken ?? ""))) {
    return false;
  }
  const principal = value.principal;
  if (!isRecord(principal) || principal.accountState !== "active") return false;
  const method = principal.authenticationMethod;
  return (
    typeof principal.sessionId === "string" &&
    typeof principal.userId === "string" &&
    isRecord(method) &&
    method.kind === "jellyfin"
  );
}

async function defaultSubmitCredentials(
  credentials: JellyfinCredentials,
): Promise<CredentialOutcome> {
  try {
    const response = await fetch("/api/auth/jellyfin/password", {
      body: JSON.stringify(credentials),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (response.ok) {
      const body = (await response.json()) as unknown;
      return isAuthenticatedSessionResponse(body) ? "success" : "unavailable";
    }
    if (response.status === 401) return "invalid_credentials";
    if (response.status === 429) return "rate_limited";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

function defaultAuthenticatedNavigation() {
  window.location.assign("/");
}

export function JellyfinCredentialScreen({
  displayProfile = "standard",
  initialStatus = "idle",
  onAuthenticated = defaultAuthenticatedNavigation,
  submitCredentials = defaultSubmitCredentials,
}: JellyfinCredentialScreenProperties) {
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [status, setStatus] = useState<JellyfinCredentialStatus>(initialStatus);
  const [username, setUsername] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);
  const restorePasswordFocus = useRef(false);
  const submitting = status === "submitting";
  const error = status !== "idle" && status !== "submitting" ? STATUS_MESSAGES[status] : null;

  useEffect(() => {
    if (!error || !restorePasswordFocus.current) return;
    restorePasswordFocus.current = false;
    passwordInput.current?.focus();
  }, [error]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || username.trim().length === 0 || password.length === 0) return;
    setStatus("submitting");
    const outcome = await submitCredentials({ password, username: username.trim() });
    setPassword("");
    setPasswordVisible(false);
    if (outcome === "success") {
      onAuthenticated();
      return;
    }
    restorePasswordFocus.current = true;
    setStatus(outcome);
  };

  return (
    <div className="jellyfin-login-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="jellyfin-login-card" id="main-content" tabIndex={-1}>
        <section className="jellyfin-login-card__intro" aria-labelledby="jellyfin-login-title">
          <BrandMark />
          <a className="jellyfin-login-card__back" href="/login">
            <ArrowLeft aria-hidden="true" size={16} />
            All sign-in methods
          </a>
          <div className="jellyfin-login-card__headline">
            <p className="eyebrow">Jellyfin identity</p>
            <h1 id="jellyfin-login-title">Step into your library.</h1>
            <p>
              Authenticate directly against your Jellyfin server. Omnifin never stores your
              password.
            </p>
          </div>
          <ul className="jellyfin-login-card__assurances" aria-label="Credential safeguards">
            <li>
              <LockKeyhole aria-hidden="true" size={17} />
              Password discarded after verification
            </li>
            <li>
              <ShieldCheck aria-hidden="true" size={17} />
              Session and token remain gateway-side
            </li>
            <li>
              <RadioTower aria-hidden="true" size={17} />
              No external telemetry
            </li>
          </ul>
        </section>

        <section className="jellyfin-login-card__form-panel" aria-label="Jellyfin sign in">
          <div className="jellyfin-login-card__method-icon" aria-hidden="true">
            <KeyRound size={22} />
          </div>
          <div className="jellyfin-login-card__form-heading">
            <p className="section-kicker">Direct authentication</p>
            <h2>Use your Jellyfin account</h2>
            <p>Your server verifies these credentials and returns a revocable access token.</p>
          </div>

          <form aria-busy={submitting} className="jellyfin-login-form" onSubmit={submit}>
            <label className="jellyfin-login-field">
              <span>Username</span>
              <input
                autoCapitalize="none"
                autoComplete="username"
                disabled={submitting}
                maxLength={160}
                name="username"
                onChange={(event) => setUsername(event.currentTarget.value)}
                required
                spellCheck={false}
                type="text"
                value={username}
              />
            </label>

            <div className="jellyfin-login-field">
              <label htmlFor="jellyfin-password">Password</label>
              <span className="jellyfin-login-field__password">
                <input
                  autoComplete="current-password"
                  disabled={submitting}
                  id="jellyfin-password"
                  maxLength={1_024}
                  name="password"
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  ref={passwordInput}
                  required
                  type={passwordVisible ? "text" : "password"}
                  value={password}
                />
                <button
                  aria-label={passwordVisible ? "Hide password" : "Show password"}
                  className="jellyfin-login-field__reveal"
                  disabled={submitting}
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  tabIndex={0}
                  type="button"
                >
                  {passwordVisible ? (
                    <EyeOff aria-hidden="true" size={18} />
                  ) : (
                    <Eye aria-hidden="true" size={18} />
                  )}
                </button>
              </span>
            </div>

            <div aria-live="polite" className="jellyfin-login-form__feedback">
              {error ? (
                <p role="alert">{error}</p>
              ) : submitting ? (
                <p role="status">Verifying with Jellyfin…</p>
              ) : (
                <p>Credentials travel only to your configured server.</p>
              )}
            </div>

            <button className="jellyfin-login-form__submit" disabled={submitting} type="submit">
              {submitting ? (
                <>
                  <LoaderCircle
                    aria-hidden="true"
                    className="jellyfin-login-form__spinner"
                    size={18}
                  />
                  Verifying account
                </>
              ) : (
                <>
                  Continue to Omnifin
                  <ArrowRight aria-hidden="true" size={18} />
                </>
              )}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
