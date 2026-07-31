"use client";

import { ArrowRight, KeyRound, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { JellyfinCredentialScreen } from "./jellyfin-credential-screen";

const CSRF_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const RECOVERY_SECRET_MAX_LENGTH = 172;

type RecoveryEntryState =
  "checking" | "denied" | "idle" | "rate_limited" | "submitting" | "unavailable";

export interface RecoverySessionProof {
  csrfToken: string;
}

export interface RecoveryBootstrapEntryProperties {
  /** Deterministic initial state for Storybook and browser quality checks. */
  initialProof?: RecoverySessionProof;
  initialState?: Exclude<RecoveryEntryState, "checking" | "submitting">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoverySessionProof(value: unknown): RecoverySessionProof | null {
  if (!isRecord(value) || !CSRF_PATTERN.test(String(value.csrfToken ?? ""))) return null;
  const principal = value.principal;
  if (!isRecord(principal) || principal.accountState !== "recovery") return null;
  const method = principal.authenticationMethod;
  if (!isRecord(method) || method.kind !== "recovery") return null;
  return { csrfToken: String(value.csrfToken) };
}

type ExistingRecoverySessionResult =
  { proof: RecoverySessionProof | null; status: "ready" } | { status: "unavailable" };

async function loadExistingRecoverySession(): Promise<ExistingRecoverySessionResult> {
  try {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) return { proof: null, status: "ready" };
    if (!response.ok) return { status: "unavailable" };
    return {
      proof: recoverySessionProof((await response.json()) as unknown),
      status: "ready",
    };
  } catch {
    return { status: "unavailable" };
  }
}

const failureMessage: Record<
  Exclude<RecoveryEntryState, "checking" | "idle" | "submitting">,
  string
> = {
  denied: "That recovery secret was not accepted.",
  rate_limited: "Too many recovery attempts were made. Wait before trying again.",
  unavailable: "Recovery access is temporarily unavailable.",
};

export function RecoveryBootstrapEntry({
  initialProof,
  initialState,
}: RecoveryBootstrapEntryProperties = {}) {
  const [proof, setProof] = useState<RecoverySessionProof | null>(initialProof ?? null);
  const [secret, setSecret] = useState("");
  const [entryState, setEntryState] = useState<RecoveryEntryState>(
    initialProof || initialState ? (initialState ?? "idle") : "checking",
  );
  const secretInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialProof || initialState) return;
    let active = true;
    void loadExistingRecoverySession().then((result) => {
      if (!active) return;
      if (result.status === "unavailable") {
        setEntryState("unavailable");
        return;
      }
      if (result.proof) {
        setProof(result.proof);
        return;
      }
      setEntryState("idle");
    });
    return () => {
      active = false;
    };
  }, [initialProof, initialState]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (entryState === "submitting" || secret.length === 0) return;
    setEntryState("submitting");
    const submittedSecret = secret;
    try {
      const response = await fetch("/api/auth/recovery/session", {
        body: JSON.stringify({ secret: submittedSecret }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setSecret("");
      if (!response.ok) {
        setEntryState(
          response.status === 401
            ? "denied"
            : response.status === 429
              ? "rate_limited"
              : "unavailable",
        );
        queueMicrotask(() => secretInput.current?.focus());
        return;
      }
      const nextProof = recoverySessionProof((await response.json()) as unknown);
      if (!nextProof) {
        setEntryState("unavailable");
        return;
      }
      setProof(nextProof);
    } catch {
      setSecret("");
      setEntryState("unavailable");
      queueMicrotask(() => secretInput.current?.focus());
    }
  };

  if (proof) {
    return (
      <JellyfinCredentialScreen
        initialPairingSession={{ csrfToken: proof.csrfToken, status: "ready" }}
        intent="bootstrap"
      />
    );
  }

  const busy = entryState === "checking" || entryState === "submitting";
  const formDisabled = busy || entryState === "unavailable";
  const error =
    entryState === "denied" || entryState === "rate_limited" || entryState === "unavailable"
      ? failureMessage[entryState]
      : null;

  return (
    <div className="jellyfin-login-layout">
      <CinematicBackdrop />
      <main className="jellyfin-login-card" id="main-content" tabIndex={-1}>
        <section className="jellyfin-login-card__intro" aria-labelledby="recovery-title">
          <BrandMark />
          <div className="jellyfin-login-card__headline">
            <p className="eyebrow">Private break-glass route</p>
            <h1 id="recovery-title">Secure recovery access.</h1>
            <p>
              Use the Docker recovery secret only to repair identity configuration or establish the
              first administrator on a new installation.
            </p>
          </div>
          <ul className="jellyfin-login-card__assurances" aria-label="Recovery safeguards">
            <li>
              <ShieldCheck aria-hidden="true" size={17} />
              Short-lived, rate-limited recovery session
            </li>
            <li>
              <KeyRound aria-hidden="true" size={17} />
              Secret is verified in memory and never stored
            </li>
            <li>
              <TriangleAlert aria-hidden="true" size={17} />
              Every attempt is audit logged without secret material
            </li>
          </ul>
        </section>

        <section className="jellyfin-login-card__form-panel" aria-label="Open recovery access">
          <div className="jellyfin-login-card__method-icon" aria-hidden="true">
            {busy ? (
              <LoaderCircle className="jellyfin-login-form__spinner" size={22} />
            ) : (
              <KeyRound size={22} />
            )}
          </div>
          <div className="jellyfin-login-card__form-heading">
            <p className="section-kicker">Operator proof</p>
            <h2>
              {entryState === "checking" ? "Checking this browser" : "Enter the recovery secret"}
            </h2>
            <p>
              The secret comes from your deployment’s recovery Docker secret. It is not an Omnifin
              or Jellyfin account password.
            </p>
          </div>

          <form aria-busy={busy} className="jellyfin-login-form" onSubmit={submit}>
            <label className="jellyfin-login-field">
              <span>Recovery secret</span>
              <input
                autoCapitalize="none"
                autoComplete="off"
                disabled={formDisabled}
                maxLength={RECOVERY_SECRET_MAX_LENGTH}
                name="recovery-secret"
                onChange={(event) => setSecret(event.currentTarget.value)}
                ref={secretInput}
                required
                spellCheck={false}
                type="password"
                value={secret}
              />
            </label>
            <div aria-live="polite" className="jellyfin-login-form__feedback">
              {error ? (
                <p role="alert">{error}</p>
              ) : busy ? (
                <p role="status">
                  {entryState === "checking"
                    ? "Checking for an existing recovery session…"
                    : "Verifying recovery access…"}
                </p>
              ) : (
                <p>This route is intentionally absent from ordinary sign-in navigation.</p>
              )}
            </div>
            <button className="jellyfin-login-form__submit" disabled={formDisabled} type="submit">
              {entryState === "submitting" ? (
                <>
                  <LoaderCircle
                    aria-hidden="true"
                    className="jellyfin-login-form__spinner"
                    size={18}
                  />
                  Verifying secret
                </>
              ) : (
                <>
                  Open recovery session
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
