import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { MediaRequestResponse } from "@omnifin/contracts/requests";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MediaRequestClientError,
  createMediaRequestIdempotencyKey,
  mediaRequestClient,
} from "./media-requests";

const csrfToken = "media_request_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-28T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Mina",
  externalIdentity: {
    displayClaims: { displayName: "Mina" },
    issuer: "https://auth.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "mina-subject",
  },
  inactivityExpiresAt: "2026-07-27T14:00:00.000Z",
  issuedAt: "2026-07-27T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Mina Jellyfin",
      externalUserId: "jellyfin-mina",
      health: "linked",
      id: "jellyfin-link-mina",
      lastVerifiedAt: "2026-07-27T12:00:00.000Z",
      linkedAt: "2026-07-26T12:00:00.000Z",
      service: "jellyfin",
      username: "mina",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.requester],
  role: "requester",
  sessionId: "session-mina",
  userId: "user-mina",
};
const createdRequest: MediaRequestResponse = {
  createdAt: "2026-07-27T12:01:00.000Z",
  id: "request:42",
  is4k: true,
  kind: "series",
  seasons: [1, 2],
  source: "seerr",
  status: "pending",
  tmdbId: 1396,
};

function routingReference(name: string) {
  return `routing-v1.v2.${name}.${"g".repeat(32)}.${"h".repeat(32)}`;
}

const routingOptions = {
  destinations: [
    {
      id: routingReference("radarr-primary"),
      isDefault: true,
      label: "Cinema primary",
      languageProfiles: [],
      qualityProfiles: [
        { id: routingReference("quality-balanced"), isDefault: true, label: "Balanced" },
      ],
      rootFolders: [
        {
          availableBytes: 800_000_000_000,
          capacityBytes: 2_000_000_000_000,
          id: routingReference("root-cinema"),
          isDefault: true,
          label: "Cinema",
        },
      ],
      service: "radarr",
    },
  ],
  expiresAt: "2026-07-27T12:15:00.000Z",
  failures: [],
  generatedAt: "2026-07-27T12:00:00.000Z",
  is4k: false,
  kind: "movie",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("media request client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a request-capable session with its exact Jellyfin link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ csrfToken, principal })),
    );

    await expect(mediaRequestClient.loadEligibility()).resolves.toMatchObject({
      snapshot: {
        csrfToken,
        jellyfinDisplayName: "Mina Jellyfin",
        jellyfinHealth: "linked",
        principal,
      },
      status: "ready",
    });
  });

  it("stops signed-out, unprivileged, and unpaired sessions before mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: null, principal: null }))
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken,
          principal: { ...principal, permissions: ROLE_PERMISSIONS.viewer, role: "viewer" },
        }),
      )
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

    await expect(mediaRequestClient.loadEligibility()).resolves.toEqual({ status: "signed_out" });
    await expect(mediaRequestClient.loadEligibility()).resolves.toEqual({ status: "forbidden" });
    await expect(mediaRequestClient.loadEligibility()).resolves.toEqual({
      status: "link_required",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("loads only normalized, opaque request routing choices", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(routingOptions),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(mediaRequestClient.loadRoutingOptions("movie", false)).resolves.toEqual(
      routingOptions,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/requests/routing-options?is4k=false&kind=movie",
    );
    expect(JSON.stringify(routingOptions)).not.toContain("/srv/");
  });

  it("rejects malformed routing choices and maps expired references", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ rootFolder: "/srv/private" })),
    );
    await expect(mediaRequestClient.loadRoutingOptions("movie", false)).rejects.toMatchObject({
      code: "invalid_response",
      kind: "invalid_response",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "request_routing_invalid",
              message: "Request routing choices are no longer valid.",
              requestId: "routing-error",
            },
          },
          409,
        ),
      ),
    );
    await expect(
      mediaRequestClient.create(
        { is4k: false, kind: "movie", tmdbId: 603 },
        { csrfToken, idempotencyKey: "media-fedcba98-7654-3210-fedc-ba9876543210" },
      ),
    ).rejects.toMatchObject({
      code: "request_routing_invalid",
      kind: "routing",
      retryMode: "new_key",
    });
  });

  it("sends a validated, CSRF-bound, idempotent request and reads replay state", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(createdRequest, 200, { "idempotency-replayed": "true" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mediaRequestClient.create(
        { is4k: true, kind: "series", seasons: [1, 2], tmdbId: 1396 },
        { csrfToken, idempotencyKey: "media-01234567-89ab-cdef-0123-456789abcdef" },
      ),
    ).resolves.toEqual({ replayed: true, request: createdRequest });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, request] = fetchMock.mock.calls[0]!;
    if (!request) throw new Error("Expected a request init.");
    expect(path).toBe("/api/requests");
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(new Headers(request.headers).get("idempotency-key")).toBe(
      "media-01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(JSON.parse(String(request.body))).toEqual({
      is4k: true,
      kind: "series",
      seasons: [1, 2],
      tmdbId: 1396,
    });
  });

  it("distinguishes ambiguous network retries from known failed attempts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("private network details")));
    await expect(
      mediaRequestClient.create(
        { is4k: false, kind: "movie", tmdbId: 603 },
        { csrfToken, idempotencyKey: "media-01234567-89ab-cdef-0123-456789abcdef" },
      ),
    ).rejects.toMatchObject({
      code: "service_unavailable",
      kind: "unavailable",
      retryMode: "same_key",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "request_temporarily_unavailable",
              message: "Media requests are temporarily unavailable.",
              requestId: "request-error",
            },
          },
          503,
        ),
      ),
    );
    await expect(
      mediaRequestClient.create(
        { is4k: false, kind: "movie", tmdbId: 603 },
        { csrfToken, idempotencyKey: "media-abcdef01-2345-6789-abcd-ef0123456789" },
      ),
    ).rejects.toMatchObject({
      code: "request_temporarily_unavailable",
      kind: "unavailable",
      retryMode: "new_key",
    });
  });

  it("rejects malformed success responses and creates contract-safe keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ secret: "must-not-pass" }, 201)),
    );
    await expect(
      mediaRequestClient.create(
        { is4k: false, kind: "movie", tmdbId: 603 },
        { csrfToken, idempotencyKey: "media-01234567-89ab-cdef-0123-456789abcdef" },
      ),
    ).rejects.toBeInstanceOf(MediaRequestClientError);
    expect(createMediaRequestIdempotencyKey()).toMatch(
      /^media-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });
});
