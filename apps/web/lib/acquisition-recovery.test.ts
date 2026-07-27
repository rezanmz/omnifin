import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { AcquisitionSearchResponse } from "@omnifin/contracts/acquisition";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcquisitionRecoveryClientError,
  acquisitionRecoveryClient,
  createAcquisitionSearchIdempotencyKey,
} from "./acquisition-recovery";

const csrfToken = "acquisition_recovery_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Ari",
  externalIdentity: {
    displayClaims: { displayName: "Ari" },
    issuer: "https://auth.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "ari-subject",
  },
  inactivityExpiresAt: "2026-07-27T14:00:00.000Z",
  issuedAt: "2026-07-27T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Ari Jellyfin",
      externalUserId: "jellyfin-ari",
      health: "linked",
      id: "jellyfin-link-ari",
      lastVerifiedAt: "2026-07-27T12:00:00.000Z",
      linkedAt: "2026-07-26T12:00:00.000Z",
      service: "jellyfin",
      username: "ari",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.operator],
  role: "operator",
  sessionId: "session-ari",
  userId: "user-ari",
};
const queuedSearch: AcquisitionSearchResponse = {
  acceptedAt: "2026-07-27T12:01:00.000Z",
  operationId: "sonarr:command:77",
  state: "queued",
  target: { kind: "series", mediaId: 8, seasonNumber: 2, service: "sonarr" },
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("acquisition recovery client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads an active acquisition operator and rejects lesser roles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken, principal }))
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken,
          principal: { ...principal, permissions: ROLE_PERMISSIONS.requester, role: "requester" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquisitionRecoveryClient.loadEligibility()).resolves.toEqual({
      snapshot: { csrfToken, principal },
      status: "ready",
    });
    await expect(acquisitionRecoveryClient.loadEligibility()).resolves.toEqual({
      status: "forbidden",
    });
  });

  it("sends only the exact target with CSRF and idempotency protection", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(queuedSearch, 201, { "idempotency-replayed": "false" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      acquisitionRecoveryClient.queueSearch(
        { mediaId: 8, seasonNumber: 2, service: "sonarr" },
        {
          csrfToken,
          idempotencyKey: "acquisition-01234567-89ab-cdef-0123-456789abcdef",
        },
      ),
    ).resolves.toEqual({ replayed: false, search: queuedSearch });

    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/acquisitions/searches");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(new Headers(request?.headers).get("idempotency-key")).toBe(
      "acquisition-01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      mediaId: 8,
      seasonNumber: 2,
      service: "sonarr",
    });
  });

  it("maps ambiguous outcomes and rejects malformed success data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: "acquisition_search_outcome_pending",
                message: "Still pending.",
                requestId: "search-error-1",
              },
            },
            409,
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ command: { apiKey: "private" } }, 201)),
    );

    await expect(
      acquisitionRecoveryClient.queueSearch(
        { mediaId: 42, service: "radarr" },
        {
          csrfToken,
          idempotencyKey: "acquisition-abcdef01-2345-6789-abcd-ef0123456789",
        },
      ),
    ).rejects.toMatchObject({ kind: "pending" });
    await expect(
      acquisitionRecoveryClient.queueSearch(
        { mediaId: 42, service: "radarr" },
        {
          csrfToken,
          idempotencyKey: "acquisition-fedcba98-7654-3210-fedc-ba9876543210",
        },
      ),
    ).rejects.toBeInstanceOf(AcquisitionRecoveryClientError);
  });

  it("creates a cryptographically random bounded search key", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(createAcquisitionSearchIdempotencyKey()).toBe(
      "acquisition-01234567-89ab-cdef-0123-456789abcdef",
    );
  });
});
