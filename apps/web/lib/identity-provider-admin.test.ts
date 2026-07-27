import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  IdentityProviderAdminClientError,
  identityProviderAdminClient,
  loadIdentityProviderAdministration,
} from "./identity-provider-admin";

const csrfToken = "identity_provider_admin_csrf_0123456789abcdef";
const jellyfinLink = {
  displayName: "Administrator",
  externalUserId: "jellyfin-admin",
  health: "linked" as const,
  id: "admin-link",
  lastVerifiedAt: "2026-07-26T12:00:00.000Z",
  linkedAt: "2026-07-25T12:00:00.000Z",
  service: "jellyfin" as const,
  username: "administrator",
};
const principal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" as const },
  displayName: "Administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [jellyfinLink],
  permissions: ROLE_PERMISSIONS.admin,
  role: "admin" as const,
  sessionId: "admin-session",
  userId: "admin-user",
};
const provider = {
  allowJitProvisioning: true,
  approvedEndpointOrigins: ["https://id.example.test"],
  clientId: "omnifin",
  clientSecretConfigured: true,
  createdAt: "2026-07-26T12:00:00.000Z",
  discoveryCheckedAt: null,
  discoveryState: "unchecked" as const,
  displayName: "Authentik",
  enabled: false,
  id: "oidc-authentik",
  idTokenSigningAlg: "RS256" as const,
  issuer: "https://id.example.test/application/o/omnifin/",
  scopes: ["openid", "profile", "email"],
  slug: "authentik",
  tokenEndpointAuthMethod: "client_secret_basic" as const,
  updatedAt: "2026-07-26T12:00:00.000Z",
};

it("uses CSP-safe schema validation in the browser client", () => {
  expect(z.config().jitless).toBe(true);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("identity provider administration client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a permission-checked, secret-free administration snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken, principal }))
      .mockResolvedValueOnce(jsonResponse({ providers: [provider] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadIdentityProviderAdministration()).resolves.toEqual({
      snapshot: { csrfToken, principal, providers: [provider] },
      status: "ready",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/auth/oidc/providers",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("stops before the administration endpoint when local permission is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        csrfToken,
        principal: { ...principal, permissions: ROLE_PERMISSIONS.viewer, role: "viewer" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadIdentityProviderAdministration()).resolves.toEqual({ status: "forbidden" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends strict create requests with same-origin CSRF proof", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(provider, 201));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      allowJitProvisioning: true,
      approvedEndpointOrigins: ["https://id.example.test"],
      clientId: "omnifin",
      clientSecret: "private-secret",
      displayName: "Authentik",
      enabled: false,
      idTokenSigningAlg: "RS256" as const,
      issuer: provider.issuer,
      scopes: ["openid", "profile", "email"],
      slug: "authentik",
      tokenEndpointAuthMethod: "client_secret_basic" as const,
    };

    await expect(identityProviderAdminClient.createProvider(input, csrfToken)).resolves.toEqual(
      provider,
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/auth/oidc/providers");
    expect(request).toMatchObject({ credentials: "same-origin", method: "POST" });
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(JSON.parse(String(request.body))).toEqual(input);
  });

  it("normalizes a changed session without reflecting untrusted error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "permission_denied",
              message: "This action is not permitted.",
              requestId: "request-1",
            },
          },
          403,
        ),
      ),
    );

    const error = await identityProviderAdminClient
      .deleteProvider(provider.id, csrfToken)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdentityProviderAdminClientError);
    expect(error).toMatchObject({ code: "session_changed", kind: "session_changed" });
  });

  it("uses strict versioned routes for provider lifecycle and role mappings", async () => {
    const mapping = {
      claimPath: ["groups"],
      enabled: true,
      id: "mapping-operators",
      operator: "contains_any" as const,
      priority: 500,
      providerId: provider.id,
      role: "operator" as const,
      values: ["media-operators"],
    };
    const capabilities = {
      authorizationCodeFlow: true,
      idTokenSigningAlg: "RS256" as const,
      logout: {
        backChannel: true,
        backChannelSession: true,
        frontChannel: true,
        frontChannelSession: true,
        rpInitiated: true,
      },
      pkceS256: true,
      schemaVersion: 1 as const,
      tokenEndpointAuthMethod: "client_secret_basic" as const,
      userInfo: true,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ provider, revokedSessions: 2 }))
      .mockResolvedValueOnce(jsonResponse({ capabilities, provider }))
      .mockResolvedValueOnce(jsonResponse({ mappings: [mapping] }))
      .mockResolvedValueOnce(jsonResponse({ mapping, revokedSessions: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ deletedMappingId: mapping.id, revokedSessions: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({
          deletedProviderId: provider.id,
          deletedRoleMappings: 1,
          revokedSessions: 0,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const update = {
      allowJitProvisioning: provider.allowJitProvisioning,
      approvedEndpointOrigins: provider.approvedEndpointOrigins,
      clientId: provider.clientId,
      displayName: provider.displayName,
      enabled: provider.enabled,
      idTokenSigningAlg: provider.idTokenSigningAlg,
      issuer: provider.issuer,
      scopes: provider.scopes,
      slug: provider.slug,
      tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
    };
    const mappingInput = {
      claimPath: mapping.claimPath,
      enabled: mapping.enabled,
      operator: mapping.operator,
      priority: mapping.priority,
      role: mapping.role,
      values: mapping.values,
    };

    await expect(
      identityProviderAdminClient.updateProvider(provider.id, update, csrfToken),
    ).resolves.toEqual({ provider, revokedSessions: 2 });
    await expect(
      identityProviderAdminClient.validateProvider(provider.id, csrfToken),
    ).resolves.toEqual({ capabilities, provider });
    await expect(identityProviderAdminClient.listRoleMappings(provider.id)).resolves.toEqual([
      mapping,
    ]);
    await expect(
      identityProviderAdminClient.createRoleMapping(provider.id, mappingInput, csrfToken),
    ).resolves.toEqual({ mapping, revokedSessions: 1 });
    await expect(
      identityProviderAdminClient.deleteRoleMapping(provider.id, mapping.id, csrfToken),
    ).resolves.toEqual({ deletedMappingId: mapping.id, revokedSessions: 1 });
    await expect(
      identityProviderAdminClient.deleteProvider(provider.id, csrfToken),
    ).resolves.toEqual({
      deletedProviderId: provider.id,
      deletedRoleMappings: 1,
      revokedSessions: 0,
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/api/admin/auth/oidc/providers/${provider.id}`,
      `/api/admin/auth/oidc/providers/${provider.id}/validate`,
      `/api/admin/auth/oidc/providers/${provider.id}/role-mappings`,
      `/api/admin/auth/oidc/providers/${provider.id}/role-mappings`,
      `/api/admin/auth/oidc/providers/${provider.id}/role-mappings/${mapping.id}`,
      `/api/admin/auth/oidc/providers/${provider.id}`,
    ]);
    expect(fetchMock.mock.calls.map(([, request]) => request?.method ?? "GET")).toEqual([
      "PUT",
      "POST",
      "GET",
      "POST",
      "DELETE",
      "DELETE",
    ]);
  });

  it.each([
    [401, "signed_out"],
    [503, "unavailable"],
  ] as const)("maps a %s session response to %s", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({}, status)));
    await expect(loadIdentityProviderAdministration()).resolves.toEqual({ status: expected });
  });

  it("rejects malformed, incomplete, and permission-changing load responses", async () => {
    const cases = [
      { expected: "signed_out", responses: [jsonResponse({ csrfToken: null, principal: null })] },
      { expected: "unavailable", responses: [jsonResponse({ unexpected: true })] },
      {
        expected: "forbidden",
        responses: [jsonResponse({ csrfToken, principal }), jsonResponse({}, 403)],
      },
      {
        expected: "unavailable",
        responses: [
          jsonResponse({ csrfToken, principal }),
          jsonResponse({ providers: [{ ...provider, secret: "x" }] }),
        ],
      },
    ] as const;

    for (const { expected, responses: configuredResponses } of cases) {
      const responses: Response[] = [...configuredResponses];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() => responses.shift()),
      );
      await expect(loadIdentityProviderAdministration()).resolves.toEqual({ status: expected });
      vi.unstubAllGlobals();
    }
  });

  it("normalizes upstream rejections and contract violations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "provider_in_use",
              message: "Disable linked identities first.",
              requestId: "request-provider-in-use",
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ provider: "invalid" }))
      .mockResolvedValueOnce(new Response("not-json", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      identityProviderAdminClient.deleteProvider(provider.id, csrfToken),
    ).rejects.toMatchObject({
      code: "provider_in_use",
      kind: "rejected",
      message: "Disable linked identities first.",
    });
    await expect(
      identityProviderAdminClient.validateProvider(provider.id, csrfToken),
    ).rejects.toMatchObject({ code: "invalid_response", kind: "invalid_response" });
    await expect(identityProviderAdminClient.listRoleMappings(provider.id)).rejects.toMatchObject({
      code: "invalid_response",
      kind: "invalid_response",
    });
  });

  it("turns network failures into non-reflective availability errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network details")));

    await expect(
      identityProviderAdminClient.validateProvider(provider.id, csrfToken),
    ).rejects.toMatchObject({ code: "service_unavailable", kind: "unavailable" });
    await expect(identityProviderAdminClient.listRoleMappings(provider.id)).rejects.toMatchObject({
      code: "service_unavailable",
      kind: "unavailable",
      message: "Role mappings could not be loaded.",
    });
    await expect(loadIdentityProviderAdministration()).resolves.toEqual({ status: "unavailable" });
  });
});
