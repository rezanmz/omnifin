import type { RuntimeIdentity } from "@omnifin/contracts/runtime";
import { describe, expect, it, vi } from "vitest";

import { loadRuntimeIdentity } from "./runtime-identity";

const revision = "0123456789abcdef0123456789abcdef01234567";
const stableIdentity: RuntimeIdentity = {
  channel: "stable",
  license: "AGPL-3.0-only",
  revision,
  schemaVersion: 1,
  sourceUrl: `https://github.com/rezanmz/omnifin/tree/${revision}`,
  verification: "verified",
  version: "1.2.3",
};

describe("loadRuntimeIdentity", () => {
  it("loads the bounded public identity without forwarding a session", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json(stableIdentity));

    await expect(
      loadRuntimeIdentity({ fetchImplementation, gatewayUrl: "http://gateway:4000" }),
    ).resolves.toEqual({ identity: stableIdentity, status: "ready" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://gateway:4000/v1/runtime",
      expect.objectContaining({
        cache: "no-store",
        headers: { accept: "application/json" },
        redirect: "error",
      }),
    );
    expect(fetchImplementation.mock.calls[0]?.[1]).not.toHaveProperty("credentials");
  });

  it.each([
    ["a malformed response", "not-json"],
    [
      "a mutable source",
      JSON.stringify({
        ...stableIdentity,
        sourceUrl: "https://github.com/rezanmz/omnifin/tree/main",
      }),
    ],
    ["an unexpected field", JSON.stringify({ ...stableIdentity, internalPath: "/private/data" })],
    ["an oversized response", "x".repeat(4_097)],
  ])("fails closed for %s", async (_label, body) => {
    const fetchImplementation = vi.fn(
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
    );

    await expect(
      loadRuntimeIdentity({ fetchImplementation, gatewayUrl: "http://gateway:4000" }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("rejects a credential-bearing gateway URL without making a request", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      loadRuntimeIdentity({
        fetchImplementation,
        gatewayUrl: "https://user:secret@gateway.example/private",
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
