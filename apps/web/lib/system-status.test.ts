import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_PERMISSIONS } from "@omnifin/contracts/auth";

import { demoSystemStatus, demoSystemStatusPrincipal } from "./system-status-demo";
import { loadSystemStatus } from "./system-status";

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
