import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayProxy,
  proxyGatewayRequest,
  resolveGatewayEndpoint,
  selectTrustedClientAddress,
} from "./gateway-proxy";
import { browserPlaybackPath } from "./playback";

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
    const headers = new Headers({
      "x-forwarded-for": "192.0.2.10, 198.51.100.22",
    });

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
  it.each([
    {
      body: '{"token":"invite-token"}',
      expectedBody: '{"token":"invite-token"}',
      method: "POST",
      path: "/api/auth/invitations/exchange?source=invite%2F001",
      upstreamPath: "/v1/auth/invitations/exchange?source=invite%2F001",
    },
    {
      body: "{}",
      expectedBody: "{}",
      method: "POST",
      path: "/api/auth/invitations/oidc/provider/start?returnPath=%2Fsettings",
      upstreamPath: "/v1/auth/invitations/oidc/provider/start?returnPath=%2Fsettings",
    },
    {
      body: undefined,
      expectedBody: undefined,
      method: "GET",
      path: "/api/admin/invites?cursor=page-2&status=active",
      upstreamPath: "/v1/admin/invites?cursor=page-2&status=active",
    },
    {
      body: undefined,
      expectedBody: null,
      method: "POST",
      path: "/api/admin/invites/invite-001/revoke?reason=user-requested",
      upstreamPath: "/v1/admin/invites/invite-001/revoke?reason=user-requested",
    },
  ])(
    "forwards $path to the exact gateway path, method, body, and query",
    async ({ body, expectedBody, method, path, upstreamPath }) => {
      const upstream = vi.fn(async (endpoint: URL | string | Request, init?: RequestInit) => {
        expect(String(endpoint)).toBe(`http://127.0.0.1:4000${upstreamPath}`);
        expect(init?.method).toBe(method);
        const sentBody =
          init?.body === undefined
            ? undefined
            : init.body === null
              ? null
              : await new Response(init.body).text();
        expect(sentBody).toBe(expectedBody);
        return Response.json({ accepted: true });
      });
      vi.stubGlobal("fetch", upstream);

      const response = await createGatewayProxy({ gatewayUrl: "http://127.0.0.1:4000" })(
        requestFixture({
          method,
          path,
          ...(body === undefined ? {} : { body }),
        }),
      );

      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it("keeps negotiated HLS masters, nested manifests, and segments on the public API path", async () => {
    const sessionId = `playback_${"p".repeat(22)}`;
    const mediaReferenceId = `media_${"m".repeat(22)}`;
    const levelHandle = `asset_h1.${"a".repeat(22)}`;
    const segmentHandle = `asset_h1.${"b".repeat(22)}`;
    const upstreamPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (endpoint: URL | string | Request) => {
        const pathname = new URL(String(endpoint)).pathname;
        upstreamPaths.push(pathname);
        if (pathname === `/v1/media/${mediaReferenceId}/playback`) {
          return Response.json(
            { streamPath: `/v1/playback/${sessionId}/master.m3u8` },
            { status: 201 },
          );
        }
        if (pathname === `/v1/playback/${sessionId}/master.m3u8`) {
          return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nhls/${levelHandle}\n`, {
            headers: { "content-type": "application/vnd.apple.mpegurl" },
          });
        }
        if (pathname === `/v1/playback/${sessionId}/hls/${levelHandle}`) {
          return new Response(`#EXTM3U\n#EXTINF:4.000,\n./${segmentHandle}\n`, {
            headers: { "content-type": "application/vnd.apple.mpegurl" },
          });
        }
        if (pathname === `/v1/playback/${sessionId}/hls/${segmentHandle}`) {
          return new Response(new Uint8Array([0, 0, 0, 24, 109, 111, 111, 102]), {
            headers: { "content-type": "video/mp4" },
          });
        }
        return new Response("unexpected", { status: 404 });
      }),
    );

    const negotiation = await proxyGatewayRequest(
      requestFixture({
        body: "{}",
        method: "POST",
        path: `/api/media/${mediaReferenceId}/playback`,
      }),
    );
    const negotiated = (await negotiation.json()) as { streamPath: string };
    const masterPath = browserPlaybackPath(negotiated.streamPath);
    const master = await proxyGatewayRequest(requestFixture({ path: masterPath }));
    const levelReference = (await master.text())
      .split("\n")
      .find((line) => line.startsWith("hls/"));
    expect(levelReference).toBeDefined();
    const levelPath = new URL(levelReference!, `https://omnifin.example${masterPath}`).pathname;
    expect(levelPath).toMatch(/^\/api\/playback\//u);

    const level = await proxyGatewayRequest(requestFixture({ path: levelPath }));
    const segmentReference = (await level.text()).split("\n").find((line) => line.startsWith("./"));
    expect(segmentReference).toBeDefined();
    const segmentPath = new URL(segmentReference!, `https://omnifin.example${levelPath}`).pathname;
    expect(segmentPath).toMatch(/^\/api\/playback\//u);

    const segment = await proxyGatewayRequest(requestFixture({ path: segmentPath }));
    expect(segment.status).toBe(200);
    expect(segment.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await segment.arrayBuffer())).toEqual(
      new Uint8Array([0, 0, 0, 24, 109, 111, 111, 102]),
    );
    expect(upstreamPaths).toEqual([
      `/v1/media/${mediaReferenceId}/playback`,
      `/v1/playback/${sessionId}/master.m3u8`,
      `/v1/playback/${sessionId}/hls/${levelHandle}`,
      `/v1/playback/${sessionId}/hls/${segmentHandle}`,
    ]);
  });

  it("serves only bounded generated discovery artwork in explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await proxyGatewayRequest(
      requestFixture({
        path: `/api/discovery/artwork/discovery_art_${"a".repeat(22)}`,
      }),
    );
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(body.byteLength).toBeGreaterThan(1_000);
    expect([...body.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not bypass the gateway for an unknown test artwork reference", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");
    const upstream = vi.fn(async () => new Response("upstream", { status: 202 }));
    vi.stubGlobal("fetch", upstream);

    const response = await proxyGatewayRequest(
      requestFixture({
        path: `/api/discovery/artwork/discovery_art_${"z".repeat(22)}`,
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("upstream");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("keeps generated artwork behind explicit test mode", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "false");
    const upstream = vi.fn(async () => new Response("protected-upstream", { status: 206 }));
    vi.stubGlobal("fetch", upstream);

    const response = await proxyGatewayRequest(
      requestFixture({
        path: `/api/discovery/artwork/discovery_art_${"a".repeat(22)}`,
      }),
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("protected-upstream");
    expect(upstream).toHaveBeenCalledOnce();
  });

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
        return new Response("proxied", {
          headers: upstreamHeaders,
          status: 303,
        });
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
    expect(sentInit).toMatchObject({
      cache: "no-store",
      method: "GET",
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
    expect(response.headers.get("x-private-response")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([
      "first=one; HttpOnly; Path=/",
      "second=two; HttpOnly; Path=/",
    ]);
    await expect(response.text()).resolves.toBe("proxied");
  });

  it("passes an external service redirect to the browser without fetching its destination", async () => {
    const upstream = vi.fn(async (_endpoint: URL | string | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        headers: {
          location: "https://movies.example.test/radarr/movie/the-far-meridian",
          "referrer-policy": "no-referrer",
        },
        status: 303,
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await proxyGatewayRequest(
      requestFixture({
        path: `/api/media/library/media_${"m".repeat(22)}/actions/radarr`,
      }),
    );

    expect(upstream).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://movies.example.test/radarr/movie/the-far-meridian",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
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
    const proxyWithShortHeaderDeadline = createGatewayProxy({
      headerTimeoutMs: 5,
    });
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

  it("preserves SSE framing, resume cursors, and anti-buffering headers", async () => {
    let sentEndpoint: URL | string | Request | undefined;
    let sentHeaders: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (endpoint: URL | string | Request, init?: RequestInit) => {
        sentEndpoint = endpoint;
        sentHeaders = init?.headers as Headers;
        return new Response(
          "retry: 3000\n\nid: download_event_ABCDEFGHIJKLMNOPQRSTUV\ndata: {}\n\n",
          {
            headers: {
              "cache-control": "no-store, no-transform",
              connection: "keep-alive",
              "content-type": "text/event-stream; charset=utf-8",
              "x-accel-buffering": "no",
            },
          },
        );
      }),
    );

    const response = await proxyGatewayRequest(
      requestFixture({
        headers: {
          cookie: "omnifin_session=opaque",
          "last-event-id": "download_event_ABCDEFGHIJKLMNOPQRSTUV",
        },
        path: "/api/downloads/queue/events",
      }),
    );

    expect(String(sentEndpoint)).toBe("http://127.0.0.1:4000/v1/downloads/queue/events");
    expect(sentHeaders?.get("cookie")).toBe("omnifin_session=opaque");
    expect(sentHeaders?.get("last-event-id")).toBe("download_event_ABCDEFGHIJKLMNOPQRSTUV");
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("connection")).toBeNull();
    await expect(response.text()).resolves.toContain("id: download_event_ABCDEFGHIJKLMNOPQRSTUV");
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
    const proxyWithShortHeaderDeadline = createGatewayProxy({
      headerTimeoutMs: 5,
    });
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
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    );

    const response = await proxyWithShortHeaderDeadline(requestFixture());

    expect(response.status).toBe(503);
  });

  it("cancels the header deadline when the gateway request fails", async () => {
    const proxyWithShortHeaderDeadline = createGatewayProxy({
      headerTimeoutMs: 5,
    });
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
      JSON.stringify({
        event: "gateway_proxy_unavailable",
        requestId: payload.error.requestId,
      }),
    );
    const serializedLog = JSON.stringify(errorLog.mock.calls);
    expect(serializedLog).not.toContain("private-code");
    expect(serializedLog).not.toContain("private-state");
    expect(serializedLog).not.toContain("private-upstream-diagnostic");
  });
});
