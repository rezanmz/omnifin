import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inviteAdminClient } from "./invite-admin";

const csrfToken = "invite_admin_csrf_0123456789abcdefghijklmnop";
const invitationUrl = `https://app.example.test/invite#invite=${"a".repeat(43)}`;
const invitation = {
  consumedAt: null,
  createdAt: "2026-08-08T10:00:00.000Z",
  expiresAt: "2026-08-15T10:00:00.000Z",
  id: "invite-001",
  revokedAt: null,
  status: "active" as const,
};
const createResponse = {
  invitation,
  invitationUrl,
};

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-15T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-08-14T12:00:00.000Z",
  issuedAt: "2026-08-08T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administrator",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-link",
      lastVerifiedAt: "2026-08-07T12:00:00.000Z",
      linkedAt: "2026-08-01T12:00:00.000Z",
      service: "jellyfin",
      username: "admin",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.admin],
  role: "admin",
  sessionId: "admin-session",
  userId: "admin-user",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("invitation administration adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the canonical create envelope and sends the optional lifetime field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(createResponse, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(inviteAdminClient.create(3_600, csrfToken)).resolves.toEqual(createResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/invites",
      expect.objectContaining({
        body: JSON.stringify({ expiresInSeconds: 3_600 }),
        method: "POST",
      }),
    );
  });

  it("does not recover a URL from a non-canonical response shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          invite: {
            ...invitation,
            invitationUrl: "https://app.example.test/invite?invite=not-a-fragment",
          },
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(inviteAdminClient.create(undefined, csrfToken)).rejects.toMatchObject({
      kind: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/invites",
      expect.objectContaining({ body: "{}" }),
    );
  });

  it("requires the canonical list envelope instead of accepting a bare array", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        csrfToken,
        principal: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(inviteAdminClient.load()).resolves.toEqual({ status: "signed_out" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads an administrator page and carries its cursor into the next request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken, principal }))
      .mockResolvedValueOnce(jsonResponse({ invitations: [invitation], nextCursor: "page-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(inviteAdminClient.load("page-1")).resolves.toEqual({
      csrfToken,
      invites: [invitation],
      nextCursor: "page-2",
      status: "ready",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/invites?cursor=page-1",
      expect.anything(),
    );
  });

  it.each([
    [401, "signed_out"],
    [403, "unavailable"],
  ] as const)(
    "maps a %s session response to %s without probing invitations",
    async (status, result) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, status));
      vi.stubGlobal("fetch", fetchMock);
      await expect(inviteAdminClient.load()).resolves.toEqual({ status: result });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("reports forbidden when a valid session lacks invitation permission", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        csrfToken,
        principal: {
          ...principal,
          permissions: principal.permissions.filter(
            (permission) => permission !== "identities.manage",
          ),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(inviteAdminClient.load()).resolves.toEqual({ status: "forbidden" });
  });

  it("fails safely for an unreachable gateway and a malformed session", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(inviteAdminClient.load()).resolves.toEqual({ status: "unavailable" });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        csrfToken,
        principal: {
          ...principal,
          permissions: principal.permissions.filter(
            (permission) => permission !== "identities.manage",
          ),
        },
      }),
    );
    await expect(inviteAdminClient.load()).resolves.toEqual({ status: "forbidden" });
  });

  it("parses revoke responses and preserves safe gateway error messages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ invitation }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "not_found",
              message: "Invitation is gone.",
              requestId: "request-001",
            },
          },
          404,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(inviteAdminClient.revoke("invite/001", csrfToken)).resolves.toEqual(invitation);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/invites/invite%2F001/revoke",
      expect.anything(),
    );
    await expect(inviteAdminClient.revoke("invite-001", csrfToken)).rejects.toMatchObject({
      kind: "rejected",
      message: "Invitation is gone.",
    });
  });

  it("distinguishes server failures, unreadable bodies, and non-JSON errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "gateway_down",
              message: "Try again later.",
              requestId: "request-002",
            },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({}, 400))
      .mockResolvedValueOnce(
        new Response("{", { status: 400, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(inviteAdminClient.create(undefined, csrfToken)).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(inviteAdminClient.create(undefined, csrfToken)).rejects.toMatchObject({
      kind: "rejected",
      message: "The invitation request could not be completed.",
    });
    await expect(inviteAdminClient.create(undefined, csrfToken)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});
