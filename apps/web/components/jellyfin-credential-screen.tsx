"use client";

import type {
  AuthenticatedSessionResponse,
  JellyfinQuickConnectInitiationResponse,
} from "@omnifin/contracts/auth";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

export type JellyfinCredentialStatus =
  | "identity_conflict"
  | "idle"
  | "invalid_credentials"
  | "rate_limited"
  | "session_required"
  | "submitting"
  | "unavailable";

type CredentialOutcome = Exclude<JellyfinCredentialStatus, "idle" | "submitting"> | "success";
type AuthenticationMethod = "password" | "quick-connect";
type QuickConnectFailure =
  "identity_conflict" | "rate_limited" | "session_required" | "unavailable";

export type JellyfinCredentialIntent = "pair" | "sign-in";

export type PairingSessionOutcome =
  { csrfToken: string; status: "ready" } | { status: "ineligible" | "signed_out" | "unavailable" };

export interface JellyfinCredentials {
  password: string;
  username: string;
}

export type QuickConnectStartOutcome =
  | { status: "started"; transaction: JellyfinQuickConnectInitiationResponse }
  | { status: QuickConnectFailure };

export type QuickConnectPollOutcome =
  | {
      expiresAt: string;
      pollAfterMs: number;
      status: "pending";
    }
  | { session: AuthenticatedSessionResponse; status: "signed_in" }
  | { status: "expired" }
  | { status: QuickConnectFailure };

type QuickConnectState =
  | { status: "idle" | "starting" }
  | { status: "pending"; transaction: JellyfinQuickConnectInitiationResponse }
  | { status: "expired" | QuickConnectFailure };

export interface JellyfinCredentialScreenProperties {
  autoPollQuickConnect?: boolean;
  displayProfile?: DisplayProfile;
  initialPairingSession?: PairingSessionOutcome;
  initialMethod?: AuthenticationMethod;
  initialNow?: number;
  initialQuickConnectStatus?: Exclude<QuickConnectState["status"], "pending">;
  initialQuickConnectTransaction?: JellyfinQuickConnectInitiationResponse;
  initialStatus?: JellyfinCredentialStatus;
  intent?: JellyfinCredentialIntent;
  loadPairingSession?: () => Promise<PairingSessionOutcome>;
  onAuthenticated?: () => void;
  pollQuickConnect?: (transactionId: string) => Promise<QuickConnectPollOutcome>;
  startQuickConnect?: () => Promise<QuickConnectStartOutcome>;
  submitCredentials?: (credentials: JellyfinCredentials) => Promise<CredentialOutcome>;
}

const STATUS_MESSAGES: Readonly<
  Record<Exclude<JellyfinCredentialStatus, "idle" | "submitting">, string>
> = Object.freeze({
  identity_conflict: "That Jellyfin identity is already linked to another account.",
  invalid_credentials: "That Jellyfin username or password was not accepted.",
  rate_limited: "Too many attempts were made. Wait a moment, then try again.",
  session_required: "Your secure session changed. Sign in again before linking Jellyfin.",
  unavailable: "Jellyfin authentication is temporarily unavailable.",
});

const QUICK_CONNECT_MESSAGES = Object.freeze({
  expired: "This code expired before it was approved. Generate a fresh code to continue.",
  identity_conflict: "That Jellyfin identity is already linked to another account.",
  rate_limited: "Too many codes were requested. Wait a moment, then try again.",
  session_required: "Your secure session changed. Sign in again before linking Jellyfin.",
  unavailable: "Quick Connect is not available on the configured Jellyfin server right now.",
});

const CSRF_HEADER = "x-omnifin-csrf";
const CSRF_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthenticatedSessionResponse(
  value: unknown,
  intent: JellyfinCredentialIntent,
): value is AuthenticatedSessionResponse {
  if (!isRecord(value) || !CSRF_PATTERN.test(String(value.csrfToken ?? ""))) {
    return false;
  }
  const principal = value.principal;
  if (!isRecord(principal) || principal.accountState !== "active") return false;
  const method = principal.authenticationMethod;
  return (
    typeof principal.sessionId === "string" &&
    typeof principal.userId === "string" &&
    isRecord(method) &&
    method.kind === (intent === "pair" ? "oidc" : "jellyfin")
  );
}

async function responseFailure(response: Response): Promise<Exclude<CredentialOutcome, "success">> {
  if (response.status === 401) return "invalid_credentials";
  if (response.status === 429) return "rate_limited";
  if (response.status === 403) return "session_required";
  if (response.status === 409) {
    try {
      const body = (await response.json()) as unknown;
      if (isRecord(body) && isRecord(body.error) && body.error.code === "identity_link_conflict") {
        return "identity_conflict";
      }
    } catch {
      // A bounded status-derived fallback avoids exposing gateway response details.
    }
    return "session_required";
  }
  return "unavailable";
}

async function quickConnectFailure(response: Response): Promise<QuickConnectFailure> {
  const outcome = await responseFailure(response);
  return outcome === "invalid_credentials" ? "unavailable" : outcome;
}

async function defaultLoadPairingSession(): Promise<PairingSessionOutcome> {
  try {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return { status: "unavailable" };
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || body.principal === null || body.csrfToken === null) {
      return { status: "signed_out" };
    }
    if (!CSRF_PATTERN.test(String(body.csrfToken ?? "")) || !isRecord(body.principal)) {
      return { status: "unavailable" };
    }
    const method = body.principal.authenticationMethod;
    if (
      !isRecord(method) ||
      method.kind !== "oidc" ||
      (body.principal.accountState !== "pending_link" && body.principal.accountState !== "active")
    ) {
      return { status: "ineligible" };
    }
    return { csrfToken: String(body.csrfToken), status: "ready" };
  } catch {
    return { status: "unavailable" };
  }
}

function isQuickConnectTransaction(
  value: unknown,
): value is JellyfinQuickConnectInitiationResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.transactionId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.transactionId) &&
    typeof value.code === "string" &&
    /^[A-Za-z0-9-]{1,32}$/.test(value.code) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Number.isInteger(value.pollAfterMs) &&
    Number(value.pollAfterMs) >= 1_000 &&
    Number(value.pollAfterMs) <= 30_000
  );
}

async function defaultSubmitCredentials(
  credentials: JellyfinCredentials,
  intent: JellyfinCredentialIntent,
  csrfToken: string | null,
): Promise<CredentialOutcome> {
  if (intent === "pair" && csrfToken === null) return "session_required";
  try {
    const response = await fetch(
      intent === "pair" ? "/api/auth/jellyfin/link/password" : "/api/auth/jellyfin/password",
      {
        body: JSON.stringify(credentials),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(csrfToken === null ? {} : { [CSRF_HEADER]: csrfToken }),
        },
        method: "POST",
      },
    );
    if (response.ok) {
      const body = (await response.json()) as unknown;
      return isAuthenticatedSessionResponse(body, intent) ? "success" : "unavailable";
    }
    return responseFailure(response);
  } catch {
    return "unavailable";
  }
}

async function defaultStartQuickConnect(
  intent: JellyfinCredentialIntent,
  csrfToken: string | null,
): Promise<QuickConnectStartOutcome> {
  if (intent === "pair" && csrfToken === null) return { status: "session_required" };
  try {
    const response = await fetch(
      intent === "pair"
        ? "/api/auth/jellyfin/link/quick-connect"
        : "/api/auth/jellyfin/quick-connect",
      {
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(csrfToken === null ? {} : { [CSRF_HEADER]: csrfToken }),
        },
        method: "POST",
      },
    );
    if (!response.ok) return { status: await quickConnectFailure(response) };
    const body = (await response.json()) as unknown;
    return isQuickConnectTransaction(body)
      ? { status: "started", transaction: body }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

async function defaultPollQuickConnect(
  transactionId: string,
  intent: JellyfinCredentialIntent,
  csrfToken: string | null,
): Promise<QuickConnectPollOutcome> {
  if (intent === "pair" && csrfToken === null) return { status: "session_required" };
  try {
    const response = await fetch(
      `/api/auth/jellyfin/${intent === "pair" ? "link/" : ""}quick-connect/${encodeURIComponent(transactionId)}/poll`,
      {
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(csrfToken === null ? {} : { [CSRF_HEADER]: csrfToken }),
        },
        method: "POST",
      },
    );
    if (!response.ok) return { status: await quickConnectFailure(response) };
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || typeof body.status !== "string") return { status: "unavailable" };
    if (body.status === "expired") return { status: "expired" };
    if (
      body.status === "pending" &&
      typeof body.expiresAt === "string" &&
      Number.isFinite(Date.parse(body.expiresAt)) &&
      Number.isInteger(body.pollAfterMs) &&
      Number(body.pollAfterMs) >= 1_000 &&
      Number(body.pollAfterMs) <= 30_000
    ) {
      return {
        expiresAt: body.expiresAt,
        pollAfterMs: Number(body.pollAfterMs),
        status: "pending",
      };
    }
    if (
      body.status === (intent === "pair" ? "paired" : "signed_in") &&
      isAuthenticatedSessionResponse(body, intent)
    ) {
      return { session: body, status: "signed_in" };
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

function defaultAuthenticatedNavigation() {
  window.location.assign("/");
}

function formattedRemainingTime(expiresAt: string, now: number | null) {
  if (now === null) return "5:00";
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function JellyfinCredentialScreen({
  autoPollQuickConnect = true,
  displayProfile = "standard",
  initialPairingSession,
  initialMethod = "password",
  initialNow,
  initialQuickConnectStatus = "idle",
  initialQuickConnectTransaction,
  initialStatus = "idle",
  intent = "sign-in",
  loadPairingSession = defaultLoadPairingSession,
  onAuthenticated = defaultAuthenticatedNavigation,
  pollQuickConnect,
  startQuickConnect,
  submitCredentials,
}: JellyfinCredentialScreenProperties) {
  const [method, setMethod] = useState<AuthenticationMethod>(initialMethod);
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [quickConnectState, setQuickConnectState] = useState<QuickConnectState>(
    initialQuickConnectTransaction
      ? { status: "pending", transaction: initialQuickConnectTransaction }
      : { status: initialQuickConnectStatus },
  );
  const [status, setStatus] = useState<JellyfinCredentialStatus>(initialStatus);
  const [username, setUsername] = useState("");
  const [copied, setCopied] = useState(false);
  const [currentTime, setCurrentTime] = useState<number | null>(initialNow ?? null);
  const [pairingSession, setPairingSession] = useState<PairingSessionOutcome | null>(
    intent === "pair" ? (initialPairingSession ?? null) : { csrfToken: "", status: "ready" },
  );
  const passwordInput = useRef<HTMLInputElement>(null);
  const passwordTab = useRef<HTMLButtonElement>(null);
  const quickConnectTab = useRef<HTMLButtonElement>(null);
  const requestGeneration = useRef(0);
  const restorePasswordFocus = useRef(false);
  const submitting = status === "submitting";
  const error = status !== "idle" && status !== "submitting" ? STATUS_MESSAGES[status] : null;
  const csrfToken = pairingSession?.status === "ready" ? pairingSession.csrfToken || null : null;

  useEffect(() => {
    if (intent !== "pair" || pairingSession !== null) return;
    let active = true;
    void loadPairingSession().then((outcome) => {
      if (active) setPairingSession(outcome);
    });
    return () => {
      active = false;
    };
  }, [intent, loadPairingSession, pairingSession]);

  useEffect(() => {
    if (!error || !restorePasswordFocus.current) return;
    restorePasswordFocus.current = false;
    passwordInput.current?.focus();
  }, [error]);

  useEffect(() => {
    if (quickConnectState.status !== "pending" || !autoPollQuickConnect) return;
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [autoPollQuickConnect, quickConnectState.status]);

  useEffect(() => {
    if (
      method !== "quick-connect" ||
      quickConnectState.status !== "pending" ||
      !autoPollQuickConnect
    ) {
      return;
    }
    const generation = requestGeneration.current;
    const transaction = quickConnectState.transaction;
    const timeout = window.setTimeout(async () => {
      const outcome = await (pollQuickConnect
        ? pollQuickConnect(transaction.transactionId)
        : defaultPollQuickConnect(transaction.transactionId, intent, csrfToken));
      if (requestGeneration.current !== generation) return;
      if (outcome.status === "signed_in") {
        requestGeneration.current += 1;
        onAuthenticated();
        return;
      }
      if (outcome.status === "pending") {
        setQuickConnectState({
          status: "pending",
          transaction: {
            ...transaction,
            expiresAt: outcome.expiresAt,
            pollAfterMs: outcome.pollAfterMs,
          },
        });
        return;
      }
      setQuickConnectState({ status: outcome.status });
    }, quickConnectState.transaction.pollAfterMs);
    return () => window.clearTimeout(timeout);
  }, [
    autoPollQuickConnect,
    csrfToken,
    intent,
    method,
    onAuthenticated,
    pollQuickConnect,
    quickConnectState,
  ]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || username.trim().length === 0 || password.length === 0) return;
    setStatus("submitting");
    const credentials = { password, username: username.trim() };
    const outcome = await (submitCredentials
      ? submitCredentials(credentials)
      : defaultSubmitCredentials(credentials, intent, csrfToken));
    setPassword("");
    setPasswordVisible(false);
    if (outcome === "success") {
      onAuthenticated();
      return;
    }
    restorePasswordFocus.current = true;
    setStatus(outcome);
  };

  const start = async () => {
    if (quickConnectState.status === "starting") return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setCopied(false);
    setQuickConnectState({ status: "starting" });
    const outcome = await (startQuickConnect
      ? startQuickConnect()
      : defaultStartQuickConnect(intent, csrfToken));
    if (requestGeneration.current !== generation) return;
    setQuickConnectState(
      outcome.status === "started"
        ? { status: "pending", transaction: outcome.transaction }
        : { status: outcome.status },
    );
  };

  const selectMethod = (nextMethod: AuthenticationMethod) => {
    if (nextMethod === method) return;
    if (nextMethod === "password") requestGeneration.current += 1;
    setMethod(nextMethod);
    window.requestAnimationFrame(() => {
      (nextMethod === "password" ? passwordTab : quickConnectTab).current?.focus();
    });
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectMethod(event.key === "ArrowLeft" || event.key === "Home" ? "password" : "quick-connect");
  };

  const copyCode = async () => {
    if (quickConnectState.status !== "pending") return;
    try {
      await navigator.clipboard.writeText(quickConnectState.transaction.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const pairingReady = pairingSession?.status === "ready";
  const pairingState = pairingSession?.status ?? "checking";

  return (
    <div className="jellyfin-login-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="jellyfin-login-card" id="main-content" tabIndex={-1}>
        <section className="jellyfin-login-card__intro" aria-labelledby="jellyfin-login-title">
          <BrandMark />
          <a
            className="jellyfin-login-card__back"
            href={intent === "pair" ? "/settings" : "/login"}
          >
            <ArrowLeft aria-hidden="true" size={16} />
            {intent === "pair" ? "Account settings" : "All sign-in methods"}
          </a>
          <div className="jellyfin-login-card__headline">
            <p className="eyebrow">
              {intent === "pair" ? "Secure account pairing" : "Jellyfin identity"}
            </p>
            <h1 id="jellyfin-login-title">
              {intent === "pair" ? "Bring your library with you." : "Step into your library."}
            </h1>
            <p>
              {intent === "pair"
                ? "Prove control of your Jellyfin account once. Omnifin will preserve your own library visibility, playback permissions, and watch state."
                : "Sign in directly or approve this device from Jellyfin. Your media permissions stay anchored to your own account."}
            </p>
          </div>
          <ul className="jellyfin-login-card__assurances" aria-label="Authentication safeguards">
            <li>
              <LockKeyhole aria-hidden="true" size={17} />
              Password discarded after verification
            </li>
            <li>
              <ShieldCheck aria-hidden="true" size={17} />
              {intent === "pair"
                ? "Identity ownership is proven, never guessed"
                : "Session and token remain gateway-side"}
            </li>
            <li>
              <RadioTower aria-hidden="true" size={17} />
              No external telemetry
            </li>
          </ul>
        </section>

        <section
          className="jellyfin-login-card__form-panel"
          aria-label={intent === "pair" ? "Link a Jellyfin account" : "Jellyfin sign in"}
        >
          <div className="jellyfin-login-card__method-icon" aria-hidden="true">
            {method === "password" ? <KeyRound size={22} /> : <Smartphone size={22} />}
          </div>
          <div className="jellyfin-login-card__form-heading">
            <p className="section-kicker">
              {intent === "pair" ? "Account pairing" : "Direct authentication"}
            </p>
            <h2>
              {method === "password"
                ? intent === "pair"
                  ? "Connect your Jellyfin identity"
                  : "Use your Jellyfin account"
                : intent === "pair"
                  ? "Approve your account"
                  : "Approve this screen"}
            </h2>
            <p>
              {method === "password"
                ? intent === "pair"
                  ? "Jellyfin verifies your credentials; Omnifin immediately discards the password and links only the proven identity."
                  : "Your server verifies these credentials and returns a revocable access token."
                : "Generate a short code, then approve it from any device already signed in to Jellyfin."}
            </p>
          </div>

          {intent === "pair" && !pairingReady ? (
            <div
              aria-live="polite"
              className="jellyfin-pairing-gate"
              role={pairingState === "checking" ? "status" : "alert"}
            >
              <span className="jellyfin-pairing-gate__icon" aria-hidden="true">
                {pairingState === "checking" ? (
                  <LoaderCircle className="jellyfin-login-form__spinner" size={26} />
                ) : (
                  <TriangleAlert size={24} />
                )}
              </span>
              <div>
                <h3>
                  {pairingState === "checking"
                    ? "Checking your secure session"
                    : pairingState === "signed_out"
                      ? "Sign in again to continue"
                      : pairingState === "ineligible"
                        ? "This account cannot be paired"
                        : "Account pairing is unavailable"}
                </h3>
                <p>
                  {pairingState === "checking"
                    ? "Confirming your OIDC identity and current account permissions…"
                    : pairingState === "signed_out"
                      ? "Your session has ended. Start with your identity provider, then return here to link Jellyfin."
                      : pairingState === "ineligible"
                        ? "Jellyfin pairing is available to OIDC-authenticated accounts. Your current identity remains unchanged."
                        : "The gateway could not confirm your session. No credentials have been requested or sent."}
                </p>
              </div>
              {pairingState === "signed_out" ? (
                <a className="jellyfin-login-form__submit" href="/login">
                  Return to sign in
                  <ArrowRight aria-hidden="true" size={18} />
                </a>
              ) : pairingState === "unavailable" ? (
                <button
                  className="jellyfin-login-form__submit"
                  onClick={() => setPairingSession(null)}
                  type="button"
                >
                  Try session check again
                  <RefreshCw aria-hidden="true" size={17} />
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div
                aria-label="Jellyfin sign-in method"
                className="jellyfin-login-methods"
                role="tablist"
              >
                <button
                  aria-controls="jellyfin-password-panel"
                  aria-label="Password sign in"
                  aria-selected={method === "password"}
                  id="jellyfin-password-tab"
                  onClick={() => selectMethod("password")}
                  onKeyDown={handleTabKey}
                  ref={passwordTab}
                  role="tab"
                  tabIndex={method === "password" ? 0 : -1}
                  type="button"
                >
                  Password
                </button>
                <button
                  aria-controls="jellyfin-quick-connect-panel"
                  aria-label="Quick Connect"
                  aria-selected={method === "quick-connect"}
                  id="jellyfin-quick-connect-tab"
                  onClick={() => selectMethod("quick-connect")}
                  onKeyDown={handleTabKey}
                  ref={quickConnectTab}
                  role="tab"
                  tabIndex={method === "quick-connect" ? 0 : -1}
                  type="button"
                >
                  Quick Connect
                </button>
              </div>

              {method === "password" ? (
                <div
                  aria-label="Password sign-in panel"
                  id="jellyfin-password-panel"
                  role="tabpanel"
                >
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

                    <button
                      className="jellyfin-login-form__submit"
                      disabled={submitting}
                      type="submit"
                    >
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
                          {intent === "pair" ? "Link Jellyfin account" : "Continue to Omnifin"}
                          <ArrowRight aria-hidden="true" size={18} />
                        </>
                      )}
                    </button>
                  </form>
                </div>
              ) : (
                <div
                  aria-label="Quick Connect panel"
                  className="jellyfin-quick-connect"
                  id="jellyfin-quick-connect-panel"
                  role="tabpanel"
                >
                  {quickConnectState.status === "pending" ? (
                    <>
                      <div className="jellyfin-quick-connect__code-card">
                        <div>
                          <span>One-time code</span>
                          <output aria-label="Jellyfin Quick Connect code">
                            {quickConnectState.transaction.code}
                          </output>
                        </div>
                        <button
                          aria-label="Copy Quick Connect code"
                          onClick={copyCode}
                          type="button"
                        >
                          {copied ? (
                            <Check aria-hidden="true" size={18} />
                          ) : (
                            <Copy aria-hidden="true" size={18} />
                          )}
                        </button>
                      </div>
                      <ol className="jellyfin-quick-connect__steps">
                        <li>Open Jellyfin on a device where you are already signed in.</li>
                        <li>Choose your profile, then Quick Connect.</li>
                        <li>Enter the code above and approve Omnifin.</li>
                      </ol>
                      <div
                        aria-live="polite"
                        className="jellyfin-quick-connect__waiting"
                        role="status"
                      >
                        <span aria-hidden="true" className="jellyfin-quick-connect__pulse" />
                        <span>Waiting for approval</span>
                        <time dateTime={quickConnectState.transaction.expiresAt}>
                          {formattedRemainingTime(
                            quickConnectState.transaction.expiresAt,
                            currentTime,
                          )}
                        </time>
                      </div>
                    </>
                  ) : (
                    <div className="jellyfin-quick-connect__start">
                      <div aria-hidden="true" className="jellyfin-quick-connect__device-ring">
                        {quickConnectState.status === "starting" ? (
                          <LoaderCircle className="jellyfin-login-form__spinner" size={30} />
                        ) : (
                          <Smartphone size={30} />
                        )}
                      </div>
                      <p>
                        No password is entered here. Jellyfin will ask you to approve this browser
                        with a short-lived code.
                      </p>
                      {quickConnectState.status !== "idle" &&
                      quickConnectState.status !== "starting" ? (
                        <p className="jellyfin-quick-connect__error" role="alert">
                          {QUICK_CONNECT_MESSAGES[quickConnectState.status]}
                        </p>
                      ) : null}
                      <button
                        className="jellyfin-login-form__submit"
                        disabled={quickConnectState.status === "starting"}
                        onClick={start}
                        type="button"
                      >
                        {quickConnectState.status === "starting" ? (
                          <>
                            <LoaderCircle
                              aria-hidden="true"
                              className="jellyfin-login-form__spinner"
                              size={18}
                            />
                            Generating code
                          </>
                        ) : (
                          <>
                            {quickConnectState.status === "idle"
                              ? "Generate a code"
                              : "Generate a new code"}
                            <RefreshCw aria-hidden="true" size={17} />
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
