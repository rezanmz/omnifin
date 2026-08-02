import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServiceIdentityLink, SessionPrincipal } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountSecurityPanel } from "./account-security-panel";

const csrfToken = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const link: ServiceIdentityLink = {
  displayName: "Riley",
  externalUserId: "jellyfin-user-1",
  health: "linked",
  id: "jellyfin-link-1",
  lastVerifiedAt: "2026-07-26T12:00:00.000Z",
  linkedAt: "2026-07-25T12:00:00.000Z",
  service: "jellyfin",
  username: "riley",
};
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Riley Morgan",
  externalIdentity: {
    displayClaims: { displayName: "Riley Morgan" },
    issuer: "https://identity.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "immutable-subject",
  },
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [link],
  permissions: ["media.view", "playback.use", "identities.self.manage", "sessions.self.revoke"],
  role: "viewer",
  sessionId: "session-1",
  userId: "user-1",
};
const ready = { snapshot: { csrfToken, links: [link], principal }, status: "ready" as const };

describe("AccountSecurityPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("presents authentication attribution, role, and normalized Jellyfin health", () => {
    render(<AccountSecurityPanel initialOutcome={ready} />);

    expect(
      screen.getByRole("heading", { name: "Your identity, under your control." }),
    ).toBeVisible();
    expect(screen.getByText("Riley Morgan")).toBeVisible();
    expect(screen.getByText("authentik")).toBeVisible();
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.getByText("@riley")).toBeVisible();
    expect(screen.getByRole("link", { name: "Relink account" })).toHaveAttribute(
      "href",
      "/link/jellyfin",
    );
  });

  it("routes direct Jellyfin users through direct proof when relinking", () => {
    render(
      <AccountSecurityPanel
        initialOutcome={{
          snapshot: {
            ...ready.snapshot,
            principal: {
              ...principal,
              authenticationMethod: { kind: "jellyfin" },
              externalIdentity: null,
            },
          },
          status: "ready",
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "Relink account" })).toHaveAttribute(
      "href",
      "/login/jellyfin",
    );
  });

  it("reveals identity-provider administration only to authorized principals", () => {
    const { rerender } = render(<AccountSecurityPanel initialOutcome={ready} />);
    expect(screen.queryByRole("link", { name: "Identity providers" })).not.toBeInTheDocument();

    rerender(
      <AccountSecurityPanel
        key="authorized-administrator"
        initialOutcome={{
          snapshot: {
            ...ready.snapshot,
            principal: {
              ...principal,
              permissions: [...principal.permissions, "recovery.oidc.manage"],
              role: "admin",
            },
          },
          status: "ready",
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "Identity providers" })).toHaveAttribute(
      "href",
      "/settings/identity-providers",
    );
  });

  it("reveals connector administration to full administrators and Jellyfin recovery", () => {
    const { rerender } = render(<AccountSecurityPanel initialOutcome={ready} />);
    expect(screen.queryByRole("link", { name: "Service connections" })).not.toBeInTheDocument();

    rerender(
      <AccountSecurityPanel
        key="connector-administrator"
        initialOutcome={{
          snapshot: {
            ...ready.snapshot,
            principal: {
              ...principal,
              permissions: [...principal.permissions, "connectors.manage"],
              role: "admin",
            },
          },
          status: "ready",
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Service connections" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
    expect(screen.getByRole("link", { name: "Setup guide" })).toHaveAttribute(
      "href",
      "/onboarding",
    );

    rerender(
      <AccountSecurityPanel
        key="jellyfin-recovery"
        initialOutcome={{
          snapshot: {
            ...ready.snapshot,
            principal: {
              ...principal,
              accountState: "recovery",
              authenticationMethod: { kind: "recovery" },
              permissions: ["recovery.jellyfin.manage", "recovery.sessions.revoke"],
              role: "admin",
            },
          },
          status: "ready",
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Service connections" })).toHaveAttribute(
      "href",
      "/settings/connectors",
    );
    expect(screen.queryByRole("link", { name: "Setup guide" })).not.toBeInTheDocument();
  });

  it("reveals the audit trail only to an authorized non-recovery administrator", () => {
    const { rerender } = render(<AccountSecurityPanel initialOutcome={ready} />);
    expect(screen.queryByRole("link", { name: "Operator audit trail" })).not.toBeInTheDocument();

    rerender(
      <AccountSecurityPanel
        key="audit-administrator"
        initialOutcome={{
          snapshot: {
            ...ready.snapshot,
            principal: {
              ...principal,
              permissions: [...principal.permissions, "audit.view"],
              role: "admin",
            },
          },
          status: "ready",
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Operator audit trail" })).toHaveAttribute(
      "href",
      "/settings/audit",
    );

    rerender(
      <AccountSecurityPanel
        key="audit-recovery"
        initialOutcome={{
          snapshot: {
            ...ready.snapshot,
            principal: {
              ...principal,
              accountState: "recovery",
              authenticationMethod: { kind: "recovery" },
              permissions: ["audit.view"],
              role: "admin",
            },
          },
          status: "ready",
        }}
      />,
    );
    expect(screen.queryByRole("link", { name: "Operator audit trail" })).not.toBeInTheDocument();
  });

  it("requires deliberate confirmation before revoking an identity link", async () => {
    const user = userEvent.setup();
    const pendingPrincipal: SessionPrincipal = {
      ...principal,
      accountState: "pending_link",
      linkedServices: [],
      permissions: ["identities.self.manage", "sessions.self.revoke"],
    };
    const revokedLink = { ...link, health: "revoked" as const };
    const revokeIdentity = vi.fn(async () => ({
      link: revokedLink,
      principal: pendingPrincipal,
      status: "revoked" as const,
    }));
    render(<AccountSecurityPanel initialOutcome={ready} revokeIdentity={revokeIdentity} />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(revokeIdentity).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm disconnect" })).toHaveTextContent(
      "saved token is erased",
    );
    await user.click(screen.getByRole("button", { name: "Disconnect Jellyfin" }));

    await waitFor(() => expect(revokeIdentity).toHaveBeenCalledWith(link.id, csrfToken));
    expect(screen.getByText("Disconnected")).toBeVisible();
    expect(screen.getByRole("link", { name: "Link account" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("revokes every session only after confirmation and then navigates", async () => {
    const user = userEvent.setup();
    const revokeAllSessions = vi.fn(async () => true);
    const onSignedOut = vi.fn();
    render(
      <AccountSecurityPanel
        initialOutcome={ready}
        onSignedOut={onSignedOut}
        revokeAllSessions={revokeAllSessions}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    expect(revokeAllSessions).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm logout" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));

    await waitFor(() => expect(revokeAllSessions).toHaveBeenCalledWith(csrfToken));
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("uses a native exact-body form for identity-provider logout", async () => {
    const user = userEvent.setup();
    const { container } = render(<AccountSecurityPanel initialOutcome={ready} />);

    await user.click(screen.getByRole("button", { name: "Sign out through provider" }));

    expect(
      screen.getByRole("group", { name: "Confirm identity provider logout" }),
    ).toHaveTextContent("Other Omnifin devices stay signed in");
    const form = screen.getByRole("form", { name: "Identity provider logout" });
    expect(form).toHaveAttribute("action", "/api/auth/oidc/logout");
    expect(form).toHaveAttribute("method", "post");
    const fields = form.querySelectorAll("input");
    expect(fields).toHaveLength(1);
    expect(fields[0]).toHaveAttribute("name", "csrfToken");
    expect(fields[0]).toHaveAttribute("type", "hidden");
    expect(fields[0]).toHaveValue(csrfToken);
    expect(container.querySelector('[name="csrfToken"]')).toBe(fields[0]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sign out through provider" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sign out through provider" }));
    const submittedForm = screen.getByRole("form", { name: "Identity provider logout" });
    fireEvent.submit(submittedForm);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue sign out" })).toBeDisabled(),
    );
  });

  it("does not offer provider logout for a direct Jellyfin session", () => {
    render(
      <AccountSecurityPanel
        initialOutcome={{
          snapshot: {
            ...ready.snapshot,
            principal: {
              ...principal,
              authenticationMethod: { kind: "jellyfin" },
              externalIdentity: null,
            },
          },
          status: "ready",
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Sign out through provider" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
  });

  it("sends no body and includes the in-memory CSRF proof on link revocation", async () => {
    const user = userEvent.setup();
    const pendingPrincipal: SessionPrincipal = {
      ...principal,
      accountState: "pending_link",
      linkedServices: [],
      permissions: ["identities.self.manage", "sessions.self.revoke"],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ link: { ...link, health: "revoked" }, principal: pendingPrincipal }),
      );
    render(<AccountSecurityPanel initialOutcome={ready} />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await user.click(screen.getByRole("button", { name: "Disconnect Jellyfin" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/identity-links/jellyfin-link-1", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { "x-omnifin-csrf": csrfToken },
      method: "DELETE",
    });
  });

  it("covers signed-out and unavailable account states", async () => {
    const user = userEvent.setup();
    const loadAccount = vi.fn(async () => ({ status: "signed_out" as const }));
    const { rerender } = render(
      <AccountSecurityPanel initialOutcome={{ status: "unavailable" }} loadAccount={loadAccount} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("temporarily unavailable");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Your session has ended.")).toBeVisible();

    rerender(<AccountSecurityPanel initialOutcome={{ status: "signed_out" }} key="signed-out" />);
    expect(screen.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });
});
