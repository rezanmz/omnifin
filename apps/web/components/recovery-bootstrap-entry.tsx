"use client";

import {
  ArrowRight,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type {
  AdministratorRecoveryPreviewAdministrator,
  AuthProvider,
} from "@omnifin/contracts/auth";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { parseAdministratorRecoveryBrowserSession } from "../lib/administrator-recovery";
import type { DisplayProfile } from "../lib/dashboard-data";
import { AdministratorRecoveryCeremony } from "./administrator-recovery-ceremony";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { JellyfinCredentialScreen } from "./jellyfin-credential-screen";

const RECOVERY_SECRET_MAX_LENGTH = 172;

function subscribeToHydration() {
  return () => undefined;
}

function hydratedClientSnapshot() {
  return true;
}

function hydratedServerSnapshot() {
  return false;
}

type RecoveryEntryState =
  "checking" | "denied" | "idle" | "rate_limited" | "submitting" | "unavailable";

export interface RecoverySessionProof {
  csrfToken: string;
}

export interface RecoveryBootstrapEntryProperties {
  /** Deterministic initial state for Storybook and browser quality checks. */
  displayProfile?: DisplayProfile;
  initialCeremonyPreview?: AdministratorRecoveryPreviewAdministrator;
  initialCeremonyProviders?: readonly AuthProvider[];
  initialProof?: RecoverySessionProof;
  initialReplacementStatus?: "denied" | "replaced" | "unavailable";
  initialState?: Exclude<RecoveryEntryState, "checking" | "submitting">;
}

const DETERMINISTIC_RECOVERY_PREVIEW: AdministratorRecoveryPreviewAdministrator = Object.freeze({
  activeSessions: 3,
  authenticationMethods: ["jellyfin", "oidc"] as ("jellyfin" | "oidc")[],
  displayName: "Primary administrator",
  id: "administrator-primary",
  updatedAt: "2026-08-08T14:20:00.000Z",
}) satisfies AdministratorRecoveryPreviewAdministrator;

const DETERMINISTIC_RECOVERY_PROVIDERS = Object.freeze([
  {
    displayName: "Jellyfin",
    id: "jellyfin",
    kind: "jellyfin",
    pairingRequiredAfterOidc: true,
    passwordLoginAvailable: true,
    quickConnectAvailable: true,
    state: "available",
  },
  {
    displayName: "Home identity",
    id: "home-identity",
    issuer: "https://identity.example.test/application/o/omnifin/",
    jitProvisioningEnabled: false,
    kind: "oidc",
    state: "available",
    supportsBackChannelLogout: true,
    supportsFrontChannelLogout: true,
    supportsRpInitiatedLogout: true,
  },
]) satisfies readonly AuthProvider[];

type ExistingRecoverySessionResult =
  | { administratorSession: boolean; proof: RecoverySessionProof | null; status: "ready" }
  | { status: "unavailable" };

async function loadExistingRecoverySession(): Promise<ExistingRecoverySessionResult> {
  try {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) {
      return { administratorSession: false, proof: null, status: "ready" };
    }
    if (!response.ok) return { status: "unavailable" };
    const session = await parseAdministratorRecoveryBrowserSession(
      (await response.json()) as unknown,
    );
    if (session.status === "unavailable") return { status: "unavailable" };
    return {
      administratorSession: session.status === "administrator",
      proof: session.status === "recovery" ? { csrfToken: session.csrfToken } : null,
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
  displayProfile,
  initialCeremonyPreview,
  initialCeremonyProviders,
  initialProof,
  initialReplacementStatus,
  initialState,
}: RecoveryBootstrapEntryProperties = {}) {
  const [proof, setProof] = useState<RecoverySessionProof | null>(initialProof ?? null);
  const [secret, setSecret] = useState("");
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    hydratedClientSnapshot,
    hydratedServerSnapshot,
  );
  const [recoveryMode, setRecoveryMode] = useState<"replacement" | "bootstrap">("replacement");
  const [replacementVerified, setReplacementVerified] = useState(false);
  const [replacementUnconfirmed, setReplacementUnconfirmed] = useState(
    initialReplacementStatus === "replaced" && initialProof !== undefined,
  );
  const [replacementReturnStatus, setReplacementReturnStatus] = useState(initialReplacementStatus);
  const resolvedDisplayProfile: DisplayProfile =
    displayProfile ??
    (hydrated && new URLSearchParams(window.location.search).get("test-profile") === "ten-foot"
      ? "ten-foot"
      : "standard");
  const [entryState, setEntryState] = useState<RecoveryEntryState>(
    initialProof || initialState ? (initialState ?? "idle") : "checking",
  );
  const secretInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hydrated || replacementReturnStatus !== undefined) return;
    const timeout = window.setTimeout(() => {
      const values = new URLSearchParams(window.location.search).getAll("administratorReplacement");
      const value = values.length === 1 ? values[0] : undefined;
      if (value === "denied" || value === "replaced" || value === "unavailable") {
        setReplacementReturnStatus(value);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [hydrated, replacementReturnStatus]);

  useEffect(() => {
    if (!replacementReturnStatus || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("administratorReplacement");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [replacementReturnStatus]);

  const checkExistingSession = useCallback(async () => {
    const result = await loadExistingRecoverySession();
    if (result.status === "unavailable") {
      setEntryState("unavailable");
      return;
    }
    if (replacementReturnStatus === "replaced") {
      if (result.administratorSession) {
        setReplacementVerified(true);
        setEntryState("idle");
        return;
      }
      setProof(result.proof);
      setReplacementUnconfirmed(true);
      setEntryState("idle");
      return;
    }
    if (result.proof) {
      setProof(result.proof);
      return;
    }
    setEntryState("idle");
  }, [replacementReturnStatus]);

  useEffect(() => {
    if (initialProof || initialState) return;
    let active = true;
    void loadExistingRecoverySession().then((result) => {
      if (!active) return;
      if (result.status === "unavailable") {
        setEntryState("unavailable");
        return;
      }
      if (replacementReturnStatus === "replaced") {
        if (result.administratorSession) {
          setReplacementVerified(true);
        } else {
          setProof(result.proof);
          setReplacementUnconfirmed(true);
        }
        setEntryState("idle");
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
  }, [initialProof, initialState, replacementReturnStatus]);

  useEffect(() => {
    const clearSecret = () => {
      setSecret("");
      if (secretInput.current) secretInput.current.value = "";
    };
    window.addEventListener("pagehide", clearSecret);
    return () => window.removeEventListener("pagehide", clearSecret);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (entryState === "submitting" || secret.length === 0) return;
    setEntryState("submitting");
    const submittedSecret = secret;
    setSecret("");
    if (secretInput.current) secretInput.current.value = "";
    try {
      const response = await fetch("/api/auth/recovery/session", {
        body: JSON.stringify({ secret: submittedSecret }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
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
      const nextSession = await parseAdministratorRecoveryBrowserSession(
        (await response.json()) as unknown,
      );
      if (nextSession.status !== "recovery") {
        setEntryState("unavailable");
        return;
      }
      setProof({ csrfToken: nextSession.csrfToken });
    } catch {
      setEntryState("unavailable");
      queueMicrotask(() => secretInput.current?.focus());
    }
  };

  if (replacementVerified) {
    return (
      <AdministratorRecoveryCeremony
        displayProfile={resolvedDisplayProfile}
        initialState="success"
      />
    );
  }

  if (replacementUnconfirmed) {
    return (
      <AdministratorRecoveryCeremony
        {...(proof ? { csrfToken: proof.csrfToken } : {})}
        displayProfile={resolvedDisplayProfile}
        initialState="session_unconfirmed"
      />
    );
  }

  if (proof && recoveryMode === "replacement") {
    const deterministic = initialProof !== undefined;
    const callbackNotice =
      replacementReturnStatus === "denied" || replacementReturnStatus === "unavailable"
        ? replacementReturnStatus
        : undefined;
    return (
      <AdministratorRecoveryCeremony
        csrfToken={proof.csrfToken}
        displayProfile={resolvedDisplayProfile}
        key={replacementReturnStatus ?? "recovery-preview"}
        {...(initialCeremonyPreview || deterministic
          ? { initialPreview: initialCeremonyPreview ?? DETERMINISTIC_RECOVERY_PREVIEW }
          : {})}
        {...(initialCeremonyProviders || deterministic
          ? {
              initialProviders: initialCeremonyProviders ?? DETERMINISTIC_RECOVERY_PROVIDERS,
            }
          : {})}
        {...(callbackNotice ? { initialNotice: callbackNotice } : {})}
        onFirstAdministratorSetup={() => setRecoveryMode("bootstrap")}
      />
    );
  }

  if (proof) {
    return (
      <JellyfinCredentialScreen
        displayProfile={resolvedDisplayProfile}
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
    <div className="jellyfin-login-layout" data-display-profile={resolvedDisplayProfile}>
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
              The secret comes from your deployment’s recovery Docker secret. It is not an OmniFin
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
            {entryState === "unavailable" ? (
              <button
                className="jellyfin-login-form__submit"
                onClick={() => {
                  setEntryState("checking");
                  void checkExistingSession();
                }}
                type="button"
              >
                Try recovery check again
                <RefreshCw aria-hidden="true" size={17} />
              </button>
            ) : (
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
            )}
          </form>
        </section>
      </main>
    </div>
  );
}
