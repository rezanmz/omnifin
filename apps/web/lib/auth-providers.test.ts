import {
  AUTH_PROVIDERS_MAX_COUNT,
  AUTH_PROVIDERS_RESPONSE_MAX_BYTES,
  OIDC_ISSUER_MAX_LENGTH,
} from "@omnifin/contracts/auth";
import { describe, expect, it, vi } from "vitest";
import { createCachedPublicAuthProviderLoader, loadPublicAuthProviders } from "./auth-providers";

const oidcProvider = {
  displayName: "Home identity",
  id: "oidc:home",
  issuer: "https://identity.example.test/application/o/omnifin/",
  jitProvisioningEnabled: true,
  kind: "oidc" as const,
  state: "available" as const,
  supportsBackChannelLogout: true,
  supportsFrontChannelLogout: true,
  supportsRpInitiatedLogout: true,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

describe("loadPublicAuthProviders", () => {
  it("loads and validates the bounded public provider contract without fetch caching", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ providers: [oidcProvider] }));

    const result = await loadPublicAuthProviders({
      fetchImplementation,
      gatewayUrl: "http://gateway:4000",
    });

    expect(result).toEqual({ providers: [oidcProvider], status: "ready" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://gateway:4000/v1/auth/providers",
      expect.objectContaining({
        cache: "no-store",
        headers: { accept: "application/json" },
        redirect: "error",
      }),
    );
  });

  it.each([
    ["a malformed response", "not-json"],
    ["an invalid contract", JSON.stringify({ providers: [{ id: "private-only" }] })],
    ["an oversized response", "x".repeat(AUTH_PROVIDERS_RESPONSE_MAX_BYTES + 1)],
  ])("fails closed for %s", async (_name, body) => {
    const fetchImplementation = vi.fn(
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
    );

    await expect(
      loadPublicAuthProviders({ fetchImplementation, gatewayUrl: "http://gateway:4000" }),
    ).resolves.toEqual({ providers: [], status: "unavailable" });
  });

  it("cancels an oversized chunked response before reading its tail", async () => {
    let cancelled = false;
    let pulls = 0;
    let tailRead = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(AUTH_PROVIDERS_RESPONSE_MAX_BYTES / 2));
            return;
          }
          if (pulls === 2) {
            controller.enqueue(new Uint8Array(AUTH_PROVIDERS_RESPONSE_MAX_BYTES / 2 + 1));
            return;
          }
          tailRead = true;
          controller.enqueue(new TextEncoder().encode("private-upstream-tail"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImplementation = vi.fn(
      async () => new Response(stream, { headers: { "content-type": "application/json" } }),
    );

    await expect(
      loadPublicAuthProviders({ fetchImplementation, gatewayUrl: "http://gateway:4000" }),
    ).resolves.toEqual({ providers: [], status: "unavailable" });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
    expect(tailRead).toBe(false);
  });

  it("accepts the exact maximum provider count and issuer length", async () => {
    const issuerPrefix = "https://identity.example.test/";
    const issuer = `${issuerPrefix}${"a".repeat(OIDC_ISSUER_MAX_LENGTH - issuerPrefix.length)}`;
    const providers = Array.from({ length: AUTH_PROVIDERS_MAX_COUNT }, (_, index) => ({
      ...oidcProvider,
      displayName: `Identity ${index}`,
      id: `oidc-${index}`,
      issuer,
    }));
    const body = JSON.stringify({ providers });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      AUTH_PROVIDERS_RESPONSE_MAX_BYTES,
    );

    const result = await loadPublicAuthProviders({
      fetchImplementation: vi.fn(async () =>
        jsonResponse({ providers }, { headers: { "content-length": String(body.length) } }),
      ),
      gatewayUrl: "http://gateway:4000",
    });

    expect(result.status).toBe("ready");
    expect(result.providers).toHaveLength(AUTH_PROVIDERS_MAX_COUNT);
  });

  it("rejects a non-root or credentialed gateway URL before making a request", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      loadPublicAuthProviders({
        fetchImplementation,
        gatewayUrl: "https://user:secret@gateway.example/private",
      }),
    ).resolves.toEqual({ providers: [], status: "unavailable" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("createCachedPublicAuthProviderLoader", () => {
  it("single-flights concurrent requests and serves a bounded five-second cache", async () => {
    let now = 10_000;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImplementation = vi.fn(async () => {
      await gate;
      return jsonResponse({ providers: [oidcProvider] });
    });
    const load = createCachedPublicAuthProviderLoader({
      clock: () => now,
      fetchImplementation,
    });

    const pending = Array.from({ length: 100 }, () => load({ gatewayUrl: "http://gateway:4000" }));
    expect(fetchImplementation).toHaveBeenCalledOnce();
    release?.();
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 100 }, () => ({ providers: [oidcProvider], status: "ready" })),
    );

    await load({ gatewayUrl: "http://gateway:4000" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    now += 5_000;
    await load({ gatewayUrl: "http://gateway:4000" });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("bounds unavailable caching, recovers after expiry, and invalidates on clock rollback", async () => {
    let now = 20_000;
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValue(jsonResponse({ providers: [oidcProvider] }));
    const load = createCachedPublicAuthProviderLoader({
      clock: () => now,
      fetchImplementation,
    });

    await expect(load({ gatewayUrl: "http://gateway:4000" })).resolves.toEqual({
      providers: [],
      status: "unavailable",
    });
    await load({ gatewayUrl: "http://gateway:4000" });
    expect(fetchImplementation).toHaveBeenCalledOnce();

    now += 5_000;
    await expect(load({ gatewayUrl: "http://gateway:4000" })).resolves.toEqual({
      providers: [oidcProvider],
      status: "ready",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    now -= 10_000;
    await load({ gatewayUrl: "http://gateway:4000" });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("evicts the least-recently-used gateway from a fixed-size cache", async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ providers: [] }));
    const load = createCachedPublicAuthProviderLoader({ fetchImplementation, maxEntries: 2 });

    await load({ gatewayUrl: "http://gateway-a:4000" });
    await load({ gatewayUrl: "http://gateway-b:4000" });
    await load({ gatewayUrl: "http://gateway-a:4000" });
    await load({ gatewayUrl: "http://gateway-c:4000" });
    await load({ gatewayUrl: "http://gateway-b:4000" });

    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });
});
