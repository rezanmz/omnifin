import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";

import { demoSystemStatus, demoSystemStatusPrincipal } from "./system-status-demo";
import { loadSystemStatus, watchSystemStatusEvents } from "./system-status";

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

const session = {
  csrfToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  principal: demoSystemStatusPrincipal,
};

afterEach(() => vi.unstubAllGlobals());

describe("system status client", () => {
  it("accepts one strict same-origin system-status snapshot event", async () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    const event = {
      cursor: "system_event_ABCDEFGHIJKLMNOPQRSTUV",
      kind: "snapshot" as const,
      status: demoSystemStatus,
    };

    const stop = watchSystemStatusEvents({ onSnapshot, onStatus }, (url) => {
      expect(url).toBe("/api/system/status/events");
      return source;
    });
    source.onopen?.(new Event("open"));
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    expect(onStatus).not.toHaveBeenCalledWith("live");
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(event),
        lastEventId: event.cursor,
      }),
    );

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(event));
    expect(onStatus).toHaveBeenNthCalledWith(1, "connecting");
    expect(onStatus).toHaveBeenLastCalledWith("live");
    expect(source.close).not.toHaveBeenCalled();

    stop();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("fails closed to polling for an untrusted cursor or malformed payload", async () => {
    const onSnapshot = vi.fn();
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchSystemStatusEvents({ onSnapshot, onStatus }, () => source);

    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          cursor: "system_event_ABCDEFGHIJKLMNOPQRSTUV",
          kind: "snapshot",
          status: demoSystemStatus,
        }),
        lastEventId: "system_event_ZYXWVUTSRQPONMLKJIHGFE",
      }),
    );

    await vi.waitFor(() => expect(source.close).toHaveBeenCalledOnce());
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith("fallback");
  });

  it("rejects an oversized event before parsing and preserves transient reconnects", () => {
    const onStatus = vi.fn();
    const source = {
      close: vi.fn(),
      onerror: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      onopen: null as ((event: Event) => void) | null,
    };
    watchSystemStatusEvents({ onSnapshot: vi.fn(), onStatus }, () => source);

    source.onerror?.(new Event("error"));
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    expect(source.close).not.toHaveBeenCalled();

    source.onmessage?.(
      new MessageEvent("message", {
        data: "x".repeat(512_001),
        lastEventId: "system_event_ABCDEFGHIJKLMNOPQRSTUV",
      }),
    );
    expect(source.close).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("fallback");
  });

  it("loads operator telemetry through same-origin authenticated requests", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => json(session))
      .mockImplementationOnce(() => json(demoSystemStatus));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSystemStatus()).resolves.toEqual({
      snapshot: { principal: demoSystemStatusPrincipal, status: demoSystemStatus },
      status: "ready",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/session",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/system/status",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("stops before the protected endpoint for viewers", async () => {
    const fetchMock = vi.fn(() =>
      json({
        ...session,
        principal: {
          ...demoSystemStatusPrincipal,
          permissions: [...ROLE_PERMISSIONS.viewer],
          role: "viewer",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSystemStatus()).resolves.toEqual({ status: "forbidden" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a signed-out session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({}, 401)),
    );

    await expect(loadSystemStatus()).resolves.toEqual({ status: "signed_out" });
  });

  it("fails closed when telemetry violates the public contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => json(session))
        .mockImplementationOnce(() => json({ privatePath: "/srv/private/media" })),
    );

    await expect(loadSystemStatus()).resolves.toEqual({ status: "unavailable" });
  });

  it("propagates cancellation to both requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSystemStatus(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
