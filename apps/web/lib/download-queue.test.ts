import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoDownloadQueue } from "./download-queue-demo";
import {
  DownloadQueueClientError,
  downloadQueueClient,
  outcomeFromError,
  watchDownloadQueueEvents,
} from "./download-queue";

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

  it("accepts only a strict SSE snapshot bound to its transport cursor", async () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    const stop = watchDownloadQueueEvents({ onSnapshot, onStatus }, (url) => {
      expect(url).toBe("/api/downloads/queue/events");
      return source;
    });
    source.onopen?.(new Event("open"));
    const event = {
      cursor: "download_event_ABCDEFGHIJKLMNOPQRSTUV",
      kind: "snapshot",
      queue: demoDownloadQueue,
    };
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(event),
        lastEventId: event.cursor,
      }),
    );

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(event));
    expect(onStatus).toHaveBeenNthCalledWith(1, "connecting");
    expect(onStatus).toHaveBeenCalledWith("live");
    expect(source.close).not.toHaveBeenCalled();

    stop();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("fails closed to polling when an SSE cursor or payload is untrusted", async () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchDownloadQueueEvents({ onSnapshot, onStatus }, () => source);
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          cursor: "download_event_ABCDEFGHIJKLMNOPQRSTUV",
          kind: "snapshot",
          queue: demoDownloadQueue,
        }),
        lastEventId: "download_event_ZYXWVUTSRQPONMLKJIHGFE",
      }),
    );

    await vi.waitFor(() => expect(source.close).toHaveBeenCalledOnce());
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith("fallback");
  });

  it("rejects an oversized SSE message before parsing it", () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchDownloadQueueEvents({ onSnapshot, onStatus }, () => source);

    source.onmessage?.(
      new MessageEvent("message", {
        data: "x".repeat(512_001),
        lastEventId: "download_event_ABCDEFGHIJKLMNOPQRSTUV",
      }),
    );

    expect(source.close).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith("fallback");
  });

  it("keeps the native reconnect path available after a transient SSE error", () => {
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchDownloadQueueEvents({ onSnapshot: vi.fn(), onStatus }, () => source);

    source.onerror?.(new Event("error"));

    expect(onStatus).toHaveBeenLastCalledWith("fallback");
    expect(source.close).not.toHaveBeenCalled();
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

  it("sends a strict idempotent bulk action and binds every returned target", async () => {
    const item = demoDownloadQueue.items[0]!;
    const target = {
      connectorId: item.connectorId,
      expectedState: "downloading" as const,
      itemId: item.id,
    };
    const response = {
      action: "pause" as const,
      completedAt: demoDownloadQueue.generatedAt,
      operationId: "download_bulk_ABCDEFGHIJKLMNOPQRSTUV",
      replayed: false,
      results: [
        {
          response: {
            action: "pause" as const,
            item: { ...item, etaSeconds: null, rateBytesPerSecond: 0, state: "paused" as const },
            previousState: "downloading" as const,
            replayed: false,
            verifiedAt: demoDownloadQueue.generatedAt,
          },
          status: "succeeded" as const,
          target,
        },
      ],
      state: "complete" as const,
      summary: { failed: 0, requested: 1, succeeded: 1 },
    };
    const fetchMock = vi.fn(() => json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadQueueClient.bulkAct!(
        { action: "pause", targets: [target] },
        { csrfToken: "fixture-csrf", idempotencyKey: "bulk-fixture-key" },
      ),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/downloads/queue/bulk-actions",
      expect.objectContaining({
        headers: expect.objectContaining({
          "idempotency-key": "bulk-fixture-key",
          "x-omnifin-csrf": "fixture-csrf",
        }),
        method: "POST",
      }),
    );
  });

  it("sends one idempotent removal and verifies the preserved-content response", async () => {
    const item = demoDownloadQueue.items[0]!;
    const response = {
      contentDisposition: "preserved" as const,
      item,
      operationId: "download_removal_ABCDEFGHIJKLMNOPQRSTUV",
      removedAt: demoDownloadQueue.generatedAt,
      replayed: false,
    };
    const fetchMock = vi.fn(() => json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadQueueClient.remove!(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        { csrfToken: "fixture-csrf", idempotencyKey: "removal-fixture-key" },
      ),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/downloads/queue/removals",
      expect.objectContaining({
        headers: expect.objectContaining({
          "idempotency-key": "removal-fixture-key",
          "x-omnifin-csrf": "fixture-csrf",
        }),
        method: "POST",
      }),
    );
  });

  it("sends one exact front-of-queue promotion and verifies the position receipt", async () => {
    const item = demoDownloadQueue.items[0]!;
    const response = {
      item,
      position: 0 as const,
      previousPosition: 1,
      promotedAt: demoDownloadQueue.generatedAt,
      replayed: false,
    };
    const fetchMock = vi.fn(() => json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadQueueClient.promote!(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        { csrfToken: "fixture-csrf" },
      ),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/downloads/queue/promotions",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-omnifin-csrf": "fixture-csrf" }),
        method: "POST",
      }),
    );
  });

  it.each([
    [
      "item",
      (item: (typeof demoDownloadQueue.items)[number]) => ({
        ...item,
        id: demoDownloadQueue.items[1]!.id,
      }),
    ],
    [
      "connector",
      (item: (typeof demoDownloadQueue.items)[number]) => ({
        ...item,
        connectorId: demoDownloadQueue.items[1]!.connectorId,
      }),
    ],
  ] as const)("rejects a promotion receipt rebound to a different %s", async (_label, rebind) => {
    const item = demoDownloadQueue.items[0]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({
          item: rebind(item),
          position: 0,
          previousPosition: 1,
          promotedAt: demoDownloadQueue.generatedAt,
          replayed: false,
        }),
      ),
    );

    await expect(
      downloadQueueClient.promote!(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        { csrfToken: "fixture-csrf" },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", kind: "invalid_response" });
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
    [401, "authentication_required", "signed_out"],
    [403, "permission_denied", "forbidden"],
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
