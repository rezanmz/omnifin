import { afterEach, describe, expect, it, vi } from "vitest";

import { appearanceClient } from "./appearance";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("appearance client", () => {
  it("loads a supported account theme", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ theme: "dark" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appearanceClient.load()).resolves.toEqual({ theme: "dark" });
    expect(fetchMock).toHaveBeenCalledWith("/api/profile/appearance", expect.any(Object));
  });

  it("returns null for unavailable or malformed appearance responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 })),
    );
    await expect(appearanceClient.load()).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ theme: "sepia" })),
    );
    await expect(appearanceClient.load()).resolves.toBeNull();
  });

  it("patches the account theme with the CSRF proof", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ theme: "light" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appearanceClient.update("light", "csrf-token-123")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile/appearance",
      expect.objectContaining({
        body: JSON.stringify({ theme: "light" }),
        headers: expect.objectContaining({ "x-omnifin-csrf": "csrf-token-123" }),
        method: "PATCH",
      }),
    );
  });

  it("reports failed patches as false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    await expect(appearanceClient.update("dark", "csrf-token-123")).resolves.toBe(false);
  });
});
