import type { NextRequest } from "next/server";
import { isIP } from "node:net";

const defaultGatewayUrl = process.env.OMNIFIN_GATEWAY_URL ?? "http://127.0.0.1:4000";
const defaultGatewayHeaderTimeoutMs = 30_000;
const maxForwardedForLength = 4_096;
const maxForwardedForEntries = 32;
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
