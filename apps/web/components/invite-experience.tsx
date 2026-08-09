"use client";

import type { AuthProvider } from "@omnifin/contracts/auth";
import Link from "next/link";
import { ArrowRight, Check, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { loadPublicAuthProviders } from "../lib/auth-providers";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

type Stage = "scrubbing" | "methods" | "jellyfin" | "complete" | "error";
const inviteFragment = /^#invite=([A-Za-z0-9_-]{43})$/u;

async function exchangeInvitation(token: string): Promise<void> {
  let secret: string | undefined = token;
  try {
    const response = await fetch("/api/auth/invitations/exchange", {
      body: JSON.stringify({ token: secret }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      redirect: "error",
    });
    if (!response.ok) throw new Error("exchange_failed");
  } finally {
    secret = undefined;
  }
}

function publicMessage(error: unknown) {
  return error instanceof Error && error.message === "exchange_failed"
    ? "This invitation is no longer available. It may have expired, been revoked, or already been used."
    : "We could not reach Omnifin. Check your connection and try again.";
}

function providerLabel(provider: AuthProvider) {
  return provider.kind === "oidc" ? "Secure identity provider" : "Jellyfin account";
}

export function InviteExperience() {
  // The first render is deliberately URL-independent, so SSR and hydration agree.
  const [stage, setStage] = useState<Stage>("scrubbing");
  const [providers, setProviders] = useState<readonly AuthProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jellyfinBusy, setJellyfinBusy] = useState(false);
  const [jellyfinError, setJellyfinError] = useState<string | null>(null);
  const bootstrapStarted = useRef(false);

  useEffect(() => {
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;
    const match = inviteFragment.exec(window.location.hash);
    window.history.replaceState(null, "", "/invite");
    if (!match?.[1]) {
      queueMicrotask(() => {
        setError("This invitation link is not valid.");
        setStage("error");
      });
      return;
    }
    // The token is effect-local and is never placed in state, rendered text, or an Error.
    void exchangeInvitation(match[1])
      .then(async () => {
        const result = await loadPublicAuthProviders({
          fetchImplementation: (_input, init) => fetch("/api/auth/providers", init),
          gatewayUrl: window.location.origin,
        });
        if (result.status !== "ready") throw new Error("providers_unavailable");
        setProviders(result.providers);
        setStage("methods");
      })
      .catch((reason: unknown) => {
        setError(publicMessage(reason));
        setStage("error");
      });
  }, []);

  async function startOidc(providerId: string) {
    try {
      const response = await fetch(
        `/api/auth/invitations/oidc/${encodeURIComponent(providerId)}/start`,
        {
          body: "{}",
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
          redirect: "error",
        },
      );
      const body = (await response.json()) as { authorizationUrl?: unknown };
      if (!response.ok || typeof body.authorizationUrl !== "string") throw new Error("oidc_failed");
      window.location.assign(body.authorizationUrl);
    } catch {
      setError("That identity provider could not be started. Please try again.");
      setStage("error");
    }
  }

  async function finishJellyfin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJellyfinBusy(true);
    setJellyfinError(null);
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    try {
      const response = await fetch("/api/auth/invitations/jellyfin/password", {
        body: JSON.stringify({ password, username }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        redirect: "error",
      });
      if (!response.ok) throw new Error("jellyfin_failed");
      setStage("complete");
    } catch {
      setJellyfinError(
        "Those Jellyfin credentials could not be accepted. Your invitation is still available; please try again.",
      );
      setJellyfinBusy(false);
    }
  }

  async function startQuickConnect() {
    setJellyfinBusy(true);
    setJellyfinError(null);
    try {
      const start = await fetch("/api/auth/invitations/jellyfin/quick-connect", {
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        redirect: "error",
      });
      const transaction = (await start.json()) as {
        code?: unknown;
        transactionId?: unknown;
        pollAfterMs?: unknown;
      };
      if (
        !start.ok ||
        typeof transaction.code !== "string" ||
        typeof transaction.transactionId !== "string"
      )
        throw new Error("quick_connect_failed");
      setJellyfinError(`Enter code ${transaction.code} in Jellyfin, then keep this window open.`);
      for (;;) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            typeof transaction.pollAfterMs === "number" ? transaction.pollAfterMs : 2000,
          ),
        );
        const poll = await fetch(
          `/api/auth/invitations/jellyfin/quick-connect/${encodeURIComponent(transaction.transactionId)}/poll`,
          {
            body: "{}",
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json", "content-type": "application/json" },
            method: "POST",
            redirect: "error",
          },
        );
        const result = (await poll.json()) as { status?: unknown; pollAfterMs?: unknown };
        if (!poll.ok || result.status === "expired") throw new Error("quick_connect_expired");
        if (result.status === "signed_in") {
          setStage("complete");
          setJellyfinBusy(false);
          return;
        }
        transaction.pollAfterMs = result.pollAfterMs;
      }
    } catch {
      setJellyfinError(
        "Quick Connect could not be completed. Your invitation is still available; start again when ready.",
      );
      setJellyfinBusy(false);
    }
  }

  return (
    <div className="invite-layout">
      <CinematicBackdrop />
      <header className="invite-masthead">
        <BrandMark />
      </header>
      <main className="invite-main" id="main-content" tabIndex={-1}>
        <section className="invite-card" aria-live="polite">
          <div className="invite-content">
            {stage === "scrubbing" ? (
              <>
                <p className="eyebrow">Private by design</p>
                <h1>Preparing your welcome.</h1>
                <p className="invite-status">
                  <LoaderCircle aria-hidden="true" className="setup-spin" size={18} /> Securing your
                  invitation…
                </p>
              </>
            ) : null}
            {stage === "error" ? (
              <>
                <p className="eyebrow">Invitation</p>
                <h1>Let’s try that again.</h1>
                <p>{error}</p>
                <div className="invite-actions">
                  <a className="invite-button invite-button--quiet" href="/login">
                    Go to sign in <ArrowRight aria-hidden="true" size={16} />
                  </a>
                </div>
              </>
            ) : null}
            {stage === "methods" ? (
              <>
                <p className="eyebrow">You’re invited</p>
                <h1>Make this space yours.</h1>
                <p>
                  Choose how you’d like to finish setting up your Omnifin account. Your invitation
                  is single-use, but it is only consumed after account completion.
                </p>
                <div className="invite-methods">
                  {providers
                    .filter((p) => p.state === "available")
                    .map((provider) => (
                      <div className="invite-method" key={provider.id}>
                        <span>
                          <strong>{provider.displayName}</strong>
                          <small>{providerLabel(provider)}</small>
                        </span>
                        <button
                          className="invite-button"
                          onClick={() =>
                            provider.kind === "oidc"
                              ? void startOidc(provider.id)
                              : setStage("jellyfin")
                          }
                          type="button"
                        >
                          Continue <ArrowRight aria-hidden="true" size={16} />
                        </button>
                      </div>
                    ))}
                </div>
                <p className="invite-note">
                  <ShieldCheck aria-hidden="true" size={18} /> This invitation does not reveal
                  access level or account details. Omnifin will show only the access you receive
                  after setup.
                </p>
              </>
            ) : null}
            {stage === "jellyfin" ? (
              <>
                <p className="eyebrow">Jellyfin account</p>
                <h1>Connect securely.</h1>
                <p>
                  Use your Jellyfin credentials or approve a Quick Connect request. Credentials are
                  sent only to the Omnifin gateway.
                </p>
                <form className="invite-form" onSubmit={(event) => void finishJellyfin(event)}>
                  <label htmlFor="invite-username">
                    Username
                    <input autoComplete="username" id="invite-username" name="username" required />
                  </label>
                  <label htmlFor="invite-password">
                    Password
                    <input
                      autoComplete="current-password"
                      id="invite-password"
                      name="password"
                      required
                      type="password"
                    />
                  </label>
                  <button className="invite-button" disabled={jellyfinBusy} type="submit">
                    <KeyRound aria-hidden="true" size={16} />{" "}
                    {jellyfinBusy ? "Connecting…" : "Connect Jellyfin"}
                  </button>
                </form>
                <div className="invite-actions">
                  <button
                    className="invite-button invite-button--quiet"
                    disabled={jellyfinBusy}
                    onClick={() => void startQuickConnect()}
                    type="button"
                  >
                    Use Quick Connect
                  </button>
                  <button
                    className="invite-button invite-button--quiet"
                    disabled={jellyfinBusy}
                    onClick={() => {
                      setJellyfinError(null);
                      setStage("methods");
                    }}
                    type="button"
                  >
                    Back
                  </button>
                </div>
                {jellyfinError ? (
                  <p className="invite-error" role="alert">
                    {jellyfinError}
                  </p>
                ) : null}
              </>
            ) : null}
            {stage === "complete" ? (
              <>
                <p className="eyebrow">All set</p>
                <h1>Welcome in.</h1>
                <p>
                  Your account is ready. This invitation is now complete and cannot be used again.
                </p>
                <div className="invite-actions">
                  <Link className="invite-button" href="/">
                    Enter Omnifin <Check aria-hidden="true" size={16} />
                  </Link>
                </div>
              </>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}
