import {
  Configuration,
  type ClientAuth,
  type ClientMetadata,
  type CustomFetch,
  type ServerMetadata,
} from "openid-client";
import { createApp } from "../../src/app.js";
import type { OidcProtocolDependencies } from "../../src/auth/oidc/protocol.js";
import type { AppConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/client.js";
import { oidcProviders } from "../../src/db/schema.js";

const PROVIDER_ID = "synthetic-oidc";
const PROVIDER_ISSUER = "https://identity.example.test/application/o/omnifin/";
const SYNTHETIC_AUTHORIZATION_CODE = "synthetic-authorization-code";
const SYNTHETIC_PROVIDER_EXTENSION = "rewrite-preserved";
const SYNTHETIC_PROVIDER_SESSION = "synthetic-provider-session";
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function environmentPort(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${name} must be a valid TCP port.`);
  }
  return value;
}

function webOrigin() {
  const value = process.env.OMNIFIN_OIDC_REWRITE_WEB_ORIGIN ?? "http://127.0.0.1:3000";
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new TypeError("The synthetic web origin must be a canonical HTTP loopback origin.");
  }
  return origin;
}

function testConfig(baseUrl: URL, port: number): AppConfig {
  return {
    baseUrl,
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 71),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port,
    secureCookies: false,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 12 * 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 15 * 60 * 1_000,
    },
    trustProxyHops: 1,
  };
}

function providerMetadata(): ServerMetadata {
  return {
    authorization_endpoint: "https://identity.example.test/application/o/authorize/",
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"],
    id_token_signing_alg_values_supported: ["RS256"],
    issuer: PROVIDER_ISSUER,
    jwks_uri: "https://identity.example.test/application/o/omnifin/jwks/",
    response_types_supported: ["code"],
    token_endpoint: "https://identity.example.test/application/o/token/",
    token_endpoint_auth_methods_supported: ["none"],
  } as ServerMetadata;
}

function discoveredConfiguration(
  clientId: string,
  clientMetadata: Partial<ClientMetadata> | string | undefined,
  clientAuthentication: ClientAuth | undefined,
) {
  return new Configuration(providerMetadata(), clientId, clientMetadata, clientAuthentication);
}

function requireExactQueryParameter(url: URL, name: string, expected: string) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0] !== expected) {
    throw new Error(`The synthetic callback did not preserve ${name}.`);
  }
}

function syntheticAuthorizationCodeGrant(
  expectedWebOrigin: URL,
): NonNullable<OidcProtocolDependencies["authorizationCodeGrant"]> {
  return async (_runtime, callbackUrl, checks) => {
    if (
      `${callbackUrl.origin}${callbackUrl.pathname}` !==
      `${expectedWebOrigin.origin}/api/auth/oidc/callback/${PROVIDER_ID}`
    ) {
      throw new Error("The synthetic callback URI changed across the rewrite boundary.");
    }
    requireExactQueryParameter(callbackUrl, "code", SYNTHETIC_AUTHORIZATION_CODE);
    requireExactQueryParameter(callbackUrl, "iss", PROVIDER_ISSUER);
    requireExactQueryParameter(callbackUrl, "provider_extension", SYNTHETIC_PROVIDER_EXTENSION);
    requireExactQueryParameter(callbackUrl, "session_state", SYNTHETIC_PROVIDER_SESSION);
    if (
      typeof checks.expectedState !== "string" ||
      !OPAQUE_TOKEN_PATTERN.test(checks.expectedState)
    ) {
      throw new Error("The synthetic callback state was not bound to the transaction.");
    }
    requireExactQueryParameter(callbackUrl, "state", checks.expectedState);
    if (
      typeof checks.expectedNonce !== "string" ||
      !OPAQUE_TOKEN_PATTERN.test(checks.expectedNonce) ||
      typeof checks.pkceCodeVerifier !== "string" ||
      checks.pkceCodeVerifier.length < 43
    ) {
      throw new Error("The synthetic callback lost its nonce or PKCE verifier.");
    }

    return {
      claims: {
        email: "viewer@example.test",
        email_verified: true,
        name: "Synthetic Viewer",
        sub: "synthetic-immutable-subject",
      },
      idToken: "header.payload.signature",
    };
  };
}

async function main() {
  const port = environmentPort("OMNIFIN_OIDC_REWRITE_GATEWAY_PORT", 4000);
  const publicOrigin = webOrigin();
  const startedAt = new Date();
  const database = openDatabase(":memory:");
  database.migrate();
  const createdAt = new Date(startedAt.getTime() - 60_000);
  database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(["https://identity.example.test"]),
      clientId: "omnifin-rewrite-client",
      createdAt,
      displayName: "Synthetic identity",
      id: PROVIDER_ID,
      issuer: PROVIDER_ISSUER,
      slug: "synthetic",
      tokenEndpointAuthMethod: "none",
      updatedAt: createdAt,
    })
    .run();

  const app = await createApp({
    config: testConfig(publicOrigin, port),
    database,
    migrate: false,
    oidcDependencies: {
      authorizationTransaction: { clock: () => new Date(startedAt) },
      failureAudit: { clock: () => new Date(startedAt) },
      identity: { clock: () => new Date(startedAt) },
      protocol: { authorizationCodeGrant: syntheticAuthorizationCodeGrant(publicOrigin) },
      providerRegistry: {
        clock: () => new Date(startedAt),
        createSafeFetch: () =>
          (async () => {
            throw new Error("Synthetic discovery must not make a network request.");
          }) as CustomFetch,
        discover: async (
          _server: URL,
          clientId: string,
          clientMetadata: Partial<ClientMetadata> | string | undefined,
          clientAuthentication: ClientAuth | undefined,
        ) => discoveredConfiguration(clientId, clientMetadata, clientAuthentication),
      },
    },
    sessionDependencies: { clock: () => new Date(startedAt) },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/v1/auth/oidc/callback/upstream-outage-canary?")) {
      reply.hijack();
      request.raw.socket.destroy();
      return reply;
    }
  });

  const clientIsolationCanary = app.createRateLimit({
    keyGenerator: (request) => request.ip,
    max: 1,
    timeWindow: "1 minute",
  });

  app.get("/v1/auth/proxy-canary/client-limit", async (request, reply) => {
    const result = await clientIsolationCanary(request);
    if (!result.isAllowed && result.isExceeded) {
      return reply.code(429).send({ limited: true });
    }
    return { client: request.ip, limited: false };
  });

  app.get("/v1/auth/proxy-canary/forwarding", async (request) => ({
    forwardingHeaders: Object.fromEntries(
      [
        "cf-connecting-ip",
        "cf-pseudo-ipv4",
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
        "x-forwarded-client-cert",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto",
        "x-original-forwarded-for",
        "x-proxyuser-ip",
        "x-real-ip",
      ].flatMap((name) => {
        const value = request.headers[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    ip: request.ip,
    requestId: request.id,
  }));

  let releaseStream: (() => void) | undefined;
  app.get("/v1/auth/proxy-canary/stream", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    reply.raw.write("stream-open");
    await new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    releaseStream = undefined;
    reply.raw.end("-stream-close");
  });
  app.post(
    "/v1/auth/proxy-canary/release-stream",
    { config: { omnifinSecurity: { kind: "public-browser" } } },
    async () => {
      releaseStream?.();
      return { released: true };
    },
  );

  try {
    await app.listen({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    await app.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "The synthetic OIDC harness failed.");
  process.exitCode = 1;
}
