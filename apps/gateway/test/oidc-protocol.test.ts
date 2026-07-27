import {
  Configuration,
  customFetch,
  type ClientAuth,
  type ClientMetadata,
  type CustomFetch,
  type ServerMetadata,
} from "openid-client";
import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OidcAuthorizationTransactionService } from "../src/auth/oidc/authorization-transaction.js";
import {
  buildOidcRuntimeEndSessionUrl,
  OidcProviderRegistry,
  oidcClientSecretEncryptionContext,
  oidcProviderRuntimeBinding,
  type OidcProviderRuntime,
} from "../src/auth/oidc/provider-registry.js";
import {
  consumeVerifiedOidcGrant,
  isVerifiedOidcGrant,
  OidcProtocolError,
  OidcProtocolService,
} from "../src/auth/oidc/protocol.js";
import { readOidcClaim } from "../src/auth/oidc/claims.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { oidcProviders } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const encryptionKey = Buffer.alloc(32, 27);
const issuer = "https://id.example.test/application/o/omnifin/";
const providerId = "oidc-home";
const checkedAt = new Date("2026-07-25T13:00:00.000Z");
const createdAt = new Date("2026-07-25T12:00:00.000Z");

function metadata(overrides: Readonly<Record<string, unknown>> = {}): ServerMetadata {
  return {
    authorization_endpoint: "https://id.example.test/application/o/authorize/",
    backchannel_logout_session_supported: true,
    backchannel_logout_supported: true,
    code_challenge_methods_supported: ["S256"],
    end_session_endpoint: "https://id.example.test/application/o/omnifin/end-session/",
    frontchannel_logout_session_supported: true,
    frontchannel_logout_supported: true,
    grant_types_supported: ["authorization_code"],
    id_token_signing_alg_values_supported: ["RS256"],
    issuer,
    jwks_uri: "https://keys.example.test/application/o/omnifin/jwks/",
    response_types_supported: ["code"],
    token_endpoint: "https://id.example.test/application/o/token/",
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    ...overrides,
  } as ServerMetadata;
}

function seedProvider(database: DatabaseHandle, clientId = "omnifin-client") {
  database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify([
        "https://id.example.test",
        "https://keys.example.test",
      ]),
      clientId,
      createdAt,
      displayName: "Home identity",
      encryptedClientSecret: new EnvelopeCipher(encryptionKey).encrypt(
        "provider-secret",
        oidcClientSecretEncryptionContext(providerId),
      ),
      id: providerId,
      issuer,
      slug: "home",
      tokenEndpointAuthMethod: "client_secret_basic",
      updatedAt: createdAt,
    })
    .run();
}

function discoveredConfiguration(
  server: ServerMetadata,
  clientId: string,
  clientMetadata: Partial<ClientMetadata> | string | undefined,
  clientAuthentication: ClientAuth | undefined,
) {
  return new Configuration(server, clientId, clientMetadata, clientAuthentication);
}

async function discoverRuntime(
  database: DatabaseHandle,
  server: ServerMetadata = metadata(),
  clock = checkedAt,
  protocolFetch: CustomFetch = vi.fn<CustomFetch>(),
) {
  return new OidcProviderRegistry(
    database,
    { encryptionKey },
    {
      clock: () => new Date(clock),
      createSafeFetch: () => protocolFetch,
      discover: async (_issuerUrl, clientId, clientMetadata, clientAuthentication) => {
        const configuration = discoveredConfiguration(
          server,
          clientId,
          clientMetadata,
          clientAuthentication,
        );
        configuration[customFetch] = protocolFetch;
        return configuration;
      },
    },
  ).discover(providerId);
}

function validClaims(nonce: string) {
  return {
    aud: "omnifin-client",
    exp: 1_900_000_000,
    iat: 1_800_000_000,
    iss: issuer,
    nonce,
    sid: "upstream-session",
    sub: "immutable-subject",
  };
}

function compactIdToken(payload = "payload") {
  return ["header", Buffer.from(payload, "utf8").toString("base64url"), "signature"].join(".");
}

function signedIdToken(
  privateKey: KeyObject,
  claims: Readonly<Record<string, unknown>>,
  algorithm = "RS256",
) {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: algorithm, kid: "signing-key", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function openProtocolHarness(protocolFetch?: CustomFetch) {
  const database = openDatabase(":memory:");
  database.migrate();
  seedProvider(database);
  const runtime = await discoverRuntime(database, metadata(), checkedAt, protocolFetch);
  const transactions = new OidcAuthorizationTransactionService(database, {
    baseUrl: new URL("https://omnifin.example"),
    encryptionKey,
    environment: "test",
    insecureLoopbackPreview: false,
    secureCookies: true,
  });
  const created = await transactions.create({
    providerId,
    providerRuntimeBinding: oidcProviderRuntimeBinding(runtime),
    returnPath: "/library",
  });
  const consumed = transactions.consume({
    browserBindingToken: created.browserBindingToken,
    providerId,
    state: created.state,
  });
  const callbackUrl = new URL(created.redirectUri);
  callbackUrl.searchParams.set("code", "authorization-code");
  callbackUrl.searchParams.set("state", created.state);
  return { callbackUrl, consumed, created, database, runtime };
}

function visibleError(error: unknown) {
  return `${String(error)}\n${error instanceof Error ? (error.stack ?? "") : ""}`;
}

async function expectProtocolRejection(
  action: () => Promise<unknown>,
  code:
    | "oidc_protocol_claims_invalid"
    | "oidc_protocol_invalid"
    | "oidc_protocol_provider_changed"
    | "oidc_protocol_token_exchange_failed",
  secrets: readonly string[] = [],
) {
  try {
    await action();
    throw new Error("Expected OIDC protocol rejection.");
  } catch (error) {
    expect(error).toBeInstanceOf(OidcProtocolError);
    expect(error).toMatchObject({ code });
    for (const secret of secrets) expect(visibleError(error)).not.toContain(secret);
  }
}

function expectProtocolThrow(
  action: () => unknown,
  code:
    | "oidc_protocol_claims_invalid"
    | "oidc_protocol_invalid"
    | "oidc_protocol_provider_changed"
    | "oidc_protocol_token_exchange_failed",
  secrets: readonly string[] = [],
) {
  try {
    action();
    throw new Error("Expected OIDC protocol rejection.");
  } catch (error) {
    expect(error).toBeInstanceOf(OidcProtocolError);
    expect(error).toMatchObject({ code });
    for (const secret of secrets) expect(visibleError(error)).not.toContain(secret);
  }
}

describe("OidcProtocolService", () => {
  it("builds one exact query-mode authorization request and completes with exact checks", async () => {
    const harness = await openProtocolHarness();
    try {
      const accessTokenCanary = "access-token-must-not-escape";
      const refreshTokenCanary = "refresh-token-must-not-escape";
      const grant = vi.fn(async (_runtime, _currentUrl, checks) => ({
        access_token: accessTokenCanary,
        claims: validClaims(checks.expectedNonce as string),
        idToken: compactIdToken(),
        refresh_token: refreshTokenCanary,
      }));
      const protocol = new OidcProtocolService({ authorizationCodeGrant: grant });

      const redirect = protocol.buildAuthorizationRequest(harness.runtime, harness.created);
      const authorizationUrl = new URL(redirect.authorizationUrl);

      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
        "https://id.example.test/application/o/authorize/",
      );
      expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
        client_id: "omnifin-client",
        code_challenge: harness.created.codeChallenge,
        code_challenge_method: "S256",
        nonce: harness.created.nonce,
        redirect_uri: harness.created.redirectUri,
        response_mode: "query",
        response_type: "code",
        scope: "openid profile email",
        state: harness.created.state,
      });
      expect(authorizationUrl.searchParams.getAll("state")).toHaveLength(1);
      expect(authorizationUrl.hash).toBe("");

      const verifiedGrant = await protocol.completeAuthorization({
        callbackUrl: harness.callbackUrl,
        runtime: harness.runtime,
        transaction: harness.consumed,
      });

      expect(grant).toHaveBeenCalledTimes(1);
      expect(grant.mock.calls[0]?.[1]).not.toBe(harness.callbackUrl);
      expect(grant.mock.calls[0]?.[1].href).toBe(harness.callbackUrl.href);
      expect(grant.mock.calls[0]?.[2]).toEqual({
        expectedNonce: harness.consumed.nonce,
        expectedState: harness.created.state,
        idTokenExpected: true,
        pkceCodeVerifier: harness.consumed.codeVerifier,
      });
      expect(isVerifiedOidcGrant(verifiedGrant)).toBe(true);
      expect(Object.keys(verifiedGrant)).toEqual([]);
      expect(Object.isFrozen(verifiedGrant)).toBe(true);
      expect(() => JSON.stringify(verifiedGrant)).toThrow(
        "Verified OIDC grants cannot be serialized.",
      );
      const visibleGrant = `${Object.getOwnPropertyNames(verifiedGrant).join(",")}${Object.getOwnPropertySymbols(verifiedGrant).map(String).join(",")}`;
      expect(visibleGrant).not.toContain(accessTokenCanary);
      expect(visibleGrant).not.toContain(refreshTokenCanary);
    } finally {
      harness.database.close();
    }
  });

  it("rejects an oversized composed authorization URL during the pre-allocation probe", async () => {
    const database = openDatabase(":memory:");
    database.migrate();
    seedProvider(database);
    const scopes = ["openid"];
    while (scopes.join(" ").length < 1_900) {
      scopes.push(`scope-${scopes.length}-${"a".repeat(110)}`);
    }
    database.db
      .update(oidcProviders)
      .set({ scopes: scopes.join(" ") })
      .run();
    const oversizedEndpoint = `https://id.example.test/${"authorize".repeat(300)}`;

    try {
      const runtime = await discoverRuntime(
        database,
        metadata({ authorization_endpoint: oversizedEndpoint }),
      );
      const protocol = new OidcProtocolService();

      expectProtocolThrow(
        () =>
          protocol.assertAuthorizationRequestViable(runtime, {
            providerId,
            redirectUri: `https://omnifin.example/api/auth/oidc/callback/${providerId}`,
          }),
        "oidc_protocol_invalid",
      );
    } finally {
      database.close();
    }
  });

  it("relies on openid-client for signature, issuer, audience, expiry, nonce, and multi-audience azp checks", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const attackerKey = generateKeyPairSync("rsa", { modulusLength: 2_048 }).privateKey;
    const publicJwk = publicKey.export({ format: "jwk" });
    let currentIdToken = "";
    const protocolFetch: CustomFetch = async (input) => {
      const url = String(input);
      if (url === "https://id.example.test/application/o/token/") {
        return new Response(
          JSON.stringify({
            access_token: "discarded-access-token",
            id_token: currentIdToken,
            token_type: "Bearer",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }
      if (url === "https://keys.example.test/application/o/omnifin/jwks/") {
        return new Response(
          JSON.stringify({
            keys: [{ ...publicJwk, alg: "RS256", kid: "signing-key", use: "sig" }],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }
      throw new Error("Unexpected OIDC protocol endpoint.");
    };
    const harness = await openProtocolHarness(protocolFetch);
    try {
      const now = Math.floor(Date.now() / 1_000);
      const baseClaims = {
        aud: ["omnifin-client", "media-api"],
        azp: "omnifin-client",
        exp: now + 300,
        iat: now,
        iss: issuer,
        nonce: harness.consumed.nonce,
        sub: "immutable-subject",
      };
      const protocol = new OidcProtocolService();
      currentIdToken = signedIdToken(privateKey, baseClaims);

      const verifiedGrant = await protocol.completeAuthorization({
        callbackUrl: harness.callbackUrl,
        runtime: harness.runtime,
        transaction: harness.consumed,
      });
      expect(isVerifiedOidcGrant(verifiedGrant)).toBe(true);
      const material = consumeVerifiedOidcGrant(verifiedGrant);
      expect(readOidcClaim(material.claims, ["aud"])).toEqual(["omnifin-client", "media-api"]);
      expect(material.clientId).toBe("omnifin-client");

      const invalidTokens = [
        signedIdToken(privateKey, { ...baseClaims, azp: undefined }),
        signedIdToken(privateKey, { ...baseClaims, azp: "another-client" }),
        signedIdToken(privateKey, { ...baseClaims, aud: "another-client" }),
        signedIdToken(privateKey, { ...baseClaims, exp: now - 300 }),
        signedIdToken(privateKey, { ...baseClaims, iss: "https://evil.example/" }),
        signedIdToken(privateKey, { ...baseClaims, nonce: "wrong-nonce" }),
        signedIdToken(privateKey, baseClaims, "PS256"),
        signedIdToken(attackerKey, baseClaims),
      ];
      for (const invalidToken of invalidTokens) {
        currentIdToken = invalidToken;
        await expectProtocolRejection(
          () =>
            protocol.completeAuthorization({
              callbackUrl: harness.callbackUrl,
              runtime: harness.runtime,
              transaction: harness.consumed,
            }),
          "oidc_protocol_token_exchange_failed",
          [invalidToken],
        );
      }
    } finally {
      harness.database.close();
    }
  });

  it("rejects callback origin, port, path, fragment, missing state, duplicate state, and mismatch before exchange", async () => {
    const harness = await openProtocolHarness();
    try {
      const grant = vi.fn(async () => ({
        claims: validClaims(harness.consumed.nonce),
        idToken: compactIdToken(),
      }));
      const protocol = new OidcProtocolService({ authorizationCodeGrant: grant });
      const invalidCallbacks = [
        new URL(harness.callbackUrl.href.replace("omnifin.example", "evil.example")),
        new URL(harness.callbackUrl.href.replace("omnifin.example", "omnifin.example:444")),
        new URL(harness.callbackUrl.href.replace("/callback/", "/wrong/")),
        new URL(`${harness.callbackUrl.href}#response`),
        new URL(`${harness.created.redirectUri}?code=authorization-code`),
        new URL(`${harness.callbackUrl.href}&state=${harness.created.state}`),
        new URL(
          `${harness.created.redirectUri}?code=authorization-code&state=${Buffer.alloc(32, 1).toString("base64url")}`,
        ),
      ];

      for (const callbackUrl of invalidCallbacks) {
        await expectProtocolRejection(
          () =>
            protocol.completeAuthorization({
              callbackUrl,
              runtime: harness.runtime,
              transaction: harness.consumed,
            }),
          "oidc_protocol_invalid",
        );
      }
      expect(grant).not.toHaveBeenCalled();
    } finally {
      harness.database.close();
    }
  });

  it("rejects provider and runtime-binding mix-ups before building or exchanging", async () => {
    const harness = await openProtocolHarness();
    try {
      const protocol = new OidcProtocolService({
        authorizationCodeGrant: vi.fn(async () => ({
          claims: validClaims(harness.consumed.nonce),
          idToken: compactIdToken(),
        })),
      });
      const differentBinding = Buffer.alloc(32, 99).toString("base64url");

      expectProtocolThrow(
        () =>
          protocol.buildAuthorizationRequest(harness.runtime, {
            ...harness.created,
            providerRuntimeBinding:
              differentBinding as typeof harness.created.providerRuntimeBinding,
          }),
        "oidc_protocol_provider_changed",
      );
      await expectProtocolRejection(
        () =>
          protocol.completeAuthorization({
            callbackUrl: harness.callbackUrl,
            runtime: harness.runtime,
            transaction: {
              ...harness.consumed,
              providerRuntimeBinding:
                differentBinding as typeof harness.consumed.providerRuntimeBinding,
            },
          }),
        "oidc_protocol_provider_changed",
      );
      expectProtocolThrow(
        () =>
          protocol.buildAuthorizationRequest(harness.runtime, {
            ...harness.created,
            providerId: "oidc-work",
          }),
        "oidc_protocol_invalid",
      );
    } finally {
      harness.database.close();
    }
  });

  it("maps exchange failures to a context-free error without retaining response secrets", async () => {
    const harness = await openProtocolHarness();
    try {
      const authorizationCode = "private-authorization-code";
      const tokenBody = "private-token-response";
      const callbackUrl = new URL(harness.callbackUrl);
      callbackUrl.searchParams.set("code", authorizationCode);
      const protocol = new OidcProtocolService({
        authorizationCodeGrant: async () => {
          throw new Error(`${tokenBody}:${authorizationCode}`);
        },
      });

      await expectProtocolRejection(
        () =>
          protocol.completeAuthorization({
            callbackUrl,
            runtime: harness.runtime,
            transaction: harness.consumed,
          }),
        "oidc_protocol_token_exchange_failed",
        [authorizationCode, tokenBody],
      );
    } finally {
      harness.database.close();
    }
  });

  it("rejects absent, malformed, oversized, and claim-invalid ID tokens", async () => {
    const harness = await openProtocolHarness();
    try {
      const failures = [
        { claims: validClaims(harness.consumed.nonce), idToken: undefined },
        { claims: validClaims(harness.consumed.nonce), idToken: "not-a-compact-token" },
        {
          claims: validClaims(harness.consumed.nonce),
          idToken: compactIdToken("x".repeat(16 * 1_024)),
        },
        { claims: { iss: issuer }, idToken: compactIdToken() },
      ];
      for (const result of failures) {
        const protocol = new OidcProtocolService({
          authorizationCodeGrant: async () => result,
        });
        await expectProtocolRejection(
          () =>
            protocol.completeAuthorization({
              callbackUrl: harness.callbackUrl,
              runtime: harness.runtime,
              transaction: harness.consumed,
            }),
          "oidc_protocol_claims_invalid",
        );
      }
    } finally {
      harness.database.close();
    }
  });

  it("releases minimal grant material once and rejects forged, copied, proxied, or replayed grants", async () => {
    const harness = await openProtocolHarness();
    try {
      const idTokenHint = compactIdToken("private-id-token-hint");
      const protocol = new OidcProtocolService({
        authorizationCodeGrant: async () => ({
          claims: validClaims(harness.consumed.nonce),
          idToken: idTokenHint,
        }),
      });
      const grant = await protocol.completeAuthorization({
        callbackUrl: harness.callbackUrl,
        runtime: harness.runtime,
        transaction: harness.consumed,
      });
      const copiedSymbols = Object.create(null) as Record<PropertyKey, unknown>;
      for (const symbol of Object.getOwnPropertySymbols(grant)) copiedSymbols[symbol] = true;

      const invalidGrants = [
        {},
        { ...grant },
        Object.create(grant),
        copiedSymbols,
        new Proxy(grant, {}),
      ];
      for (const invalidGrant of invalidGrants) {
        expect(isVerifiedOidcGrant(invalidGrant)).toBe(false);
        expectProtocolThrow(() => consumeVerifiedOidcGrant(invalidGrant), "oidc_protocol_invalid", [
          idTokenHint,
          "upstream-session",
          "immutable-subject",
        ]);
      }

      expect(isVerifiedOidcGrant(grant)).toBe(true);
      const material = consumeVerifiedOidcGrant(grant);

      expect(material.claims.subject).toBe("immutable-subject");
      expect(material.clientId).toBe("omnifin-client");
      expect(material.idTokenHint).toBe(idTokenHint);
      expect(material.issuer).toBe(issuer);
      expect(material.providerId).toBe(providerId);
      expect(material.providerRuntimeBinding).toBe(oidcProviderRuntimeBinding(harness.runtime));
      expect(material.sessionId).toBe("upstream-session");
      expect(Object.getPrototypeOf(material)).toBeNull();
      expect(Object.isFrozen(material)).toBe(true);
      expect(Object.keys(material)).toEqual([]);
      expect(Object.getOwnPropertyDescriptor(material, "idTokenHint")?.enumerable).toBe(false);
      expect(() => JSON.stringify(material)).toThrow(
        "Consumed OIDC grant material cannot be serialized.",
      );

      expect(isVerifiedOidcGrant(grant)).toBe(false);
      expectProtocolThrow(() => consumeVerifiedOidcGrant(grant), "oidc_protocol_invalid", [
        idTokenHint,
        "upstream-session",
        "immutable-subject",
      ]);
    } finally {
      harness.database.close();
    }
  });

  it("derives a stable runtime binding that changes with exact validated endpoints", async () => {
    const firstDatabase = openDatabase(":memory:");
    try {
      firstDatabase.migrate();
      seedProvider(firstDatabase);
      const first = await discoverRuntime(firstDatabase, metadata(), checkedAt);
      const rediscovered = await discoverRuntime(
        firstDatabase,
        metadata(),
        new Date(checkedAt.getTime() + 60_000),
      );
      const changedRuntimes: OidcProviderRuntime[] = [];
      const endpointOverrides = [
        { authorization_endpoint: "https://id.example.test/application/o/alternate-authorize/" },
        { token_endpoint: "https://id.example.test/application/o/alternate-token/" },
        { jwks_uri: "https://keys.example.test/application/o/omnifin/alternate-jwks/" },
        {
          end_session_endpoint:
            "https://id.example.test/application/o/omnifin/alternate-end-session/",
        },
      ];
      for (const [index, overrides] of endpointOverrides.entries()) {
        changedRuntimes.push(
          await discoverRuntime(
            firstDatabase,
            metadata(overrides),
            new Date(checkedAt.getTime() + (index + 2) * 60_000),
          ),
        );
      }

      expect(oidcProviderRuntimeBinding(first)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(oidcProviderRuntimeBinding(rediscovered)).toBe(oidcProviderRuntimeBinding(first));
      for (const changed of changedRuntimes) {
        expect(oidcProviderRuntimeBinding(changed)).not.toBe(oidcProviderRuntimeBinding(first));
      }

      firstDatabase.sqlite
        .prepare("update oidc_providers set scopes = 'openid email' where id = ?")
        .run(providerId);
      const changedConfiguration = await discoverRuntime(
        firstDatabase,
        metadata(),
        new Date(checkedAt.getTime() + 10 * 60_000),
      );
      expect(oidcProviderRuntimeBinding(changedConfiguration)).not.toBe(
        oidcProviderRuntimeBinding(first),
      );
    } finally {
      firstDatabase.close();
    }
  });

  it("builds RP-initiated logout only through the runtime's validated endpoint", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const runtime: OidcProviderRuntime = await discoverRuntime(database);
      const url = buildOidcRuntimeEndSessionUrl(runtime, {
        id_token_hint: compactIdToken(),
        post_logout_redirect_uri: "https://omnifin.example/api/auth/oidc/logout/callback",
        state: Buffer.alloc(32, 7).toString("base64url"),
      });

      expect(url.origin + url.pathname).toBe(
        "https://id.example.test/application/o/omnifin/end-session/",
      );
      expect(url.searchParams.get("client_id")).toBe("omnifin-client");
      expect(url.searchParams.get("id_token_hint")).toBe(compactIdToken());
    } finally {
      database.close();
    }
  });
});
