import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SafeConnectorError, SafeHttpClient } from "../src/http/safe-http-client.js";
import type { ConnectorTransport } from "../src/types.js";
import { createMockTransport, jsonResponse, publicResolver } from "./helpers/mock-fetch.js";

function clientWith(transport: ConnectorTransport, overrides: Record<string, unknown> = {}) {
  return new SafeHttpClient({
    service: "radarr",
    baseUrl: "https://radarr.example.test/",
    transport,
    resolveHost: publicResolver,
    ...overrides,
  });
}

describe("SafeHttpClient", () => {
  it("rejects limits that could disable deadline or response-size protection", () => {
    const mock = createMockTransport([]);

    expect(() => clientWith(mock.transport, { timeoutMs: Number.POSITIVE_INFINITY })).toThrowError(
      expect.objectContaining({ code: "configuration_invalid" }),
    );
    expect(() =>
      clientWith(mock.transport, { maxResponseBytes: Number.POSITIVE_INFINITY }),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });

  it("validates a bounded JSON response against an explicit schema", async () => {
    const mock = createMockTransport([jsonResponse({ version: "6.0.0", secret: "stripped" })]);
    const client = clientWith(mock.transport);

    const result = await client.requestJson(
      "api/v3/system/status",
      z.object({ version: z.string() }),
      { operation: "probe" },
    );

    expect(result).toEqual({ version: "6.0.0" });
    expect(mock.requests[0]?.pinnedAddresses).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });

  it("never includes an upstream body, URL, or credential in a public error", async () => {
    const upstreamSecret = "api-key-super-secret";
    const mock = createMockTransport([
      new Response(`Failed request for https://radarr.example.test/?apikey=${upstreamSecret}`, {
        status: 401,
      }),
    ]);
    const client = clientWith(mock.transport, { headers: { "X-Api-Key": upstreamSecret } });

    let failure: unknown;
    try {
      await client.requestText("api/v3/system/status", { operation: "probe" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SafeConnectorError);
    const serialized = JSON.stringify(failure);
    expect(String((failure as Error).message)).not.toContain(upstreamSecret);
    expect(serialized).not.toContain(upstreamSecret);
    expect(serialized).not.toContain("radarr.example.test");
    expect(failure).toMatchObject({ code: "invalid_credentials", retryable: false });
  });

  it("preserves bounded Retry-After guidance on a temporarily unavailable response", async () => {
    const mock = createMockTransport([
      new Response("", { status: 503, headers: { "retry-after": "120" } }),
    ]);
    const client = clientWith(mock.transport);

    await expect(
      client.requestText("api/v3/system/status", { operation: "probe" }),
    ).rejects.toMatchObject({
      code: "upstream_error",
      retryable: true,
      retryAfterSeconds: 120,
      status: 503,
    });
  });

  it("blocks upstream redirects instead of following a new destination", async () => {
    const mock = createMockTransport([
      new Response("", { status: 302, headers: { location: "https://metadata.google.internal/" } }),
    ]);
    const client = clientWith(mock.transport);

    await expect(
      client.requestText("api/v3/system/status", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "destination_blocked", status: 302 });
  });

  it("rejects absolute and origin-relative request paths", async () => {
    const mock = createMockTransport([]);
    const client = clientWith(mock.transport);

    await expect(
      client.requestText("https://metadata.google.internal/latest", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(
      client.requestText("/api/v3/system/status", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(
      client.requestText("api/v3/../admin", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(
      client.requestText("api/v3/%2e%2e/admin", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "destination_blocked" });
    expect(mock.requests).toHaveLength(0);
  });

  it("blocks hop-by-hop and host header overrides", async () => {
    const mock = createMockTransport([]);
    const client = clientWith(mock.transport);

    await expect(
      client.requestText("api/v3/system/status", {
        operation: "probe",
        headers: { Host: "metadata.google.internal" },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects responses that exceed the configured size limit", async () => {
    const mock = createMockTransport([new Response("123456789")]);
    const client = clientWith(mock.transport, { maxResponseBytes: 8 });

    await expect(
      client.requestText("api/v3/system/status", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("turns a deadline into a retryable, redaction-safe timeout", async () => {
    const hangingTransport: ConnectorTransport = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const client = clientWith(hangingTransport, { timeoutMs: 2 });

    await expect(
      client.requestText("api/v3/system/status", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("keeps the deadline active while consuming a slow response body", async () => {
    const slowBodyTransport: ConnectorTransport = async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(stream);
    };
    const client = clientWith(slowBodyTransport, { timeoutMs: 2 });

    await expect(
      client.requestText("api/v3/system/status", { operation: "probe" }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });
});
