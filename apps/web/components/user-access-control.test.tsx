import {
  ROLE_PERMISSIONS,
  type SessionPrincipal,
  type UserAccessSummary,
} from "@omnifin/contracts/auth";
import { render, screen, waitFor } from "@testing-library/react";
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

function readyOutcome(
  users: readonly UserAccessSummary[] = [admin, viewer],
): UserAccessAdminLoadOutcome {
  return { snapshot: { csrfToken, principal, users }, status: "ready" };
}

function client(update: UserAccessAdminClient["update"] = vi.fn()): UserAccessAdminClient {
  return { load: vi.fn(async () => readyOutcome()), update };
}

describe("UserAccessControl", () => {
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
      <UserAccessControl client={{ load, update }} embedded initialOutcome={readyOutcome()} />,
    );

    await user.click(screen.getByRole("button", { name: /Morgan Lee/i }));
    await user.click(screen.getByRole("button", { name: "Access enabled" }));
    await user.click(screen.getByRole("button", { name: "Apply & revoke sessions" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The account changed since it was loaded.",
    );
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
