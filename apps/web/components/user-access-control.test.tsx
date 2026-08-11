import {
  ROLE_PERMISSIONS,
  type SessionPrincipal,
  type UserAccessSummary,
} from "@omnifin/contracts/auth";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  UserAccessAdminClientError,
  type UserAccessAdminClient,
  type UserAccessAdminLoadOutcome,
} from "../lib/user-access-admin";
import { UserAccessControl } from "./user-access-control";

const csrfToken = "component_user_access_csrf_0123456789abcdefghijk";
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-31T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-30T13:00:00.000Z",
  issuedAt: "2026-07-30T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administrator",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-link",
      lastVerifiedAt: "2026-07-30T12:00:00.000Z",
      linkedAt: "2026-07-28T12:00:00.000Z",
      service: "jellyfin",
      username: "administrator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.admin],
  role: "admin",
  sessionId: "admin-session",
  userId: "admin-user",
};
const admin: UserAccessSummary = {
  activeSessions: 1,
  authenticationMethods: ["jellyfin"],
  createdAt: "2026-07-28T12:00:00.000Z",
  displayName: "Administrator",
  id: "admin-user",
  jellyfinLinkHealth: "linked",
  lastActiveAt: "2026-07-30T12:00:00.000Z",
  role: "admin",
  roleSource: "manual",
  status: "active",
  updatedAt: "2026-07-30T12:00:00.000Z",
};
const viewer: UserAccessSummary = {
  activeSessions: 2,
  authenticationMethods: ["jellyfin"],
  createdAt: "2026-07-29T12:00:00.000Z",
  displayName: "Morgan Lee",
  id: "viewer-user",
  jellyfinLinkHealth: "linked",
  lastActiveAt: "2026-07-30T11:30:00.000Z",
  role: "viewer",
  roleSource: "default",
  status: "active",
  updatedAt: "2026-07-30T11:30:00.000Z",
};
const oidcViewer: UserAccessSummary = {
  ...viewer,
  authenticationMethods: ["oidc"],
  displayName: "OIDC Morgan",
  id: "oidc-viewer-user",
  jellyfinLinkHealth: null,
  roleSource: "default",
};

function readyOutcome(
  users: readonly UserAccessSummary[] = [admin, viewer],
): UserAccessAdminLoadOutcome {
  return { snapshot: { csrfToken, principal, users }, status: "ready" };
}

function client(update: UserAccessAdminClient["update"] = vi.fn()): UserAccessAdminClient {
  return {
    assignOidcRole: vi.fn(async () => ({
      effectiveAfter: "next_oidc_sign_in" as const,
      fallbackPrecedence: "lowest" as const,
      mappingId: "mapping-user-fallback",
      priority: 0 as const,
      revokedSessions: 0,
      role: "viewer" as const,
    })),
    load: vi.fn(async () => readyOutcome()),
    update,
  };
}

describe("UserAccessControl", () => {
  it("assigns a provider-owned individual fallback with truthful timing", async () => {
    const user = userEvent.setup();
    const assignOidcRole = vi.fn(async () => ({
      effectiveAfter: "next_oidc_sign_in" as const,
      fallbackPrecedence: "lowest" as const,
      mappingId: "mapping-user-fallback",
      priority: 0 as const,
      revokedSessions: 2,
      role: "operator" as const,
    }));
    const load = vi.fn(async () => readyOutcome([admin, oidcViewer]));
    render(
      <UserAccessControl
        client={{ assignOidcRole, load, update: vi.fn() }}
        embedded
        initialOutcome={readyOutcome([admin, oidcViewer])}
      />,
    );

    await user.click(screen.getByRole("button", { name: /OIDC Morgan/i }));
    await user.click(screen.getByRole("button", { name: "Assign individual provider role" }));
    expect(screen.getByText(/after the target's next OIDC sign-in/i)).toBeVisible();
    const wizard = screen
      .getByRole("heading", { name: "Assign an individual role" })
      .closest("section");
    expect(wizard).not.toBeNull();
    await user.click(within(wizard!).getByRole("button", { name: /operator.*Manage requests/i }));
    await user.click(within(wizard!).getByRole("button", { name: "Continue" }));
    expect(
      within(wizard!).getByRole("region", { name: "Review role assignment" }),
    ).toHaveTextContent("Higher-priority provider mappings may override it");
    await user.click(within(wizard!).getByRole("button", { name: "Apply provider role" }));

    await waitFor(() =>
      expect(assignOidcRole).toHaveBeenCalledWith(
        oidcViewer.id,
        { expectedUpdatedAt: oidcViewer.updatedAt, role: "operator" },
        csrfToken,
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("next OIDC sign-in");
  });

  it("stages a role change, explains session impact, and applies the optimistic revision", async () => {
    const user = userEvent.setup();
    const update = vi.fn(async () => ({
      revokedSessions: 2,
      user: {
        ...viewer,
        activeSessions: 0,
        role: "operator" as const,
        roleSource: "manual" as const,
      },
    }));
    render(<UserAccessControl client={client(update)} embedded initialOutcome={readyOutcome()} />);

    expect(screen.getByRole("button", { name: /admin.*Full identity/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Morgan Lee/i }));
    await user.click(screen.getByRole("button", { name: /operator.*Manage requests/i }));
    expect(screen.getByRole("region", { name: "Review access change" })).toHaveTextContent(
      "viewer → operator",
    );
    expect(screen.getByRole("region", { name: "Review access change" })).toHaveTextContent(
      "2 active sessions will close",
    );
    await user.click(screen.getByRole("button", { name: "Apply & revoke sessions" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        viewer.id,
        { expectedUpdatedAt: viewer.updatedAt, role: "operator" },
        csrfToken,
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Morgan Lee was updated. 2 active sessions closed.",
    );
  });

  it("keeps a rejected change staged and offers a fresh directory reload", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => readyOutcome());
    const update = vi.fn(async () => {
      throw new UserAccessAdminClientError(
        "rejected",
        "user_access_revision_conflict",
        "The account changed since it was loaded.",
      );
    });
    render(
      <UserAccessControl
        client={{
          assignOidcRole: vi.fn(),
          load,
          update,
        }}
        embedded
        initialOutcome={readyOutcome()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Morgan Lee/i }));
    await user.click(screen.getByRole("button", { name: "Access enabled" }));
    await user.click(screen.getByRole("button", { name: "Apply & revoke sessions" }));

    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.find((alert) =>
        alert.textContent?.includes("The account changed since it was loaded."),
      ),
    ).toHaveTextContent("The account changed since it was loaded.");
    expect(screen.getByRole("region", { name: "Review access change" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reload directory" }));
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
  });

  it.each([
    ["signed_out", "Your administrative session ended."],
    ["forbidden", "This directory is restricted."],
    ["unavailable", "The access directory is temporarily offline."],
  ] as const)("renders the %s degraded state", (status, heading) => {
    render(<UserAccessControl client={client()} embedded initialOutcome={{ status }} />);
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
  });

  it("separates an empty directory from an empty search result", async () => {
    const { unmount } = render(
      <UserAccessControl client={client()} embedded initialOutcome={readyOutcome([])} />,
    );
    expect(screen.getByRole("heading", { name: "No user identities yet." })).toBeVisible();

    unmount();
    const user = userEvent.setup();
    render(<UserAccessControl client={client()} embedded initialOutcome={readyOutcome()} />);
    await user.type(screen.getByRole("searchbox", { name: "Search people" }), "missing person");
    expect(await screen.findByText("No matching identities")).toBeVisible();
  });
});
