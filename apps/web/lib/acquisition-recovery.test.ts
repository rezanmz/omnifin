import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  AcquisitionQueueRecoveryResponse,
  AcquisitionSearchResponse,
} from "@omnifin/contracts/acquisition";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcquisitionRecoveryClientError,
  acquisitionRecoveryClient,
  createAcquisitionQueueRecoveryIdempotencyKey,
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
const recoveryReference = `aqr_v2.${"A".repeat(100)}`;
const recoveredQueueItem: AcquisitionQueueRecoveryResponse = {
  completedAt: "2026-07-27T12:02:00.000Z",
  eventId: "acquisition_ABCDEFGHIJKLMNOPQRSTUV",
  operationId: "acquisition_recovery_ABCDEFGHIJKLMNOPQRSTUV",
  service: "radarr",
  state: "removed_and_blocklisted",
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

  it("fails closed for signed-out, unavailable, malformed, and inactive sessions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "malformed" }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: null, principal: null }))
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken,
          principal: {
            ...principal,
            accountState: "pending_link",
            linkedServices: [],
            permissions: ["identities.self.manage", "sessions.self.revoke"],
            role: "viewer",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquisitionRecoveryClient.loadEligibility()).resolves.toEqual({
      status: "signed_out",
    });
    await expect(acquisitionRecoveryClient.loadEligibility()).resolves.toEqual({
      status: "unavailable",
    });
    await expect(acquisitionRecoveryClient.loadEligibility()).resolves.toEqual({
      status: "unavailable",
    });
    await expect(acquisitionRecoveryClient.loadEligibility()).resolves.toEqual({
      status: "signed_out",
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

  it("sends only an opaque queue reference with current CSRF and idempotency proof", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(recoveredQueueItem, 201, { "idempotency-replayed": "false" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      acquisitionRecoveryClient.recoverQueueItem?.(
        { reference: recoveryReference },
        {
          csrfToken,
          idempotencyKey: "queue-recovery-01234567-89ab-cdef-0123-456789abcdef",
        },
      ),
    ).resolves.toEqual({ recovery: recoveredQueueItem, replayed: false });
    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/acquisitions/queue-recoveries");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(new Headers(request?.headers).get("idempotency-key")).toBe(
      "queue-recovery-01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(JSON.parse(String(request?.body))).toEqual({ reference: recoveryReference });
    expect(String(request?.body)).not.toContain("radarr:queue");
  });

  it.each([
    { code: "acquisition_queue_recovery_stale", expected: "stale", status: 409 },
    { code: "acquisition_queue_recovery_reference_invalid", expected: "stale", status: 400 },
    { code: "acquisition_queue_recovery_failed", expected: "stale", status: 409 },
    { code: "acquisition_queue_recovery_pending", expected: "pending", status: 409 },
    {
      code: "acquisition_queue_recovery_unconfirmed",
      expected: "unconfirmed",
      status: 502,
    },
    {
      code: "acquisition_queue_recovery_configuration_unavailable",
      expected: "configuration",
      status: 503,
    },
  ])("maps the queue recovery failure $code", async ({ code, expected, status }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code, message: "Safe recovery message.", requestId: "recovery-error" } },
          status,
        ),
      ),
    );
    await expect(
      acquisitionRecoveryClient.recoverQueueItem?.(
        { reference: recoveryReference },
        { csrfToken, idempotencyKey: "queue-recovery-error-0123456789" },
      ),
    ).rejects.toMatchObject({ kind: expected });
  });

  it.each([
    { code: "session_required", expected: "signed_out", status: 401 },
    { code: "permission_denied", expected: "forbidden", status: 403 },
    { code: "acquisition_search_rate_limited", expected: "rate_limited", status: 429 },
    {
      code: "acquisition_search_response_invalid",
      expected: "invalid_response",
      status: 502,
    },
    {
      code: "acquisition_search_configuration_unavailable",
      expected: "configuration",
      status: 503,
    },
    { code: "acquisition_search_temporarily_unavailable", expected: "unavailable", status: 503 },
    { code: "unexpected_client_error", expected: "invalid_response", status: 409 },
  ])("maps the bounded gateway failure $code", async ({ code, expected, status }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code, message: "Safe public message.", requestId: "search-error" } },
          status,
        ),
      ),
    );

    await expect(
      acquisitionRecoveryClient.queueSearch(
        { mediaId: 42, service: "radarr" },
        {
          csrfToken,
          idempotencyKey: "acquisition-error-0123456789abcdef",
        },
      ),
    ).rejects.toMatchObject({ kind: expected });
  });

  it("redacts transport failures and rejects unreadable error envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("private network detail")));
    let failure: unknown;
    try {
      await acquisitionRecoveryClient.queueSearch(
        { mediaId: 42, service: "radarr" },
        {
          csrfToken,
          idempotencyKey: "acquisition-network-0123456789abcdef",
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "service_unavailable", kind: "unavailable" });
    expect(JSON.stringify(failure)).not.toContain("private network detail");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 503 })),
    );
    await expect(
      acquisitionRecoveryClient.queueSearch(
        { mediaId: 42, service: "radarr" },
        {
          csrfToken,
          idempotencyKey: "acquisition-unreadable-0123456789abcdef",
        },
      ),
    ).rejects.toMatchObject({ code: "request_failed", kind: "unavailable" });
  });

  it("creates a cryptographically random bounded search key", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(createAcquisitionSearchIdempotencyKey()).toBe(
      "acquisition-01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(createAcquisitionQueueRecoveryIdempotencyKey()).toBe(
      "queue-recovery-01234567-89ab-cdef-0123-456789abcdef",
    );
  });

  it("fails safely when the browser cannot create a secure search key", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createAcquisitionSearchIdempotencyKey()).toThrow(
      expect.objectContaining({ code: "secure_random_unavailable", kind: "unavailable" }),
    );
  });
});
