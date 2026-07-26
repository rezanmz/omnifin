"use client";

import type { ServiceIdentityLink, SessionPrincipal } from "@omnifin/contracts/auth";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Unlink,
  UserRoundCheck,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

const CSRF_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CSRF_HEADER = "x-omnifin-csrf";

export interface AccountSecuritySnapshot {
  csrfToken: string;
  links: readonly ServiceIdentityLink[];
  principal: SessionPrincipal;
}

export type AccountSecurityLoadOutcome =
  { snapshot: AccountSecuritySnapshot; status: "ready" } | { status: "signed_out" | "unavailable" };

export type IdentityRevocationOutcome =
  | { link: ServiceIdentityLink; principal: SessionPrincipal | null; status: "revoked" }
  | { status: "failed" }
  | { status: "session_changed" };

interface AccountSecurityPanelProperties {
  displayProfile?: DisplayProfile;
  initialConfirmation?: "logout" | "provider" | "revoke" | null;
  initialOutcome?: AccountSecurityLoadOutcome;
  loadAccount?: () => Promise<AccountSecurityLoadOutcome>;
  onSignedOut?: () => void;
  revokeAllSessions?: (csrfToken: string) => Promise<boolean>;
  revokeIdentity?: (linkId: string, csrfToken: string) => Promise<IdentityRevocationOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrincipal(value: unknown): value is SessionPrincipal {
  if (!isRecord(value)) return false;
  const method = value.authenticationMethod;
  return (
    typeof value.sessionId === "string" &&
    IDENTIFIER_PATTERN.test(value.sessionId) &&
    typeof value.userId === "string" &&
    IDENTIFIER_PATTERN.test(value.userId) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    ["viewer", "requester", "operator", "admin"].includes(String(value.role)) &&
    ["active", "pending_link", "recovery"].includes(String(value.accountState)) &&
    Array.isArray(value.permissions) &&
    Array.isArray(value.linkedServices) &&
    isRecord(method) &&
    ["oidc", "jellyfin", "recovery"].includes(String(method.kind))
  );
}

function isLink(value: unknown): value is ServiceIdentityLink {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    IDENTIFIER_PATTERN.test(value.id) &&
    value.service === "jellyfin" &&
    ["linked", "unavailable", "relink_required", "revoked"].includes(String(value.health)) &&
    (value.displayName === null || typeof value.displayName === "string") &&
    (value.username === null || typeof value.username === "string") &&
    (value.lastVerifiedAt === null ||
      (typeof value.lastVerifiedAt === "string" &&
        Number.isFinite(Date.parse(value.lastVerifiedAt))))
  );
}

async function defaultLoadAccount(): Promise<AccountSecurityLoadOutcome> {
  try {
    const sessionResponse = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!sessionResponse.ok) return { status: "unavailable" };
    const session = (await sessionResponse.json()) as unknown;
    if (!isRecord(session) || session.principal === null || session.csrfToken === null) {
      return { status: "signed_out" };
    }
    if (!isPrincipal(session.principal) || !CSRF_PATTERN.test(String(session.csrfToken))) {
      return { status: "unavailable" };
    }

    const linksResponse = await fetch("/api/auth/identity-links", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!linksResponse.ok) {
      return linksResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const linksBody = (await linksResponse.json()) as unknown;
    if (
      !isRecord(linksBody) ||
      !Array.isArray(linksBody.links) ||
      linksBody.links.length > 1 ||
      !linksBody.links.every(isLink)
    ) {
      return { status: "unavailable" };
    }
    return {
      snapshot: {
        csrfToken: String(session.csrfToken),
        links: linksBody.links,
        principal: session.principal,
      },
      status: "ready",
    };
  } catch {
    return { status: "unavailable" };
  }
}

async function defaultRevokeIdentity(
  linkId: string,
  csrfToken: string,
): Promise<IdentityRevocationOutcome> {
  try {
    const response = await fetch(`/api/auth/identity-links/${encodeURIComponent(linkId)}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { [CSRF_HEADER]: csrfToken },
      method: "DELETE",
    });
    if (response.status === 401 || response.status === 403 || response.status === 409) {
      return { status: "session_changed" };
    }
    if (!response.ok) return { status: "failed" };
    const body = (await response.json()) as unknown;
    if (
      !isRecord(body) ||
      !isLink(body.link) ||
      body.link.health !== "revoked" ||
      (body.principal !== null && !isPrincipal(body.principal))
    ) {
      return { status: "failed" };
    }
    return { link: body.link, principal: body.principal, status: "revoked" };
  } catch {
    return { status: "failed" };
  }
}

async function defaultRevokeAllSessions(csrfToken: string) {
  try {
    const response = await fetch("/api/auth/sessions", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { [CSRF_HEADER]: csrfToken },
      method: "DELETE",
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

function defaultSignedOutNavigation() {
  window.location.assign("/login");
}

function healthLabel(health: ServiceIdentityLink["health"]) {
  return {
    linked: "Connected",
    relink_required: "Reconnect required",
    revoked: "Disconnected",
    unavailable: "Server unavailable",
  }[health];
}

function verifiedLabel(timestamp: string | null) {
  if (timestamp === null) return "Verification pending";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "Verification unavailable";
  return `Verified ${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(parsed))}`;
}

export function AccountSecurityPanel({
  displayProfile = "standard",
  initialConfirmation = null,
  initialOutcome,
  loadAccount = defaultLoadAccount,
  onSignedOut = defaultSignedOutNavigation,
  revokeAllSessions = defaultRevokeAllSessions,
  revokeIdentity = defaultRevokeIdentity,
}: AccountSecurityPanelProperties) {
  const [outcome, setOutcome] = useState<AccountSecurityLoadOutcome | null>(initialOutcome ?? null);
  const [operation, setOperation] = useState<"idle" | "logout" | "provider" | "revoke">("idle");
  const [confirmation, setConfirmation] = useState<"logout" | "provider" | "revoke" | null>(
    initialConfirmation,
  );
  const [operationError, setOperationError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setOutcome(null);
    setOperationError(null);
  }, []);

  useEffect(() => {
    if (outcome !== null) return;
    let active = true;
    void loadAccount().then((next) => {
      if (active) setOutcome(next);
    });
    return () => {
      active = false;
    };
  }, [loadAccount, outcome]);

  const snapshot = outcome?.status === "ready" ? outcome.snapshot : null;
  const link = snapshot?.links[0];
  const authenticationLabel =
    snapshot?.principal.authenticationMethod.kind === "oidc"
      ? snapshot.principal.authenticationMethod.providerId
      : snapshot?.principal.authenticationMethod.kind === "jellyfin"
        ? "Jellyfin"
        : "Recovery access";
  const jellyfinProofHref =
    snapshot?.principal.authenticationMethod.kind === "oidc" ? "/link/jellyfin" : "/login/jellyfin";

  const confirmRevoke = async () => {
    if (!snapshot || !link || operation !== "idle") return;
    setOperation("revoke");
    setOperationError(null);
    const result = await revokeIdentity(link.id, snapshot.csrfToken);
    setOperation("idle");
    setConfirmation(null);
    if (result.status === "session_changed") {
      onSignedOut();
      return;
    }
    if (result.status === "failed") {
      setOperationError(
        "Jellyfin could not be disconnected. Your existing link was left unchanged.",
      );
      return;
    }
    if (result.principal === null) {
      onSignedOut();
      return;
    }
    setOutcome({
      snapshot: { ...snapshot, links: [result.link], principal: result.principal },
      status: "ready",
    });
  };

  const confirmLogout = async () => {
    if (!snapshot || operation !== "idle") return;
    setOperation("logout");
    setOperationError(null);
    const succeeded = await revokeAllSessions(snapshot.csrfToken);
    setOperation("idle");
    setConfirmation(null);
    if (succeeded) {
      onSignedOut();
      return;
    }
    setOperationError("Sessions could not be revoked. You remain signed in on this browser.");
  };

  return (
    <div className="account-layout" data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className="account-shell" id="main-content" tabIndex={-1}>
        <header className="account-shell__topbar">
          <BrandMark />
          <Link className="account-shell__back" href="/">
            <ArrowLeft aria-hidden="true" size={17} />
            Back to home
          </Link>
        </header>

        <section className="account-hero" aria-labelledby="account-title">
          <div>
            <p className="eyebrow">Account &amp; access</p>
            <h1 id="account-title">Your identity, under your control.</h1>
            <p>
              Review how you sign in, manage the Jellyfin account that carries your media
              permissions, and close every local session from one place.
            </p>
          </div>
          {snapshot ? (
            <span className="account-hero__status" data-state={snapshot.principal.accountState}>
              <span aria-hidden="true" />
              {snapshot.principal.accountState === "active" ? "Account ready" : "Action required"}
            </span>
          ) : null}
        </section>

        {outcome === null ? (
          <section aria-busy="true" aria-label="Loading account security" className="account-grid">
            <div className="account-card account-card--skeleton" />
            <div className="account-card account-card--skeleton" />
          </section>
        ) : outcome.status === "signed_out" ? (
          <section className="account-state" role="status">
            <KeyRound aria-hidden="true" size={28} />
            <div>
              <h2>Your session has ended.</h2>
              <p>Sign in again to review identity links and local sessions.</p>
            </div>
            <Link className="button button--primary" href="/login">
              Continue to sign in <ArrowRight aria-hidden="true" size={17} />
            </Link>
          </section>
        ) : outcome.status === "unavailable" ? (
          <section className="account-state" role="alert">
            <WifiOff aria-hidden="true" size={28} />
            <div>
              <h2>Account details are temporarily unavailable.</h2>
              <p>No settings were changed. Check the gateway connection and try again.</p>
            </div>
            <button className="button button--glass" onClick={refresh} type="button">
              Try again <RefreshCw aria-hidden="true" size={17} />
            </button>
          </section>
        ) : (
          <>
            {operationError ? (
              <div className="account-operation-error" role="alert">
                <CircleAlert aria-hidden="true" size={18} />
                <p>{operationError}</p>
              </div>
            ) : null}
            <section className="account-grid" aria-label="Account security controls">
              <article className="account-card">
                <div className="account-card__header">
                  <span className="account-card__icon" aria-hidden="true">
                    <ShieldCheck size={22} />
                  </span>
                  <div>
                    <p className="section-kicker">Sign-in identity</p>
                    <h2>{snapshot!.principal.displayName}</h2>
                  </div>
                </div>
                <dl className="account-facts">
                  <div>
                    <dt>Authenticated with</dt>
                    <dd>{authenticationLabel}</dd>
                  </div>
                  <div>
                    <dt>Omnifin role</dt>
                    <dd>{snapshot!.principal.role}</dd>
                  </div>
                  <div>
                    <dt>Session access</dt>
                    <dd>
                      {snapshot!.principal.accountState === "active"
                        ? "Full role access"
                        : "Pairing only"}
                    </dd>
                  </div>
                </dl>
                <div className="account-card__footer">
                  {confirmation === "provider" ? (
                    <div
                      className="account-confirmation"
                      role="group"
                      aria-label="Confirm identity provider logout"
                    >
                      <p>
                        Omnifin closes this browser session, then asks your identity provider to
                        close its browser session. Other Omnifin devices stay signed in.
                      </p>
                      <div>
                        <button
                          className="account-action account-action--quiet"
                          disabled={operation !== "idle"}
                          onClick={() => setConfirmation(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                        <form
                          action="/api/auth/oidc/logout"
                          aria-label="Identity provider logout"
                          className="account-provider-logout"
                          method="post"
                          onSubmit={() => setOperation("provider")}
                        >
                          <input name="csrfToken" type="hidden" value={snapshot!.csrfToken} />
                          <button
                            className="account-action account-action--danger"
                            disabled={operation !== "idle"}
                            type="submit"
                          >
                            {operation === "provider" ? (
                              <LoaderCircle
                                aria-hidden="true"
                                className="jellyfin-login-form__spinner"
                                size={16}
                              />
                            ) : (
                              <LogOut aria-hidden="true" size={16} />
                            )}
                            Continue sign out
                          </button>
                        </form>
                      </div>
                    </div>
                  ) : confirmation === "logout" ? (
                    <div className="account-confirmation" role="group" aria-label="Confirm logout">
                      <p>This signs you out on every browser and device using Omnifin.</p>
                      <div>
                        <button
                          className="account-action account-action--quiet"
                          disabled={operation !== "idle"}
                          onClick={() => setConfirmation(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className="account-action account-action--danger"
                          disabled={operation !== "idle"}
                          onClick={confirmLogout}
                          type="button"
                        >
                          {operation === "logout" ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="jellyfin-login-form__spinner"
                              size={16}
                            />
                          ) : (
                            <LogOut aria-hidden="true" size={16} />
                          )}
                          Sign out everywhere
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="account-card__actions">
                      {snapshot!.principal.authenticationMethod.kind === "oidc" ? (
                        <button
                          className="account-action account-action--quiet"
                          onClick={() => setConfirmation("provider")}
                          type="button"
                        >
                          <LogOut aria-hidden="true" size={17} /> Sign out through provider
                        </button>
                      ) : null}
                      <button
                        className="account-action account-action--danger-outline"
                        onClick={() => setConfirmation("logout")}
                        type="button"
                      >
                        <LogOut aria-hidden="true" size={17} /> Sign out everywhere
                      </button>
                    </div>
                  )}
                </div>
              </article>

              <article className="account-card">
                <div className="account-card__header">
                  <span className="account-card__icon" aria-hidden="true">
                    <UserRoundCheck size={22} />
                  </span>
                  <div>
                    <p className="section-kicker">Media identity</p>
                    <h2>Jellyfin</h2>
                  </div>
                  {link ? (
                    <span className="account-link-health" data-health={link.health}>
                      {healthLabel(link.health)}
                    </span>
                  ) : null}
                </div>

                {link ? (
                  <div className="account-link-detail">
                    <div className="account-link-detail__identity">
                      <span aria-hidden="true">
                        {(link.displayName ?? link.username ?? "J")[0]}
                      </span>
                      <div>
                        <strong>{link.displayName ?? link.username ?? "Jellyfin account"}</strong>
                        <small>
                          {link.username ? `@${link.username}` : "Username unavailable"}
                        </small>
                      </div>
                    </div>
                    <p>
                      <CheckCircle2 aria-hidden="true" size={15} />
                      {verifiedLabel(link.lastVerifiedAt)}
                    </p>
                  </div>
                ) : (
                  <div className="account-link-empty">
                    <Link2 aria-hidden="true" size={24} />
                    <h3>No Jellyfin account is connected.</h3>
                    <p>Link your own account to unlock media access with its exact permissions.</p>
                  </div>
                )}

                <div className="account-card__footer">
                  {confirmation === "revoke" && link ? (
                    <div
                      className="account-confirmation"
                      role="group"
                      aria-label="Confirm disconnect"
                    >
                      <p>
                        Access stops immediately, the saved token is erased, and other Omnifin
                        sessions are closed.
                      </p>
                      <div>
                        <button
                          className="account-action account-action--quiet"
                          disabled={operation !== "idle"}
                          onClick={() => setConfirmation(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className="account-action account-action--danger"
                          disabled={operation !== "idle"}
                          onClick={confirmRevoke}
                          type="button"
                        >
                          {operation === "revoke" ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="jellyfin-login-form__spinner"
                              size={16}
                            />
                          ) : (
                            <Unlink aria-hidden="true" size={16} />
                          )}
                          Disconnect Jellyfin
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="account-card__actions">
                      <Link
                        className="account-action account-action--primary"
                        href={jellyfinProofHref}
                      >
                        <RefreshCw aria-hidden="true" size={16} />
                        {link && link.health !== "revoked" ? "Relink account" : "Link account"}
                      </Link>
                      {link && link.health !== "revoked" ? (
                        <button
                          className="account-action account-action--danger-outline"
                          onClick={() => setConfirmation("revoke")}
                          type="button"
                        >
                          <Unlink aria-hidden="true" size={16} /> Disconnect
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              </article>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
