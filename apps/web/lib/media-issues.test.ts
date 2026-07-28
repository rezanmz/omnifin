import { afterEach, describe, expect, it, vi } from "vitest";

import { readyMediaIssueOutcome } from "./media-issues-demo";
import {
  createMediaIssueIdempotencyKey,
  mediaIssueClient,
  type MediaIssueLoadOutcome,
} from "./media-issues";

const ready = readyMediaIssueOutcome as Extract<MediaIssueLoadOutcome, { status: "ready" }>;

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function apiError(code: string, message = "The issue operation failed safely.") {
  return { error: { code, message, requestId: "issue-test-1" } };
}

describe("mediaIssueClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the operator session before the normalized issue queue", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ csrfToken: ready.snapshot.csrfToken, principal: ready.snapshot.principal }),
      )
      .mockResolvedValueOnce(response({ ...ready.snapshot.page, status: "open" }));
    vi.stubGlobal("fetch", fetch);

    await expect(mediaIssueClient.load()).resolves.toMatchObject({ status: "ready" });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/auth/session");
    expect(fetch.mock.calls[1]?.[0]).toContain("/api/issues?");
    expect(fetch.mock.calls[1]?.[0]).toContain("source=all");
    expect(fetch.mock.calls[1]?.[0]).toContain("status=open");
  });

  it.each([
    [401, "signed_out"],
    [500, "unavailable"],
  ] as const)("maps an HTTP %s session boundary to %s", async (status, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(response(apiError("session_failed"), status)),
    );

    await expect(mediaIssueClient.load()).resolves.toEqual({ status: expected });
  });

  it("fails safely for invalid and anonymous session contracts", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ principal: "private-session" }))
      .mockResolvedValueOnce(response({ csrfToken: null, principal: null }));
    vi.stubGlobal("fetch", fetch);

    await expect(mediaIssueClient.load()).resolves.toEqual({ status: "unavailable" });
    await expect(mediaIssueClient.load()).resolves.toEqual({ status: "signed_out" });
  });

  it("fails closed before listing when the role lacks issue management", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      response({
        csrfToken: ready.snapshot.csrfToken,
        principal: { ...ready.snapshot.principal, permissions: ["media.view"] },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(mediaIssueClient.load()).resolves.toEqual({ status: "forbidden" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [403, "permission_denied", "forbidden"],
    [401, "authentication_required", "signed_out"],
    [503, "media_issue_temporarily_unavailable", "unavailable"],
  ] as const)("maps list failure %s / %s during load to %s", async (status, code, expected) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ csrfToken: ready.snapshot.csrfToken, principal: ready.snapshot.principal }),
      )
      .mockResolvedValueOnce(response(apiError(code), status));
    vi.stubGlobal("fetch", fetch);

    await expect(mediaIssueClient.load()).resolves.toEqual({ status: expected });
  });

  it("preserves a cancelled session load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new DOMException("Stopped", "AbortError")),
    );

    await expect(mediaIssueClient.load(new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("sends only an opaque issue reference with CSRF and idempotency headers", async () => {
    const issue = ready.snapshot.page.items[0]!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...issue, status: "resolved" }, 200, { "idempotency-replayed": "false" }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      mediaIssueClient.updateStatus(
        issue.id,
        { status: "resolved" },
        {
          csrfToken: ready.snapshot.csrfToken,
          idempotencyKey: "issue-status-test-12345678",
        },
      ),
    ).resolves.toMatchObject({ issue: { status: "resolved" }, replayed: false });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`/api/issues/${issue.id}/status`);
    expect(String(url)).not.toContain(ready.snapshot.csrfToken);
    expect(init.body).toBe(JSON.stringify({ status: "resolved" }));
    expect(init.headers["x-omnifin-csrf"]).toBe(ready.snapshot.csrfToken);
    expect(init.headers["idempotency-key"]).toBe("issue-status-test-12345678");
  });

  it("recognizes a replayed decision and forwards cancellation", async () => {
    const issue = ready.snapshot.page.items[0]!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...issue, status: "resolved" }, 200, { "idempotency-replayed": "true" }),
      );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await expect(
      mediaIssueClient.updateStatus(
        issue.id,
        { status: "resolved" },
        {
          csrfToken: ready.snapshot.csrfToken,
          idempotencyKey: "issue-status-test-12345678",
          signal: controller.signal,
        },
      ),
    ).resolves.toMatchObject({ replayed: true });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it.each([
    [401, "authentication_required", "signed_out"],
    [403, "permission_denied", "forbidden"],
    [404, "media_issue_not_found", "not_found"],
    [409, "media_issue_conflict", "conflict"],
    [409, "idempotency_key_conflict", "conflict"],
    [409, "media_issue_outcome_pending", "pending"],
    [429, "rate_limited", "rate_limited"],
    [502, "media_issue_response_invalid", "invalid_response"],
    [503, "media_issue_temporarily_unavailable", "unavailable"],
  ] as const)("maps HTTP %s / %s to %s", async (status, code, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(apiError(code), status)));

    await expect(
      mediaIssueClient.list({ limit: 20, source: "all", status: "open" }),
    ).rejects.toMatchObject({ code, kind });
  });

  it("preserves cancellation and sanitizes network failures", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Stopped", "AbortError"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1"));
    vi.stubGlobal("fetch", fetch);

    await expect(
      mediaIssueClient.list({ limit: 20, source: "all", status: "open" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      mediaIssueClient.list({ limit: 20, source: "all", status: "open" }),
    ).rejects.toMatchObject({ code: "service_unavailable", kind: "unavailable" });
  });

  it("rejects unreadable and contract-invalid success payloads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(response({ items: "private-upstream-payload" }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      mediaIssueClient.list({ limit: 20, source: "all", status: "open" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      mediaIssueClient.list({ limit: 20, source: "all", status: "open" }),
    ).rejects.toMatchObject({ code: "invalid_media_issue_response" });
  });

  it("uses safe fallback errors and accepts only numeric retry delays", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("not-json", { headers: { "retry-after": "9" }, status: 418 }),
      )
      .mockResolvedValueOnce(
        response(apiError("media_issue_temporarily_unavailable"), 503, {
          "retry-after": "later",
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      mediaIssueClient.list({ limit: 20, source: "all", status: "open" }),
    ).rejects.toMatchObject({
      code: "media_issue_operation_failed",
      kind: "invalid_response",
      retryAfterSeconds: 9,
    });
    await expect(
      mediaIssueClient.list({ limit: 20, source: "all", status: "open" }),
    ).rejects.toMatchObject({ retryAfterSeconds: null });
  });

  it("creates a namespaced secure decision identifier", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-4def-8123-456789abcdef" });
    expect(createMediaIssueIdempotencyKey()).toBe(
      "issue-status-01234567-89ab-4def-8123-456789abcdef",
    );
  });

  it("fails safely when secure randomness is unavailable", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createMediaIssueIdempotencyKey()).toThrowError(
      expect.objectContaining({ code: "secure_random_unavailable", kind: "unavailable" }),
    );
  });
});
