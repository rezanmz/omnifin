import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createPinnedLookup, pinnedNodeTransport } from "../src/http/pinned-transport.js";

describe("DNS-pinned connector transport", () => {
  it("returns only the addresses that passed destination validation", () => {
    const lookup = createPinnedLookup("radarr.example.test", [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const callback = vi.fn();

    lookup("radarr.example.test", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("does not fall back to DNS for an unexpected hostname", () => {
    const lookup = createPinnedLookup("radarr.example.test", [{ address: "1.1.1.1", family: 4 }]);
    const callback = vi.fn();

    lookup("metadata.google.internal", { all: false }, callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ code: "ENOTFOUND" });
  });

  it("fails closed when a requested address family was not validated", () => {
    const lookup = createPinnedLookup("radarr.example.test", [{ address: "1.1.1.1", family: 4 }]);
    const callback = vi.fn();

    lookup("radarr.example.test", { all: false, family: 6 }, callback);

    expect(callback.mock.calls[0]?.[0]).toMatchObject({ code: "ENOTFOUND" });
  });

  it("connects to a validated address without resolving the configured hostname again", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ host: request.headers.host }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
      const response = await pinnedNodeTransport(
        new URL(`http://connector.invalid:${address.port}/health`),
        {
          method: "GET",
          headers: new Headers(),
          tlsPolicy: "strict",
          signal: new AbortController().signal,
        },
        [{ address: "127.0.0.1", family: 4 }],
      );

      await expect(response.json()).resolves.toEqual({
        host: `connector.invalid:${address.port}`,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
