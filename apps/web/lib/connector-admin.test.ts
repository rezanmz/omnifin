import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";
import type { ConnectorAdmin } from "@omnifin/contracts/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorAdminClientError,
  connectorAdminClient,
  loadConnectorAdministration,
} from "./connector-admin";

const csrfToken = "connector_admin_csrf_0123456789abcdefghijklmnop";
const principal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active" as const,
  authenticationMethod: { kind: "jellyfin" as const },
  displayName: "Administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administrator",
      externalUserId: "jellyfin-admin",
      health: "linked" as const,
      id: "admin-link",
      lastVerifiedAt: "2026-07-26T12:00:00.000Z",
      linkedAt: "2026-07-25T12:00:00.000Z",
      service: "jellyfin" as const,
      username: "administrator",
    },
  ],
  permissions: ROLE_PERMISSIONS.admin,
  role: "admin" as const,
  sessionId: "admin-session",
  userId: "admin-user",
};
const jellyfin: ConnectorAdmin = {
  baseUrl: "https://jellyfin.example.test",
  createdAt: "2026-07-26T12:00:00.000Z",
  credentialKind: "none",
  credentialsConfigured: true,
  displayName: "Jellyfin",
  enabled: false,
  healthState: "unknown",
  id: "jellyfin-primary",
  insecureHttpApproved: false,
  lastProbe: null,
  revision: "revision_0123456789abcdef",
  service: "jellyfin",
  tlsCaCertificateConfigured: false,
  tlsPolicy: "strict",
  updatedAt: "2026-07-26T12:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("connector administration client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads every page after checking local connector authority", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken, principal }))
      .mockResolvedValueOnce(
        jsonResponse({ items: [jellyfin], nextCursor: "connector_cursor_next" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ ...jellyfin, displayName: "Radarr", id: "radarr-primary", service: "radarr" }],
          nextCursor: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadConnectorAdministration()).resolves.toMatchObject({
      snapshot: {
        connectors: [jellyfin, { displayName: "Radarr", id: "radarr-primary", service: "radarr" }],
        csrfToken,
        recoveryOnly: false,
      },
      status: "ready",
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/session",
      "/api/admin/connectors?limit=50",
      "/api/admin/connectors?limit=50&cursor=connector_cursor_next",
    ]);
  });

  it("admits the narrow Jellyfin recovery permission without granting full management", async () => {
    const recoveryPrincipal = {
      ...principal,
      accountState: "recovery" as const,
      authenticationMethod: { kind: "recovery" as const },
      linkedServices: [],
      permissions: [
        "recovery.oidc.manage",
        "recovery.jellyfin.manage",
        "recovery.sessions.revoke",
      ] as const,
      role: "admin" as const,
      userId: null,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ csrfToken, principal: recoveryPrincipal }))
        .mockResolvedValueOnce(jsonResponse({ items: [jellyfin], nextCursor: null })),
    );

    await expect(loadConnectorAdministration()).resolves.toMatchObject({
      snapshot: { connectors: [jellyfin], recoveryOnly: true },
      status: "ready",
    });
  });

  it("stops before connector data when the principal has no management permission", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        csrfToken,
        principal: { ...principal, permissions: ROLE_PERMISSIONS.viewer, role: "viewer" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadConnectorAdministration()).resolves.toEqual({ status: "forbidden" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends validated, CSRF-bound lifecycle requests without reflecting credentials", async () => {
    const healthy = {
      ...jellyfin,
      healthState: "healthy" as const,
      lastProbe: {
        capabilities: ["connector.health"],
        checkedAt: "2026-07-26T12:01:00.000Z",
        connectorId: jellyfin.id,
        displayName: jellyfin.displayName,
        failure: null,
        latencyMs: 18,
        service: "jellyfin" as const,
        status: "healthy" as const,
        version: "10.10.7",
      },
      revision: "revision_1234567890abcdef",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ connector: jellyfin }, 201))
      .mockResolvedValueOnce(jsonResponse({ connector: healthy }))
      .mockResolvedValueOnce(jsonResponse({ connector: healthy }))
      .mockResolvedValueOnce(jsonResponse({ connector: healthy }))
      .mockResolvedValueOnce(jsonResponse({ deletedConnectorId: jellyfin.id }));
    vi.stubGlobal("fetch", fetchMock);

    await connectorAdminClient.create(
      {
        baseUrl: jellyfin.baseUrl,
        credentials: { kind: "none" },
        displayName: jellyfin.displayName,
        id: jellyfin.id,
        insecureHttpApproved: false,
        service: "jellyfin",
        tlsPolicy: "strict",
      },
      csrfToken,
    );
    await connectorAdminClient.probe(jellyfin.id, csrfToken);
    await connectorAdminClient.update(
      jellyfin.id,
      { enabled: true, revision: healthy.revision },
      csrfToken,
    );
    await connectorAdminClient.get(jellyfin.id);
    await connectorAdminClient.delete(jellyfin.id, healthy.revision, csrfToken);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/connectors",
      `/api/admin/connectors/${jellyfin.id}/probe`,
      `/api/admin/connectors/${jellyfin.id}`,
      `/api/admin/connectors/${jellyfin.id}`,
      `/api/admin/connectors/${jellyfin.id}?revision=revision_1234567890abcdef`,
    ]);
    expect(fetchMock.mock.calls.map(([, request]) => request?.method ?? "GET")).toEqual([
      "POST",
      "POST",
      "PATCH",
      "GET",
      "DELETE",
    ]);
    for (const index of [0, 1, 2, 4]) {
      const request = fetchMock.mock.calls[index]?.[1] as RequestInit;
      expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    }
  });

  it("normalizes session changes, upstream errors, malformed data, and network failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "connector_revision_conflict",
              message: "The connector changed in another session.",
              requestId: "request-conflict",
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ connector: { secret: "must-not-pass" } }))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockRejectedValueOnce(new Error("private destination details"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      connectorAdminClient.delete(jellyfin.id, jellyfin.revision, csrfToken),
    ).rejects.toMatchObject({
      code: "connector_revision_conflict",
      kind: "rejected",
      message: "The connector changed in another session.",
    });
    await expect(connectorAdminClient.get(jellyfin.id)).rejects.toMatchObject({
      code: "invalid_response",
      kind: "invalid_response",
    });
    await expect(connectorAdminClient.probe(jellyfin.id, csrfToken)).rejects.toBeInstanceOf(
      ConnectorAdminClientError,
    );
    await expect(connectorAdminClient.get(jellyfin.id)).rejects.toMatchObject({
      code: "service_unavailable",
      kind: "unavailable",
      message: "The gateway could not be reached. No connector settings were changed.",
    });
  });

  it.each([
    [401, "signed_out"],
    [503, "unavailable"],
  ] as const)("maps a %s session response to %s", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({}, status)));
    await expect(loadConnectorAdministration()).resolves.toEqual({ status: expected });
  });
});
