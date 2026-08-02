import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { auditTrailClient, AuditTrailClientError, loadAuditTrail } from "./audit-trail";

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-08-02T15:00:00.000Z",
  issuedAt: "2026-08-02T13:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administrator",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-link",
      lastVerifiedAt: "2026-08-02T13:55:00.000Z",
      linkedAt: "2026-07-30T12:00:00.000Z",
      service: "jellyfin",
      username: "administrator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.admin],
  role: "admin",
  sessionId: "admin-session",
  userId: "admin-user",
};
const csrfToken = "audit_trail_csrf_0123456789abcdefghijklmnop";
const page = {
  events: [
    {
      actor: { authenticationMethod: "jellyfin", displayName: "Administrator", kind: "user" },
      category: "configuration",
      eventType: "connector.configuration.updated",
      id: "audit_0123456789abcdefghijkl",
      occurredAt: "2026-08-02T13:58:00.000Z",
      outcome: "success",
    },
  ],
  generatedAt: "2026-08-02T14:00:00.000Z",
  nextCursor: null,
} as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("audit trail client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("checks local authority before loading normalized audit events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken, principal }))
      .mockResolvedValueOnce(jsonResponse(page));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadAuditTrail({ category: "configuration", limit: 25, outcome: "success" }),
    ).resolves.toEqual({ page, status: "ready" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/audit-events?category=configuration&limit=25&outcome=success",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("does not ask for events when the session is signed out or restricted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: null, principal: null }))
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken,
          principal: {
            ...principal,
            permissions: [...ROLE_PERMISSIONS.viewer],
            role: "viewer",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadAuditTrail()).resolves.toEqual({ status: "signed_out" });
    await expect(loadAuditTrail()).resolves.toEqual({ status: "forbidden" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("encodes an opaque continuation cursor and active filters exactly once", async () => {
    const cursor = `audit_cursor_v2.${"A".repeat(16)}.${"B".repeat(32)}.${"C".repeat(22)}`;
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(page));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      auditTrailClient.page({ category: "access", cursor, limit: 25, outcome: "denied" }),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/audit-events?category=access&cursor=${encodeURIComponent(cursor)}&limit=25&outcome=denied`,
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("normalizes session changes, gateway failures, and invalid responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ events: [{ metadata: "private" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(auditTrailClient.page()).rejects.toMatchObject({
      code: "permission_changed",
      kind: "session_changed",
    });
    await expect(auditTrailClient.page()).rejects.toBeInstanceOf(AuditTrailClientError);
    await expect(auditTrailClient.page()).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
