import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { manualReleaseOperator, manualReleaseSearch } from "../test/manual-release-fixtures";
import {
  createManualReleaseGrabIdempotencyKey,
  ManualReleaseClientError,
  manualReleaseClient,
} from "./manual-releases";

const csrfToken = "manual_release_csrf_0123456789abcdefghijklmnopqrstuvwxyz";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("manual release client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads only an active acquisition operator", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ csrfToken, principal: manualReleaseOperator }))
        .mockResolvedValueOnce(
          jsonResponse({
            csrfToken,
            principal: {
              ...manualReleaseOperator,
              permissions: ROLE_PERMISSIONS.requester,
              role: "requester",
            },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({}, 401)),
    );

    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({
      snapshot: { csrfToken, principal: manualReleaseOperator },
      status: "ready",
    });
    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({ status: "forbidden" });
    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({ status: "signed_out" });
  });

  it("fails closed for malformed, inactive, missing, and unavailable session state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ csrfToken: "malformed" }))
        .mockResolvedValueOnce(
          jsonResponse({
            csrfToken,
            principal: {
              ...manualReleaseOperator,
              accountState: "pending_link",
              linkedServices: [],
              permissions: ["identities.self.manage", "sessions.self.revoke"],
              role: "viewer",
            },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ csrfToken: null, principal: null }))
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockRejectedValueOnce(new Error("private transport detail")),
    );

    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({ status: "unavailable" });
    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({ status: "forbidden" });
    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({ status: "signed_out" });
    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({ status: "unavailable" });
    await expect(manualReleaseClient.loadEligibility()).resolves.toEqual({ status: "unavailable" });
  });

  it("searches one validated target and accepts only the normalized contract", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(manualReleaseSearch));
    vi.stubGlobal("fetch", fetchMock);

    await expect(manualReleaseClient.search({ mediaId: 42, service: "radarr" })).resolves.toEqual(
      manualReleaseSearch,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/acquisitions/releases?mediaId=42&service=radarr",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("encodes mutually exclusive Sonarr episode and season targets", async () => {
    const episodeResponse = {
      ...manualReleaseSearch,
      target: {
        episodeId: 904,
        kind: "episode" as const,
        mediaId: 77,
        seasonNumber: null,
        service: "sonarr" as const,
      },
    };
    const seasonResponse = {
      ...manualReleaseSearch,
      target: {
        episodeId: null,
        kind: "season" as const,
        mediaId: 77,
        seasonNumber: 2,
        service: "sonarr" as const,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(episodeResponse))
      .mockResolvedValueOnce(jsonResponse(seasonResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      manualReleaseClient.search({ episodeId: 904, mediaId: 77, service: "sonarr" }),
    ).resolves.toEqual(episodeResponse);
    await expect(
      manualReleaseClient.search({ mediaId: 77, seasonNumber: 2, service: "sonarr" }),
    ).resolves.toEqual(seasonResponse);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/acquisitions/releases?mediaId=77&service=sonarr&episodeId=904",
      "/api/acquisitions/releases?mediaId=77&service=sonarr&seasonNumber=2",
    ]);
  });

  it("sends one opaque release reference with CSRF and idempotency protection", async () => {
    const receipt = {
      acceptedAt: "2026-07-27T12:01:00.000Z",
      operationId: "release_grab_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      releaseId: manualReleaseSearch.releases[0]!.id,
      service: "radarr" as const,
      state: "accepted" as const,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(receipt, 200, { "idempotency-replayed": "true" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      manualReleaseClient.grab(
        { overrideRejections: true, releaseId: receipt.releaseId },
        {
          csrfToken,
          idempotencyKey: "manual-grab-01234567-89ab-cdef-0123-456789abcdef",
        },
      ),
    ).resolves.toEqual({ grab: receipt, replayed: true });

    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/acquisitions/releases/grabs");
    if (!request) throw new Error("Expected manual grab request options.");
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(new Headers(request.headers).get("idempotency-key")).toBe(
      "manual-grab-01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(JSON.parse(String(request.body))).toEqual({
      overrideRejections: true,
      releaseId: receipt.releaseId,
    });
  });

  it.each([
    { code: "session_required", expected: "signed_out", status: 401 },
    { code: "permission_denied", expected: "forbidden", status: 403 },
    { code: "manual_release_rate_limited", expected: "rate_limited", status: 429 },
    { code: "idempotency_key_conflict", expected: "conflict", status: 409 },
    { code: "manual_release_grab_outcome_pending", expected: "pending", status: 409 },
    { code: "manual_release_candidate_expired", expected: "expired", status: 409 },
    { code: "manual_release_override_required", expected: "override_required", status: 409 },
    {
      code: "manual_release_download_unavailable",
      expected: "download_unavailable",
      status: 409,
    },
    { code: "manual_release_not_configured", expected: "configuration", status: 503 },
    { code: "unexpected_client_error", expected: "invalid_response", status: 400 },
  ])("maps the bounded gateway failure $code", async ({ code, expected, status }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code, message: "Safe public message.", requestId: "release-error" } },
          status,
        ),
      ),
    );

    await expect(
      manualReleaseClient.grab(
        { overrideRejections: false, releaseId: manualReleaseSearch.releases[0]!.id },
        { csrfToken, idempotencyKey: "manual-grab-error-0123456789abcdef" },
      ),
    ).rejects.toMatchObject({ kind: expected });
  });

  it("rejects malformed success data and redacts transport details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ apiKey: "private" })),
    );
    await expect(
      manualReleaseClient.search({ mediaId: 42, service: "radarr" }),
    ).rejects.toBeInstanceOf(ManualReleaseClientError);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network detail")));
    let failure: unknown;
    try {
      await manualReleaseClient.search({ mediaId: 42, service: "radarr" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "service_unavailable", kind: "unavailable" });
    expect(JSON.stringify(failure)).not.toContain("private network detail");
  });

  it("rejects unreadable success envelopes and preserves explicit cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(
      manualReleaseClient.search({ mediaId: 42, service: "radarr" }),
    ).rejects.toMatchObject({ code: "invalid_response", kind: "invalid_response" });

    const abort = new DOMException("Cancelled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(manualReleaseClient.search({ mediaId: 42, service: "radarr" })).rejects.toBe(
      abort,
    );
    await expect(manualReleaseClient.loadEligibility()).rejects.toBe(abort);
  });

  it("creates a cryptographically random bounded grab key", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" });
    expect(createManualReleaseGrabIdempotencyKey()).toBe(
      "manual-grab-01234567-89ab-cdef-0123-456789abcdef",
    );
  });

  it("fails safely without browser secure randomness", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createManualReleaseGrabIdempotencyKey()).toThrow(
      expect.objectContaining({ code: "secure_random_unavailable", kind: "unavailable" }),
    );
  });
});
