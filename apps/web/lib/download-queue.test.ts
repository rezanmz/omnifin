import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoDownloadQueue } from "./download-queue-demo";
import { DownloadQueueClientError, downloadQueueClient, outcomeFromError } from "./download-queue";

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("download queue client", () => {
  it("loads one bounded public queue with same-origin credentials", async () => {
    const fetchMock = vi.fn(() => json(demoDownloadQueue));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadQueueClient.load()).resolves.toEqual(demoDownloadQueue);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/downloads/queue",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
  ] as const)("maps HTTP %s to the %s boundary", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({}, status)),
    );

    const error = await downloadQueueClient.load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DownloadQueueClientError);
    expect(error).toMatchObject({ kind });
  });

  it("uses a sanitized API error without trusting an invalid success payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json(
          {
            error: {
              code: "download_queue_configuration_unavailable",
              message: "The download queue configuration is temporarily unavailable.",
              requestId: "download-route-request",
            },
          },
          503,
        ),
      ),
    );
    await expect(downloadQueueClient.load()).rejects.toMatchObject({
      code: "download_queue_configuration_unavailable",
      kind: "unavailable",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ privatePath: "/private/media", secret: "must-not-render" })),
    );
    const invalid = await downloadQueueClient.load().catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({ code: "invalid_response", kind: "invalid_response" });
    expect(JSON.stringify(invalid)).not.toContain("must-not-render");
    expect(JSON.stringify(invalid)).not.toContain("/private/media");
  });

  it("turns a network failure into one stable unavailable state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("private network details"))),
    );

    const error = await downloadQueueClient.load().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "service_unavailable", kind: "unavailable" });
    expect(JSON.stringify(error)).not.toContain("private network details");
  });

  it("preserves request cancellation and forwards the caller signal", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    const fetchMock = vi.fn(() => Promise.reject(abort));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadQueueClient.load(controller.signal)).rejects.toBe(abort);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/downloads/queue",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("uses safe fallback errors for non-server failures and unreadable responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ unrelated: true }, 422)),
    );
    await expect(downloadQueueClient.load()).rejects.toMatchObject({
      code: "request_failed",
      kind: "invalid_response",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("not json", { status: 500 }))),
    );
    await expect(downloadQueueClient.load()).rejects.toMatchObject({
      code: "invalid_response",
      kind: "invalid_response",
    });
  });

  it("maps only authorization client errors to entry boundaries", () => {
    expect(outcomeFromError(new DownloadQueueClientError("forbidden", "denied", "Denied"))).toBe(
      "forbidden",
    );
    expect(outcomeFromError(new DownloadQueueClientError("signed_out", "expired", "Expired"))).toBe(
      "signed_out",
    );
    expect(
      outcomeFromError(new DownloadQueueClientError("invalid_response", "invalid", "Invalid")),
    ).toBe("unavailable");
    expect(outcomeFromError(new Error("private failure"))).toBe("unavailable");
  });

  it("loads CSRF-bound action eligibility without exposing a session to ineligible users", async () => {
    const principal: SessionPrincipal = {
      absoluteExpiresAt: "2026-07-29T03:00:00.000Z",
      accountState: "active",
      authenticationMethod: { kind: "jellyfin" },
      displayName: "Operator",
      externalIdentity: null,
      inactivityExpiresAt: "2026-07-28T04:00:00.000Z",
      issuedAt: "2026-07-28T03:00:00.000Z",
      linkedServices: [
        {
          displayName: "Operator",
          externalUserId: "jellyfin-operator",
          health: "linked",
          id: "jellyfin-link-operator",
          lastVerifiedAt: "2026-07-28T03:00:00.000Z",
          linkedAt: "2026-07-27T03:00:00.000Z",
          service: "jellyfin",
          username: "operator",
        },
      ],
      permissions: [...ROLE_PERMISSIONS.operator],
      role: "operator",
      sessionId: "session-1",
      userId: "operator-user",
    };
    const session = {
      csrfToken: "download_queue_csrf_0123456789abcdefghijklmnopqrstuvwxyz",
      principal,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json(session)),
    );

    await expect(downloadQueueClient.loadEligibility!()).resolves.toMatchObject({
      snapshot: { csrfToken: "download_queue_csrf_0123456789abcdefghijklmnopqrstuvwxyz" },
      status: "ready",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ csrfToken: null, principal: null })),
    );
    await expect(downloadQueueClient.loadEligibility!()).resolves.toEqual({ status: "signed_out" });
  });

  it("sends one strict action with CSRF and validates its exact opaque target", async () => {
    const item = demoDownloadQueue.items[0]!;
    const response = {
      action: "pause" as const,
      item: { ...item, etaSeconds: null, rateBytesPerSecond: 0, state: "paused" as const },
      previousState: item.state,
      replayed: false,
      verifiedAt: demoDownloadQueue.generatedAt,
    };
    const fetchMock = vi.fn(() => json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadQueueClient.act!(
        {
          action: "pause",
          connectorId: item.connectorId,
          expectedState: "downloading",
          itemId: item.id,
        },
        { csrfToken: "fixture-csrf" },
      ),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/downloads/queue/actions",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-omnifin-csrf": "fixture-csrf" }),
        method: "POST",
      }),
    );
  });

  it.each([
    ["a different action", { action: "resume" }],
    ["a different prior state", { previousState: "queued" }],
  ] as const)("rejects an otherwise valid response reporting %s", async (_label, override) => {
    const item = demoDownloadQueue.items[0]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({
          action: "pause",
          item: { ...item, etaSeconds: null, rateBytesPerSecond: 0, state: "paused" },
          previousState: item.state,
          replayed: false,
          verifiedAt: demoDownloadQueue.generatedAt,
          ...override,
        }),
      ),
    );

    await expect(
      downloadQueueClient.act!(
        {
          action: "pause",
          connectorId: item.connectorId,
          expectedState: "downloading",
          itemId: item.id,
        },
        { csrfToken: "fixture-csrf" },
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([
    [409, "download_queue_state_changed", "stale"],
    [429, "download_queue_action_rate_limited", "rate_limited"],
    [503, "download_queue_configuration_unavailable", "configuration"],
    [502, "download_queue_action_unconfirmed", "invalid_response"],
  ] as const)("maps action HTTP %s to %s", async (status, code, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({ error: { code, message: "Safe action message", requestId: "request-1" } }, status),
      ),
    );
    const item = demoDownloadQueue.items[0]!;
    await expect(
      downloadQueueClient.act!(
        {
          action: "pause",
          connectorId: item.connectorId,
          expectedState: "downloading",
          itemId: item.id,
        },
        { csrfToken: "fixture-csrf" },
      ),
    ).rejects.toMatchObject({ code, kind });
  });
});
