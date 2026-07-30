import type { NextRequest } from "next/server";
import { isIP } from "node:net";

const defaultGatewayUrl = process.env.OMNIFIN_GATEWAY_URL ?? "http://127.0.0.1:4000";
const defaultGatewayHeaderTimeoutMs = 30_000;
const maxForwardedForLength = 4_096;
const maxForwardedForEntries = 32;
const demoArtworkPath = /^\/api\/discovery\/artwork\/discovery_art_([a-f])\1{21}$/u;
const demoArtworkJpeg = Uint8Array.from(
  Buffer.from(
    "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",
    "base64",
  ),
);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const clientAddressHeaders = new Set([
  "cf-pseudo-ipv4",
  "cf-connecting-ip",
  "client-ip",
  "fastly-client-ip",
  "fly-client-ip",
  "forwarded",
  "true-client-ip",
  "via",
  "x-appengine-user-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-envoy-external-address",
  "x-original-forwarded-for",
  "x-proxyuser-ip",
  "x-real-ip",
]);

function demoArtworkResponse(request: NextRequest) {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const match = demoArtworkPath.exec(request.nextUrl.pathname);
  if (match === null) return null;
  return new Response(request.method === "HEAD" ? null : demoArtworkJpeg, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(demoArtworkJpeg.byteLength),
      "content-type": "image/jpeg",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

function connectionHeaderTokens(headers: Headers) {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isForwardingHeader(name: string) {
  return name.startsWith("x-forwarded-") || clientAddressHeaders.has(name);
}

function configuredTrustedProxyHops() {
  const value = process.env.OMNIFIN_WEB_TRUST_PROXY_HOPS ?? "0";
  return /^[0-4]$/u.test(value) ? Number(value) : 0;
}

export function selectTrustedClientAddress(headers: Headers, trustedProxyHops: number) {
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1 || trustedProxyHops > 4) {
    return undefined;
  }
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor === null || forwardedFor.length > maxForwardedForLength) return undefined;
  const chain = forwardedFor.split(",").map((address) => address.trim());
  if (chain.length > maxForwardedForEntries || chain.length < trustedProxyHops) return undefined;
  const candidate = chain.at(-trustedProxyHops);
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : undefined;
}

function gatewayRequestHeaders(requestHeaders: Headers, requestId: string) {
  const connectionTokens = connectionHeaderTokens(requestHeaders);
  const trustedClientAddress = selectTrustedClientAddress(
    requestHeaders,
    configuredTrustedProxyHops(),
  );
  const headers = new Headers();

  for (const [rawName, value] of requestHeaders) {
    const name = rawName.toLowerCase();
    if (
      name === "host" ||
      name === "content-length" ||
      name === "x-request-id" ||
      hopByHopHeaders.has(name) ||
      connectionTokens.has(name) ||
      isForwardingHeader(name)
    ) {
      continue;
    }
    headers.append(name, value);
  }

  // Route handlers do not expose socket metadata. When the public edge is explicitly
  // trusted, retain only the address immediately before those trusted hops. Every
  // caller-controlled prefix and every other client-address assertion stays removed.
  if (trustedClientAddress !== undefined) {
    headers.set("x-forwarded-for", trustedClientAddress);
  }
  headers.set("x-request-id", requestId);
  // Node fetch transparently decodes compressed bodies. Asking the private gateway
  // for identity encoding keeps the response headers and streamed bytes consistent.
  headers.set("accept-encoding", "identity");
  return headers;
}

function gatewayResponseHeaders(responseHeaders: Headers) {
  const connectionTokens = connectionHeaderTokens(responseHeaders);
  const headers = new Headers();

  for (const [rawName, value] of responseHeaders) {
    const name = rawName.toLowerCase();
    if (name === "set-cookie") continue;
    if (hopByHopHeaders.has(name) || connectionTokens.has(name)) continue;
    headers.append(name, value);
  }
  for (const cookie of responseHeaders.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
}

interface ResolveGatewayEndpointOptions {
  readonly gatewayUrl: string;
  readonly pathname: string;
  readonly search: string;
}

export function resolveGatewayEndpoint({
  gatewayUrl: configuredGatewayUrl,
  pathname,
  search,
}: ResolveGatewayEndpointOptions) {
  const gateway = new URL(configuredGatewayUrl);
  if (
    (gateway.protocol !== "http:" && gateway.protocol !== "https:") ||
    gateway.username !== "" ||
    gateway.password !== "" ||
    gateway.pathname !== "/" ||
    gateway.search !== "" ||
    gateway.hash !== ""
  ) {
    throw new TypeError("The gateway URL is invalid.");
  }
  if (pathname !== "/api" && !pathname.startsWith("/api/")) {
    throw new TypeError("The request path is outside the same-origin API prefix.");
  }

  const endpoint = new URL(`/v1${pathname.slice("/api".length)}`, gateway);
  if (endpoint.pathname !== "/v1" && !endpoint.pathname.startsWith("/v1/")) {
    throw new TypeError("The resolved path is outside the gateway API prefix.");
  }
  endpoint.search = search;
  return endpoint;
}

function gatewayUnavailableResponse(requestId: string) {
  console.error(JSON.stringify({ event: "gateway_proxy_unavailable", requestId }));
  return Response.json(
    {
      error: {
        code: "service_unavailable",
        message: "The gateway is unavailable.",
        requestId,
      },
    },
    {
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
      status: 503,
    },
  );
}

interface GatewayProxyOptions {
  readonly gatewayUrl?: string;
  readonly headerTimeoutMs?: number;
}

export function createGatewayProxy({
  gatewayUrl = defaultGatewayUrl,
  headerTimeoutMs = defaultGatewayHeaderTimeoutMs,
}: GatewayProxyOptions = {}) {
  return async function proxyGatewayRequest(request: NextRequest) {
    const demoArtwork = demoArtworkResponse(request);
    if (demoArtwork !== null) return demoArtwork;
    const requestId = crypto.randomUUID();
    try {
      const requestHasBody = request.method !== "GET" && request.method !== "HEAD";
      const headerDeadline = new AbortController();
      const headerDeadlineTimer = setTimeout(
        () =>
          headerDeadline.abort(
            new DOMException(
              "The gateway did not return headers before the deadline.",
              "TimeoutError",
            ),
          ),
        headerTimeoutMs,
      );
      headerDeadlineTimer.unref();
      const requestInit: RequestInit & { duplex?: "half" } = {
        cache: "no-store",
        headers: gatewayRequestHeaders(request.headers, requestId),
        method: request.method,
        redirect: "manual",
        signal: AbortSignal.any([request.signal, headerDeadline.signal]),
      };
      if (requestHasBody) {
        requestInit.body = request.body;
        requestInit.duplex = "half";
      }

      let upstream: Response;
      try {
        upstream = await fetch(
          resolveGatewayEndpoint({
            gatewayUrl,
            pathname: request.nextUrl.pathname,
            search: request.nextUrl.search,
          }),
          requestInit,
        );
      } finally {
        clearTimeout(headerDeadlineTimer);
      }
      return new Response(upstream.body, {
        headers: gatewayResponseHeaders(upstream.headers),
        status: upstream.status,
        statusText: upstream.statusText,
      });
    } catch {
      return gatewayUnavailableResponse(requestId);
    }
  };
}

export const proxyGatewayRequest = createGatewayProxy();
