import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";
import type {
  LibraryArtworkSearchResponse,
  LibraryAttentionResponse,
  LibraryMutationResponse,
} from "@omnifin/contracts/library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { libraryDemoPrincipal } from "./library-care-demo";
import {
  createLibraryIdempotencyKey,
  libraryOperationsClient,
  loadLibraryWorkspace,
} from "./library-operations";
import type { LibraryClientError } from "./library-operations";

const csrfToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const referenceId = `media_${"m".repeat(22)}`;
const searchId = `library_artwork_search_${"s".repeat(22)}`;
const resultId = `library_artwork_result_${"r".repeat(22)}`;
const idempotencyKey = "library-refresh-01234567-89ab-cdef-0123-456789abcdef";
const generatedAt = "2026-07-28T16:00:00.000Z";

const session = { csrfToken, principal: libraryDemoPrincipal };
const attention: LibraryAttentionResponse = {
  generatedAt,
  items: [
    {
      identityState: "identified",
      issues: ["missing_poster"],
      kind: "movie",
      overview: "A quiet test fixture.",
      posterPath: null,
      referenceId,
      title: "Ember Coast",
      year: 2026,
    },
  ],
  nextCursor: null,
  scanned: 1,
  truncated: false,
};
const receipt: LibraryMutationResponse = {
  acceptedAt: generatedAt,
  operationId: `library_operation_${"o".repeat(22)}`,
  referenceId,
  state: "accepted",
};
const artwork: LibraryArtworkSearchResponse = {
  expiresAt: "2026-07-28T16:20:00.000Z",
  generatedAt,
  kind: "poster",
  referenceId,
  results: [
    {
      communityRating: 8.4,
      height: 3000,
      id: resultId,
      language: "English",
      previewPath: `/v1/library/artwork-searches/${searchId}/results/${resultId}/preview`,
      providerName: "TMDB",
      voteCount: 42,
      width: 2000,
    },
  ],
  searchId,
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", ...headers },
      status,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("library operations client", () => {
  it("loads an authorized session before retrieving the normalized attention list", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(session))
      .mockImplementationOnce(() => jsonResponse(attention));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadLibraryWorkspace()).resolves.toMatchObject({
      snapshot: { attention, csrfToken },
      status: "ready",
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/session",
      "/api/library/attention?limit=30",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("distinguishes signed-out, forbidden, and missing Jellyfin control paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({}, 401)),
    );
    await expect(loadLibraryWorkspace()).resolves.toEqual({ status: "signed_out" });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          ...session,
          principal: {
            ...libraryDemoPrincipal,
            permissions: [...ROLE_PERMISSIONS.viewer],
            role: "viewer",
          },
        }),
      ),
    );
    await expect(loadLibraryWorkspace()).resolves.toEqual({ status: "forbidden" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(session))
        .mockImplementationOnce(() =>
          jsonResponse(
            {
              error: {
                code: "library_configuration_unavailable",
                message: "Library operations are temporarily unavailable due to configuration.",
                requestId: "library-client-request",
              },
            },
            503,
          ),
        ),
    );
    await expect(loadLibraryWorkspace()).resolves.toEqual({ status: "not_configured" });
  });

  it("sends whitelisted refresh input with CSRF and an idempotency key", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(receipt, 201, { "idempotency-replayed": "false" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      libraryOperationsClient.refresh(
        referenceId,
        { imageMode: "replace", metadataMode: "missing" },
        { csrfToken, idempotencyKey, signal: controller.signal },
      ),
    ).resolves.toEqual({ receipt, replayed: false });
    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/library/items/${referenceId}/refresh`);
    expect(request).toMatchObject({
      body: '{"imageMode":"replace","metadataMode":"missing"}',
      cache: "no-store",
      credentials: "same-origin",
      method: "POST",
      signal: controller.signal,
    });
    const headers = new Headers(request!.headers);
    expect(headers.get("x-omnifin-csrf")).toBe(csrfToken);
    expect(headers.get("idempotency-key")).toBe(idempotencyKey);
  });

  it("searches and applies artwork using opaque same-origin identifiers", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(artwork, 201))
      .mockImplementationOnce(() => jsonResponse(receipt, 200, { "idempotency-replayed": "true" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      libraryOperationsClient.searchArtwork(
        referenceId,
        { includeAllLanguages: false, kind: "poster" },
        { csrfToken },
      ),
    ).resolves.toEqual(artwork);
    await expect(
      libraryOperationsClient.applyArtwork(searchId, resultId, { csrfToken, idempotencyKey }),
    ).resolves.toEqual({ receipt, replayed: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/library/items/${referenceId}/artwork/search`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/library/artwork-searches/${searchId}/results/${resultId}/apply`,
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/images\.example|providerId/u);
  });

  it("fails closed on extra private fields and maps bounded retry guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() =>
          jsonResponse({
            ...attention,
            items: [{ ...attention.items[0], path: "/private/media" }],
          }),
        )
        .mockImplementationOnce(() =>
          jsonResponse({ apiKey: "must-not-escape" }, 429, { "retry-after": "24" }),
        ),
    );

    await expect(libraryOperationsClient.loadAttention()).rejects.toEqual(
      expect.objectContaining<Partial<LibraryClientError>>({
        code: "invalid_library_response",
        kind: "invalid_response",
      }),
    );
    await expect(libraryOperationsClient.scan({ csrfToken, idempotencyKey })).rejects.toEqual(
      expect.objectContaining<Partial<LibraryClientError>>({
        kind: "rate_limited",
        message: "The library operation could not be completed.",
        retryAfterSeconds: 24,
      }),
    );
  });

  it("creates a contract-safe random operation key", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" });
    expect(createLibraryIdempotencyKey("metadata")).toBe(
      "library-metadata-01234567-89ab-cdef-0123-456789abcdef",
    );
  });
});
