import type {
  SubtitleDownloadResponse,
  SubtitleSearchResponse,
} from "@omnifin/contracts/subtitles";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSubtitleDownloadIdempotencyKey, subtitleClient } from "./subtitles";
import type { SubtitleClientError } from "./subtitles";

const csrfToken = "subtitle_csrf_0123456789abcdefghijklmnopqrstuvwxyz";
const mediaReferenceId = `media_${"m".repeat(22)}`;
const searchId = `subtitle_search_${"s".repeat(22)}`;
const resultId = `subtitle_result_${"r".repeat(22)}`;
const idempotencyKey = "subtitle-download-01234567-89ab-cdef-0123-456789abcdef";

const search: SubtitleSearchResponse = {
  expiresAt: "2026-07-28T12:20:00.000Z",
  generatedAt: "2026-07-28T12:00:00.000Z",
  media: {
    kind: "episode",
    title: "Northern Lights",
    year: 2026,
    seasonNumber: 2,
    episodeNumber: 3,
  },
  results: [
    {
      dontMatches: ["release_group"],
      forced: false,
      hearingImpaired: true,
      id: resultId,
      language: "English",
      matches: ["series", "season", "episode"],
      originalFormat: true,
      provider: "OpenSubtitles.com",
      releaseNames: ["Northern.Lights.S02E03.1080p.WEB-DL"],
      score: 92.4,
      uploader: "Aurora",
    },
  ],
  searchId,
};

const download: SubtitleDownloadResponse = {
  acceptedAt: "2026-07-28T12:02:00.000Z",
  resultId,
  searchId,
  status: "accepted",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("subtitle client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("searches through the opaque media reference with CSRF protection", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(search, 201));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      subtitleClient.search(mediaReferenceId, { csrfToken, signal: controller.signal }),
    ).resolves.toEqual(search);
    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/media/${mediaReferenceId}/subtitles/search`);
    expect(request).toMatchObject({
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      method: "POST",
      signal: controller.signal,
    });
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
  });

  it("downloads only an opaque search result and reports idempotent replay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(download, 200, { "idempotency-replayed": "true" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      subtitleClient.download(searchId, resultId, { csrfToken, idempotencyKey }),
    ).resolves.toEqual({ download, replayed: true });
    const [path, request] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/subtitle-searches/${searchId}/results/${resultId}/download`);
    expect(new Headers(request.headers).get("idempotency-key")).toBe(idempotencyKey);
    expect(new Headers(request.headers).get("x-omnifin-csrf")).toBe(csrfToken);
    expect(request.body).toBe("{}");
  });

  it("maps safe expiry and retry guidance without reflecting malformed bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: "subtitle_search_expired",
                message: "This subtitle search expired. Search again before downloading.",
                requestId: "request-subtitle-01",
              },
            },
            409,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({ apiKey: "must-not-escape" }, 429, { "retry-after": "30" }),
        ),
    );

    await expect(
      subtitleClient.download(searchId, resultId, { csrfToken, idempotencyKey }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubtitleClientError>>({
        code: "subtitle_search_expired",
        kind: "expired",
      }),
    );
    await expect(subtitleClient.search(mediaReferenceId, { csrfToken })).rejects.toEqual(
      expect.objectContaining<Partial<SubtitleClientError>>({
        kind: "rate_limited",
        message: "The subtitle operation could not be completed.",
        retryAfterSeconds: 30,
      }),
    );
  });

  it("fails closed when search or download payloads violate the public contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { ...search, results: [{ ...search.results[0], url: "https://secret.test" }] },
            201,
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ ...download, status: "complete" }, 201)),
    );

    await expect(subtitleClient.search(mediaReferenceId, { csrfToken })).rejects.toEqual(
      expect.objectContaining<Partial<SubtitleClientError>>({
        code: "invalid_subtitle_search_response",
        kind: "invalid_response",
      }),
    );
    await expect(
      subtitleClient.download(searchId, resultId, { csrfToken, idempotencyKey }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubtitleClientError>>({
        code: "invalid_subtitle_download_response",
        kind: "invalid_response",
      }),
    );
  });

  it("preserves cancellation and normalizes an unreachable gateway", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))
        .mockRejectedValueOnce(new TypeError("network secret")),
    );

    await expect(subtitleClient.search(mediaReferenceId, { csrfToken })).rejects.toEqual(
      expect.objectContaining({ name: "AbortError" }),
    );
    await expect(subtitleClient.search(mediaReferenceId, { csrfToken })).rejects.toEqual(
      expect.objectContaining<Partial<SubtitleClientError>>({
        code: "service_unavailable",
        kind: "unavailable",
        message: "The subtitle workbench could not reach the gateway.",
      }),
    );
  });

  it("creates a contract-safe random operation key", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" });
    expect(createSubtitleDownloadIdempotencyKey()).toBe(idempotencyKey);
  });
});
