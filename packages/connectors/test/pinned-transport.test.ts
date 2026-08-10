import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  createPinnedTransportPool,
  createPinnedLookup,
  createPinnedRequestOptions,
  pinnedTransportPoolKey,
  pinnedNodeTransport,
} from "../src/http/pinned-transport.js";

describe("DNS-pinned connector transport", () => {
  it("keeps certificate verification enabled when trusting a connector-specific CA", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
    const options = createPinnedRequestOptions(
      new URL("https://radarr.example.test/api"),
      {
        headers: new Headers(),
        method: "GET",
        signal: new AbortController().signal,
        tlsCaCertificatePem: ca,
        tlsPolicy: "allow_self_signed",
      },
      [{ address: "1.1.1.1", family: 4 }],
    );

    expect(options).toMatchObject({
      ca,
      rejectUnauthorized: true,
    });
  });

  it("isolates protocol, hostname, and complete pin-set identities", () => {
    const pins = [{ address: "1.1.1.1", family: 4 as const }];
    const http = new URL("http://radarr.example.test:8080/api");
    const https = new URL("https://radarr.example.test:8080/api");
    const otherHost = new URL("https://sonarr.example.test:8080/api");

    expect(pinnedTransportPoolKey(http, pins)).not.toBe(pinnedTransportPoolKey(https, pins));
    expect(pinnedTransportPoolKey(https, pins)).not.toBe(pinnedTransportPoolKey(otherHost, pins));
    expect(pinnedTransportPoolKey(https, pins)).not.toBe(
      pinnedTransportPoolKey(https, [{ address: "2606:4700:4700::1111", family: 6 }]),
    );

    const options = createPinnedRequestOptions(
      new URL("https://radarr.example.test/api"),
      {
        headers: new Headers(),
        method: "GET",
        signal: new AbortController().signal,
        tlsPolicy: "strict",
      },
      pins,
    );
    expect(options).toMatchObject({
      hostname: "radarr.example.test",
      servername: "radarr.example.test",
      rejectUnauthorized: true,
    });

    const ipOptions = createPinnedRequestOptions(
      new URL("https://192.0.2.10/api"),
      {
        headers: new Headers(),
        method: "GET",
        signal: new AbortController().signal,
        tlsPolicy: "strict",
      },
      [{ address: "192.0.2.10", family: 4 }],
    );
    expect(ipOptions).toMatchObject({
      hostname: "192.0.2.10",
      servername: "",
      rejectUnauthorized: true,
    });

    const ipv6Options = createPinnedRequestOptions(
      new URL("https://[2001:db8::10]/api"),
      {
        headers: new Headers(),
        method: "GET",
        signal: new AbortController().signal,
        tlsPolicy: "strict",
      },
      [{ address: "2001:db8::10", family: 6 }],
    );
    expect(ipv6Options).toMatchObject({
      hostname: "2001:db8::10",
      servername: "",
      rejectUnauthorized: true,
    });
  });

  it.each([0, -1, -Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxAgents %s before creating a pool",
    (maxAgents) => {
      expect(() =>
        createPinnedTransportPool({
          maxAgents,
          maxFreeSockets: 1,
          maxSockets: 1,
          maxTotalSockets: 1,
        }),
      ).toThrowError("The pinned transport agent cache bound must be a positive safe integer.");
    },
  );

  it("accepts a positive safe maxAgents bound", () => {
    const pool = createPinnedTransportPool({
      maxAgents: 1,
      maxFreeSockets: 1,
      maxSockets: 1,
      maxTotalSockets: 1,
    });
    expect(pool).toHaveProperty("transport");
    pool.close();
  });

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

  it("bounds rotating pin agents, retires idle sockets, and closes the pool", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const connections = () =>
      new Promise<number>((resolve, reject) => {
        server.getConnections((error, count) => (error ? reject(error) : resolve(count)));
      });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
      const pool = createPinnedTransportPool({
        maxAgents: 2,
        maxFreeSockets: 1,
        maxSockets: 1,
        maxTotalSockets: 1,
      });
      const init = {
        headers: new Headers(),
        method: "GET" as const,
        signal: new AbortController().signal,
        tlsPolicy: "strict" as const,
      };

      for (let index = 0; index < 6; index += 1) {
        const response = await pool.transport(
          new URL(`http://connector.invalid:${address.port}/${index}`),
          init,
          [
            { address: "127.0.0.1", family: 4 },
            { address: `127.0.0.${index + 2}`, family: 4 },
          ],
        );
        await response.text();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await connections()).toBeLessThanOrEqual(2);
      }

      pool.close();
      await expect(
        pool.transport(new URL(`http://connector.invalid:${address.port}/closed`), init, [
          { address: "127.0.0.1", family: 4 },
        ]),
      ).rejects.toThrow("closed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await connections()).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
