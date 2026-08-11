import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadUserAccessAdministration,
  UserAccessAdminClientError,
  userAccessAdminClient,
} from "./user-access-admin";

const csrfToken = "user_access_admin_csrf_0123456789abcdefghijklmnop";
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
      linkedAt: "2026-07-29T12:00:00.000Z",
      service: "jellyfin",
      username: "administrator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.admin],
  role: "admin",
  sessionId: "admin-session",
  userId: "admin-user",
};
const user = {
  activeSessions: 2,
  authenticationMethods: ["jellyfin"] as const,
  createdAt: "2026-07-28T12:00:00.000Z",
  displayName: "Morgan Lee",
  id: "user-morgan",
  jellyfinLinkHealth: "linked" as const,
  lastActiveAt: "2026-07-30T11:45:00.000Z",
  role: "viewer" as const,
  roleSource: "default" as const,
  status: "active" as const,
  updatedAt: "2026-07-30T11:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("user access administration client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads every normalized page after checking the local permission", async () => {
    const secondUser = { ...user, displayName: "Avery Quinn", id: "user-avery" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken, principal }))
      .mockResolvedValueOnce(jsonResponse({ nextCursor: user.id, users: [user] }))
      .mockResolvedValueOnce(jsonResponse({ nextCursor: null, users: [secondUser] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUserAccessAdministration()).resolves.toEqual({
      snapshot: { csrfToken, principal, users: [user, secondUser] },
      status: "ready",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/admin/users?cursor=${user.id}`,
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("does not request user data for ordinary or recovery sessions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken,
          principal: { ...principal, permissions: [...ROLE_PERMISSIONS.viewer], role: "viewer" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken,
          principal: {
            ...principal,
            accountState: "recovery",
            authenticationMethod: { kind: "recovery" },
            linkedServices: [],
            permissions: [...RECOVERY_PERMISSIONS],
            userId: null,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUserAccessAdministration()).resolves.toEqual({ status: "forbidden" });
    await expect(loadUserAccessAdministration()).resolves.toEqual({ status: "forbidden" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends an optimistic mutation with same-origin CSRF proof", async () => {
    const result = {
      revokedSessions: 2,
      user: { ...user, activeSessions: 0, role: "operator", roleSource: "manual" },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);
    const input = { expectedUpdatedAt: user.updatedAt, role: "operator" as const };

    await expect(userAccessAdminClient.update(user.id, input, csrfToken)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/users/${user.id}`,
      expect.objectContaining({
        body: JSON.stringify(input),
        cache: "no-store",
        credentials: "same-origin",
        method: "PATCH",
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
  });

  it("sends only the role assignment contract to the safe OIDC endpoint", async () => {
    const result = {
      effectiveAfter: "next_oidc_sign_in" as const,
      fallbackPrecedence: "lowest" as const,
      mappingId: "mapping-user-fallback",
      priority: 0 as const,
      revokedSessions: 2,
      role: "operator" as const,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(result, 201));
    vi.stubGlobal("fetch", fetchMock);
    const input = { expectedUpdatedAt: user.updatedAt, role: "operator" as const };

    await expect(userAccessAdminClient.assignOidcRole(user.id, input, csrfToken)).resolves.toEqual(
      result,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/users/${user.id}/oidc-role-assignment`,
      expect.objectContaining({
        body: JSON.stringify(input),
        method: "POST",
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain("subject");
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain("provider");
  });

  it("normalizes authority changes and stable gateway conflicts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "last_active_admin_required",
              message: "At least one active administrator must remain.",
              requestId: "request-1",
            },
          },
          409,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      userAccessAdminClient.update(
        user.id,
        { enabled: false, expectedUpdatedAt: user.updatedAt },
        csrfToken,
      ),
    ).rejects.toMatchObject({ code: "permission_changed", kind: "session_changed" });
    const conflict = await userAccessAdminClient
      .update(user.id, { enabled: false, expectedUpdatedAt: user.updatedAt }, csrfToken)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(UserAccessAdminClientError);
    expect(conflict).toMatchObject({
      code: "last_active_admin_required",
      kind: "rejected",
      message: "At least one active administrator must remain.",
    });
  });
});
