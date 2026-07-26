import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayProxy,
  proxyGatewayRequest,
  resolveGatewayEndpoint,
  selectTrustedClientAddress,
} from "./gateway-proxy";

function requestFixture({
  body,
  headers = {},
  method = "GET",
  path = "/api/auth/providers",
  signal = new AbortController().signal,
}: {
  body?: string;
  headers?: HeadersInit;
  method?: string;
  path?: string;
  signal?: AbortSignal;
} = {}) {
  return {
    body: body === undefined ? null : new Response(body).body,
    headers: new Headers(headers),
    method,
    nextUrl: new URL(path, "http://127.0.0.1:3000"),
    signal,
  } as unknown as NextRequest;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("gateway proxy target resolution", () => {
  it("preserves a contained API path and its exact query", () => {
    expect(
      resolveGatewayEndpoint({
        gatewayUrl: "https://gateway.example.test",
        pathname: "/api/auth/oidc/provider/callback",
        search: "?code=opaque&state=bound",
      }).href,
    ).toBe("https://gateway.example.test/v1/auth/oidc/provider/callback?code=opaque&state=bound");
  });

  it("rejects encoded dot segments that normalize outside the v1 gateway prefix", () => {
    expect(() =>
      resolveGatewayEndpoint({
        gatewayUrl: "http://127.0.0.1:4000",
        pathname: "/api/%2e%2e/readyz",
        search: "",
      }),
    ).toThrow(/outside the gateway API prefix/i);
  });

  it.each([
    ["ftp://127.0.0.1:4000", "/api/auth/providers"],
    ["http://user:secret@127.0.0.1:4000", "/api/auth/providers"],
    ["http://127.0.0.1:4000/private", "/api/auth/providers"],
    ["http://127.0.0.1:4000/?private=true", "/api/auth/providers"],
    ["http://127.0.0.1:4000/#private", "/api/auth/providers"],
    ["http://127.0.0.1:4000", "/healthz"],
  ])("rejects an invalid gateway target %#", (gatewayUrl, pathname) => {
    expect(() => resolveGatewayEndpoint({ gatewayUrl, pathname, search: "" })).toThrow();
  });
});

describe("trusted edge address selection", () => {
  it("keeps forwarding assertions untrusted by default", () => {
    const headers = new Headers({ "x-forwarded-for": "192.0.2.10, 198.51.100.22" });

    expect(selectTrustedClientAddress(headers, 0)).toBeUndefined();
  });

  it("selects only the address immediately before the configured trusted hops", () => {
    const headers = new Headers({
      "x-forwarded-for": "192.0.2.10, 198.51.100.22, 2001:db8:1:2::44",
    });

    expect(selectTrustedClientAddress(headers, 1)).toBe("2001:db8:1:2::44");
    expect(selectTrustedClientAddress(headers, 2)).toBe("198.51.100.22");
  });

  it("fails closed for missing, malformed, or oversized forwarding chains", () => {
    expect(selectTrustedClientAddress(new Headers(), 1)).toBeUndefined();
    expect(
      selectTrustedClientAddress(new Headers({ "x-forwarded-for": "unknown, 192.0.2.10" }), 2),
    ).toBeUndefined();
    expect(
      selectTrustedClientAddress(
        new Headers({ "x-forwarded-for": `192.0.2.10,${" ".repeat(4096)}` }),
        1,
      ),
    ).toBeUndefined();
  });
});

describe("gateway proxy transport", () => {
  it("strips untrusted hop assertions and preserves redirects with distinct cookies", async () => {
    let sentEndpoint: URL | string | Request | undefined;
    let sentInit: (RequestInit & { duplex?: "half" }) | undefined;
    const upstreamHeaders = new Headers({
      "cache-control": "no-store",
      connection: "x-private-response",
      location: "/settings",
      "x-private-response": "remove-me",
    });
    upstreamHeaders.append("set-cookie", "first=one; HttpOnly; Path=/");
    upstreamHeaders.append("set-cookie", "second=two; HttpOnly; Path=/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (endpoint: URL | string | Request, init?: RequestInit) => {
        sentEndpoint = endpoint;
        sentInit = init;
        return new Response("proxied", { headers: upstreamHeaders, status: 303 });
      }),
    );

    const response = await proxyGatewayRequest(
      requestFixture({
        headers: {
          connection: "x-private-request",
          host: "attacker.example",
          "x-forwarded-for": "198.51.100.77",
          "x-private-request": "remove-me",
          "x-real-ip": "192.0.2.44",
          "x-request-id": "attacker-selected-correlation",
        },
        path: "/api/auth/oidc/provider/start?returnPath=%2Fsettings",
      }),
    );

    expect(String(sentEndpoint)).toBe(
      "http://127.0.0.1:4000/v1/auth/oidc/provider/start?returnPath=%2Fsettings",
    );
    const sentHeaders = sentInit?.headers as Headers;
    expect(sentHeaders.get("accept-encoding")).toBe("identity");
    expect(sentHeaders.get("host")).toBeNull();
    expect(sentHeaders.get("x-forwarded-for")).toBeNull();
    expect(sentHeaders.get("x-private-request")).toBeNull();
    expect(sentHeaders.get("x-real-ip")).toBeNull();
    expect(sentHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(sentHeaders.get("x-request-id")).not.toBe("attacker-selected-correlation");
    expect(sentInit).toMatchObject({ cache: "no-store", method: "GET", redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
    expect(response.headers.get("x-private-response")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([
      "first=one; HttpOnly; Path=/",
      "second=two; HttpOnly; Path=/",
    ]);
    await expect(response.text()).resolves.toBe("proxied");
  });

  it("forwards one canonical address from an explicitly trusted edge chain", async () => {
    let sentHeaders: Headers | undefined;
    vi.stubEnv("OMNIFIN_WEB_TRUST_PROXY_HOPS", "1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_endpoint: URL | string | Request, init?: RequestInit) => {
        sentHeaders = init?.headers as Headers;
        return Response.json({ accepted: true });
      }),
    );

    await proxyGatewayRequest(
      requestFixture({
        headers: {
          forwarded: "for=attacker.example",
          "x-forwarded-for": "192.0.2.44, 198.51.100.77",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
          "x-real-ip": "203.0.113.9",
        },
      }),
    );

    expect(sentHeaders?.get("x-forwarded-for")).toBe("198.51.100.77");
    expect(sentHeaders?.get("forwarded")).toBeNull();
    expect(sentHeaders?.get("x-forwarded-host")).toBeNull();
    expect(sentHeaders?.get("x-forwarded-proto")).toBeNull();
    expect(sentHeaders?.get("x-real-ip")).toBeNull();
  });

  it("streams a mutation body without forwarding a caller-supplied content length", async () => {
    let sentBody = "";
    let sentInit: (RequestInit & { duplex?: "half" }) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_endpoint: URL | string | Request, init?: RequestInit) => {
        sentInit = init;
        sentBody = await new Response(init?.body).text();
        return Response.json({ accepted: true });
      }),
    );

    const response = await proxyGatewayRequest(
      requestFixture({
        body: '{"confirm":true}',
        headers: {
          "content-length": "999999",
          "content-type": "application/json",
          origin: "https://omnifin.example.test",
        },
        method: "POST",
        path: "/api/auth/recovery/session",
      }),
    );

    expect(sentBody).toBe('{"confirm":true}');
    expect(sentInit?.duplex).toBe("half");
    expect((sentInit?.headers as Headers).get("content-length")).toBeNull();
    expect((sentInit?.headers as Headers).get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("does not truncate a response body after the gateway returns its headers", async () => {
    const proxyWithShortHeaderDeadline = createGatewayProxy({ headerTimeoutMs: 5 });
    let releaseBody: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_endpoint: URL | string | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected the gateway request to have an abort signal.");
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("stream-open-"));
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
              releaseBody = () => {
                if (signal.aborted) return;
                controller.enqueue(encoder.encode("stream-close"));
                controller.close();
              };
            },
          }),
        );
      }),
    );

    const response = await proxyWithShortHeaderDeadline(requestFixture());
    const bodyAssertion = expect(response.text()).resolves.toBe("stream-open-stream-close");
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseBody?.();

    await bodyAssertion;
  });

  it("still aborts a streamed response when the downstream request closes", async () => {
    const downstreamRequest = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_endpoint: URL | string | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected the gateway request to have an abort signal.");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("stream-open"));
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
        );
      }),
    );

    const response = await proxyGatewayRequest(
      requestFixture({ signal: downstreamRequest.signal }),
    );
    const body = response.text();
    downstreamRequest.abort(new DOMException("The downstream request closed.", "AbortError"));

    await expect(body).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts a gateway request that does not return headers before the deadline", async () => {
    const proxyWithShortHeaderDeadline = createGatewayProxy({ headerTimeoutMs: 5 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_endpoint: URL | string | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("Expected the gateway request to have an abort signal."));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    );

    const response = await proxyWithShortHeaderDeadline(requestFixture());

    expect(response.status).toBe(503);
  });

  it("cancels the header deadline when the gateway request fails", async () => {
    const proxyWithShortHeaderDeadline = createGatewayProxy({ headerTimeoutMs: 5 });
    let gatewaySignal: AbortSignal | undefined;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_endpoint: URL | string | Request, init?: RequestInit) => {
        gatewaySignal = init?.signal ?? undefined;
        throw new Error("Synthetic gateway failure.");
      }),
    );

    const response = await proxyWithShortHeaderDeadline(requestFixture());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(response.status).toBe(503);
    expect(gatewaySignal?.aborted).toBe(false);
  });

  it("returns and logs only a bounded correlation envelope when the gateway fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let sentRequestId: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_endpoint: URL | string | Request, init?: RequestInit) => {
        sentRequestId = (init?.headers as Headers).get("x-request-id");
        throw new Error("private-upstream-diagnostic");
      }),
    );

    const response = await proxyGatewayRequest(
      requestFixture({
        path: "/api/auth/oidc/callback/provider?code=private-code&state=private-state",
      }),
    );
    const payload = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sentRequestId).toBe(payload.error.requestId);
    expect(payload).toEqual({
      error: {
        code: "service_unavailable",
        message: "The gateway is unavailable.",
        requestId: expect.any(String),
      },
    });
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({ event: "gateway_proxy_unavailable", requestId: payload.error.requestId }),
    );
    const serializedLog = JSON.stringify(errorLog.mock.calls);
    expect(serializedLog).not.toContain("private-code");
    expect(serializedLog).not.toContain("private-state");
    expect(serializedLog).not.toContain("private-upstream-diagnostic");
  });
});
