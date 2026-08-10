import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { ConnectorHttpLane } from "../src/http/connector-http-lane.js";
import { SafeHttpClient } from "../src/http/safe-http-client.js";
import type { ConnectorTransport } from "../src/types.js";
import { publicResolver } from "./helpers/mock-fetch.js";

function laneClient(
  lane: ConnectorHttpLane,
  transport: ConnectorTransport,
  resolveHost = publicResolver,
  timeoutMs?: number,
) {
  return new SafeHttpClient({
    service: "radarr",
    baseUrl: "https://radarr.example.test/",
    lane,
    transport,
    resolveHost,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("ConnectorHttpLane", () => {
  it("admits FIFO work within active and queue bounds", async () => {
    const lane = new ConnectorHttpLane({ service: "radarr", maxActive: 1, maxQueued: 2 });
    const first = await lane.acquire({ operation: "first" });
    const second = lane.acquire({ operation: "second" });
    const third = lane.acquire({ operation: "third" });

    await expect(lane.acquire({ operation: "overflow" })).rejects.toMatchObject({
      code: "unreachable",
      message: "radarr could not be reached.",
    });
    first.release();
    const admittedSecond = await second;
    admittedSecond.release();
    const admittedThird = await third;
    admittedThird.release();
    lane.close();
  });

  it("rejects a client whose lane belongs to another connector service without lane details", () => {
    const lane = new ConnectorHttpLane({ service: "sonarr" });
    let failure: unknown;

    try {
      new SafeHttpClient({
        service: "radarr",
        baseUrl: "https://radarr.example.test/",
        lane,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "configuration_invalid",
      service: "radarr",
      operation: "configuration",
      message: "The connector HTTP lane is not configured for this service.",
    });
    expect(JSON.stringify(failure)).not.toContain("sonarr");
    lane.close();
  });

  it("does not resolve DNS or call transport for queued aborts", async () => {
    const lane = new ConnectorHttpLane({ service: "radarr", maxActive: 1, maxQueued: 2 });
    const held = await lane.acquire({ operation: "held" });
    const resolveHost = vi.fn(publicResolver);
    const transport = vi.fn<ConnectorTransport>(async () => new Response("ok"));
    const controller = new AbortController();
    const request = laneClient(lane, transport, resolveHost).requestText("api/status", {
      operation: "queued",
      signal: controller.signal,
    });

    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "unreachable" });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();

    const timedOut = laneClient(lane, transport, resolveHost, 2).requestText("api/timeout", {
      operation: "queued.timeout",
    });
    await expect(timedOut).rejects.toMatchObject({ code: "timeout" });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    held.release();
    lane.close();
  });

  it("releases permits after buffered, stream, and transport-error outcomes", async () => {
    const lane = new ConnectorHttpLane({ service: "radarr", maxActive: 1, maxQueued: 2 });
    let call = 0;
    const transport: ConnectorTransport = async (_url, init) => {
      call += 1;
      if (call === 1) return new Response("buffered");
      if (call === 2) return new Response("streamed");
      if (call === 3) throw new Error("private transport detail");
      init.signal.throwIfAborted();
      return new Response("after-error");
    };
    const client = laneClient(lane, transport);

    await expect(
      client.requestText("api/buffered", { operation: "buffered" }),
    ).resolves.toMatchObject({
      body: "buffered",
    });
    const stream = await client.requestStream("api/stream", { operation: "stream" }, 100);
    await expect(new Response(stream.body).text()).resolves.toBe("streamed");
    await expect(client.requestText("api/error", { operation: "error" })).rejects.toMatchObject({
      code: "unreachable",
    });
    await expect(
      client.requestText("api/after-error", { operation: "after-error" }),
    ).resolves.toMatchObject({
      body: "after-error",
    });
    lane.close();
  });

  it("cancels an unread post-header stream on caller abort before admitting queued work", async () => {
    const lane = new ConnectorHttpLane({ service: "radarr", maxActive: 1, maxQueued: 1 });
    const abort = new AbortController();
    let cancelUpstream: (() => void) | undefined;
    const upstreamCancelled = new Promise<void>((resolve) => {
      cancelUpstream = resolve;
    });
    let calls = 0;
    const transport: ConnectorTransport = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => cancelUpstream?.(),
          }),
        );
      }
      return new Response("admitted");
    };
    const client = laneClient(lane, transport);
    const stream = await client.requestStream(
      "api/stream",
      { operation: "stream", signal: abort.signal },
      100,
    );
    let queuedSettled = false;
    const queued = client.requestText("api/queued", { operation: "queued" }).finally(() => {
      queuedSettled = true;
    });

    await Promise.resolve();
    expect(queuedSettled).toBe(false);
    abort.abort();
    await upstreamCancelled;
    await expect(stream.body.getReader().read()).rejects.toMatchObject({
      code: "unreachable",
      operation: "stream",
    });
    await expect(queued).resolves.toMatchObject({ body: "admitted" });
    expect(calls).toBe(2);
    lane.close();
  });

  it("keeps a post-header stream permit occupied until the exposed body is canceled", async () => {
    const lane = new ConnectorHttpLane({ service: "radarr", maxActive: 1, maxQueued: 1 });
    let cancelUpstream: (() => void) | undefined;
    const upstreamCancelled = new Promise<void>((resolve) => {
      cancelUpstream = resolve;
    });
    let calls = 0;
    const transport: ConnectorTransport = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => cancelUpstream?.(),
          }),
        );
      }
      return new Response("admitted");
    };
    const client = laneClient(lane, transport);
    const stream = await client.requestStream("api/stream", { operation: "stream" }, 100);
    const queued = client.requestText("api/queued", { operation: "queued" });

    await Promise.resolve();
    expect(calls).toBe(1);
    await stream.body.cancel("caller stopped reading");
    await upstreamCancelled;
    await expect(queued).resolves.toMatchObject({ body: "admitted" });
    expect(calls).toBe(2);
    lane.close();
  });

  it("keeps same-pin sockets reusable and isolates changed pin sets", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    let connections = 0;
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
      const lane = new ConnectorHttpLane({
        service: "radarr",
        keepAlive: true,
        maxSockets: 2,
        maxTotalSockets: 2,
        maxFreeSockets: 1,
      });
      const first = await lane.transport(
        new URL(`http://connector.invalid:${address.port}/one`),
        {
          method: "GET",
          headers: new Headers(),
          tlsPolicy: "strict",
          signal: new AbortController().signal,
        },
        [{ address: "127.0.0.1", family: 4 }],
      );
      await first.text();
      const second = await lane.transport(
        new URL(`http://connector.invalid:${address.port}/two`),
        {
          method: "GET",
          headers: new Headers(),
          tlsPolicy: "strict",
          signal: new AbortController().signal,
        },
        [{ address: "127.0.0.1", family: 4 }],
      );
      await second.text();
      expect(connections).toBe(1);

      const changedPin = await lane.transport(
        new URL(`http://connector.invalid:${address.port}/three`),
        {
          method: "GET",
          headers: new Headers(),
          tlsPolicy: "strict",
          signal: new AbortController().signal,
        },
        [{ address: "::1", family: 6 }],
      );
      await changedPin.text();
      expect(connections).toBe(2);
      lane.close();
      lane.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("closes queued and active work without exposing target details", async () => {
    const lane = new ConnectorHttpLane({ service: "radarr", maxActive: 1, maxQueued: 1 });
    const transport: ConnectorTransport = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          {
            once: true,
          },
        );
      });
    const client = laneClient(lane, transport);
    const active = client.requestText("api/active", { operation: "active" });
    const queued = client.requestText("api/queued", { operation: "queued" });

    lane.close();
    await expect(active).rejects.toMatchObject({ code: "unreachable" });
    await expect(queued).rejects.toMatchObject({ code: "unreachable" });
    expect(JSON.stringify(await active.catch((error: unknown) => error))).not.toContain(
      "radarr.example.test",
    );
  });
});
