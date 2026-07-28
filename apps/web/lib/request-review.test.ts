import { afterEach, describe, expect, it, vi } from "vitest";

import { readyRequestReviewOutcome } from "./request-review-demo";
import {
  createRequestReviewIdempotencyKey,
  requestReviewClient,
  requestReviewFilterLabel,
  type RequestReviewLoadOutcome,
} from "./request-review";

const ready = readyRequestReviewOutcome as Extract<RequestReviewLoadOutcome, { status: "ready" }>;

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function apiError(code: string, message = "The request failed safely.") {
  return { error: { code, message, requestId: "request-test-1" } };
}

describe("requestReviewClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the local operator session before normalized Seerr requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ csrfToken: ready.snapshot.csrfToken, principal: ready.snapshot.principal }),
      )
      .mockResolvedValueOnce(response(ready.snapshot.page));
    vi.stubGlobal("fetch", fetch);

    await expect(requestReviewClient.load()).resolves.toEqual(ready);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/auth/session");
    expect(fetch.mock.calls[1]?.[0]).toContain("/api/requests/review?");
    expect(fetch.mock.calls[1]?.[0]).toContain("status=pending");
  });

  it("fails closed before listing requests when the role lacks review permission", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      response({
        csrfToken: ready.snapshot.csrfToken,
        principal: { ...ready.snapshot.principal, permissions: ["media.view"] },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(requestReviewClient.load()).resolves.toEqual({ status: "forbidden" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends the CSRF token and idempotency key without leaking either into the URL", async () => {
    const item = ready.snapshot.page.items[0]!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...item, status: "approved" }, 200, { "idempotency-replayed": "false" }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestReviewClient.review(
        item.id,
        { decision: "approve" },
        { csrfToken: ready.snapshot.csrfToken, idempotencyKey: "review-test-12345678" },
      ),
    ).resolves.toMatchObject({ replayed: false, request: { status: "approved" } });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/requests/request%3A184/review");
    expect(String(url)).not.toContain(ready.snapshot.csrfToken);
    expect(init.headers["x-omnifin-csrf"]).toBe(ready.snapshot.csrfToken);
    expect(init.headers["idempotency-key"]).toBe("review-test-12345678");
  });

  it("maps durable-outcome uncertainty to a retryable pending error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        response(
          {
            error: {
              code: "request_review_outcome_pending",
              message: "The outcome is still being determined.",
              requestId: "request-test-1",
            },
          },
          409,
          { "retry-after": "2" },
        ),
      ),
    );

    const item = ready.snapshot.page.items[0]!;
    await expect(
      requestReviewClient.review(
        item.id,
        { decision: "decline" },
        { csrfToken: ready.snapshot.csrfToken, idempotencyKey: "review-test-87654321" },
      ),
    ).rejects.toMatchObject({ kind: "pending", retryAfterSeconds: 2 });
  });

  it("creates namespaced secure decision identifiers", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-4def-8123-456789abcdef" });
    expect(createRequestReviewIdempotencyKey()).toBe("review-01234567-89ab-4def-8123-456789abcdef");
  });

  it.each([
    [401, "authentication_required", "signed_out"],
    [403, "request_review_denied", "forbidden"],
    [404, "request_review_not_found", "not_found"],
    [429, "rate_limited", "rate_limited"],
    [409, "request_review_conflict", "conflict"],
    [409, "idempotency_key_conflict", "conflict"],
    [503, "request_review_configuration_unavailable", "not_configured"],
    [502, "request_review_response_invalid", "invalid_response"],
    [503, "request_review_temporarily_unavailable", "unavailable"],
    [400, "invalid_request", "invalid_response"],
  ] as const)("maps HTTP %s / %s to %s", async (status, code, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(apiError(code), status)));

    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({ code, kind });
  });

  it("uses a safe fallback when an error body is not public-contract shaped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ raw: "upstream" }, 400)));

    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({
      code: "request_review_failed",
      kind: "invalid_response",
      message: "The media request review could not be completed.",
      retryAfterSeconds: null,
    });
  });

  it("uses a safe fallback when an error response is unreadable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("{", {
          headers: { "content-type": "application/json" },
          status: 400,
        }),
      ),
    );

    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({
      code: "request_review_failed",
      kind: "invalid_response",
      message: "The media request review could not be completed.",
    });
  });

  it.each(["later", "-1"])("ignores an invalid Retry-After header value of %s", async (value) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(apiError("invalid_request"), 400, { "retry-after": value }),
        ),
    );

    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({ retryAfterSeconds: null });
  });

  it("rejects unreadable and contract-invalid success responses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{", { headers: { "content-type": "application/json" }, status: 200 }),
      )
      .mockResolvedValueOnce(response({ items: "not-a-page" }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({ code: "invalid_request_review_response" });
  });

  it("preserves aborts and sanitizes other network failures", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Stopped", "AbortError"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1"));
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      requestReviewClient.list({ cursor: null, limit: 20, status: "pending" }),
    ).rejects.toMatchObject({ code: "service_unavailable", kind: "unavailable" });
  });

  it("passes a bounded cursor and abort signal to the review listing", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      response({
        ...ready.snapshot.page,
        nextCursor: null,
        status: "approved",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await requestReviewClient.list(
      { cursor: "requests:20", limit: 10, status: "approved" },
      controller.signal,
    );

    expect(fetch.mock.calls[0]?.[0]).toContain("cursor=requests%3A20");
    expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it.each([
    [401, "signed_out"],
    [500, "unavailable"],
  ] as const)("maps session HTTP %s to %s", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({}, status)));
    await expect(requestReviewClient.load()).resolves.toEqual({ status: expected });
  });

  it("rejects invalid and anonymous session payloads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ csrfToken: "bad" }))
      .mockResolvedValueOnce(response({ csrfToken: null, principal: null }));
    vi.stubGlobal("fetch", fetch);

    await expect(requestReviewClient.load()).resolves.toEqual({ status: "unavailable" });
    await expect(requestReviewClient.load()).resolves.toEqual({ status: "signed_out" });
  });

  it.each([
    [403, "request_review_denied", "forbidden"],
    [401, "authentication_required", "signed_out"],
    [503, "request_review_configuration_unavailable", "not_configured"],
    [503, "request_review_temporarily_unavailable", "unavailable"],
  ] as const)(
    "fails the workspace closed when listing returns %s",
    async (status, code, expected) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response({ csrfToken: ready.snapshot.csrfToken, principal: ready.snapshot.principal }),
        )
        .mockResolvedValueOnce(response(apiError(code), status));
      vi.stubGlobal("fetch", fetch);

      await expect(requestReviewClient.load()).resolves.toEqual({ status: expected });
    },
  );

  it("rethrows a cancelled workspace load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new DOMException("Stopped", "AbortError")),
    );
    await expect(requestReviewClient.load(new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("fails the workspace closed on an unexpected network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Network request failed")));

    await expect(requestReviewClient.load()).resolves.toEqual({ status: "unavailable" });
  });

  it("rejects an idempotency operation when secure randomness is unavailable", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createRequestReviewIdempotencyKey()).toThrowError(
      expect.objectContaining({ code: "secure_random_unavailable", kind: "unavailable" }),
    );
  });

  it("reports replayed decisions and forwards cancellation", async () => {
    const item = ready.snapshot.page.items[0]!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...item, status: "declined" }, 200, { "idempotency-replayed": "true" }),
      );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await expect(
      requestReviewClient.review(
        item.id,
        { decision: "decline" },
        {
          csrfToken: ready.snapshot.csrfToken,
          idempotencyKey: "review-test-abcdefgh",
          signal: controller.signal,
        },
      ),
    ).resolves.toMatchObject({ replayed: true, request: { status: "declined" } });
    expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it("labels every supported review filter", () => {
    expect(requestReviewFilterLabel("pending")).toBe("Awaiting review");
    expect(requestReviewFilterLabel("approved")).toBe("Approved");
    expect(requestReviewFilterLabel("declined")).toBe("Declined");
    expect(requestReviewFilterLabel("all")).toBe("All requests");
  });
});
