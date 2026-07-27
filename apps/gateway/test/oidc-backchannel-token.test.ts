import { generateKeyPairSync, sign } from "node:crypto";
import {
  Configuration,
  customFetch,
  type ClientAuth,
  type ClientMetadata,
  type CustomFetch,
  type DiscoveryRequestOptions,
  type ServerMetadata,
} from "openid-client";
import { describe, expect, it } from "vitest";
import {
  OidcProviderRegistry,
  verifyOidcRuntimeBackchannelLogoutToken,
} from "../src/auth/oidc/provider-registry.js";
import { openDatabase } from "../src/db/client.js";
import { oidcProviders } from "../src/db/schema.js";
import { OidcSafeFetchError } from "../src/auth/oidc/safe-fetch.js";

const providerId = "oidc-home";
const issuer = "https://identity.example.test/application/o/omnifin/";
const clientId = "omnifin-client";
const now = new Date("2026-07-26T18:30:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "primary",
  use: "sig",
};

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedLogoutToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "primary", typ: "logout+jwt" },
) {
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  return {
    aud: clientId,
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    exp: nowSeconds + 300,
    iat: nowSeconds - 1,
    iss: issuer,
    jti: "provider-logout-token-1",
    sid: "provider-session-1",
    sub: "immutable-subject-1",
    ...overrides,
  };
}

function metadata(): ServerMetadata {
  return {
    authorization_endpoint: "https://identity.example.test/application/o/authorize/",
    backchannel_logout_session_supported: true,
    backchannel_logout_supported: true,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"],
    id_token_signing_alg_values_supported: ["RS256"],
    issuer,
    jwks_uri: "https://identity.example.test/application/o/omnifin/jwks/",
    response_types_supported: ["code"],
    token_endpoint: "https://identity.example.test/application/o/token/",
    token_endpoint_auth_methods_supported: ["none"],
  } as ServerMetadata;
}

async function openRuntime(providerFetchOverride?: CustomFetch) {
  const database = openDatabase(":memory:");
  database.migrate();
  database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(["https://identity.example.test"]),
      clientId,
      createdAt: new Date(now.getTime() - 60_000),
      displayName: "Home identity",
      id: providerId,
      issuer,
      slug: "home",
      updatedAt: new Date(now.getTime() - 60_000),
    })
    .run();
  const providerFetch: CustomFetch =
    providerFetchOverride ??
    (async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }));
  const registry = new OidcProviderRegistry(
    database,
    { encryptionKey: Buffer.alloc(32, 91) },
    {
      clock: () => new Date(now),
      createSafeFetch: () => providerFetch,
      discover: async (
        _server: URL,
        discoveredClientId: string,
        clientMetadata: Partial<ClientMetadata> | string | undefined,
        clientAuthentication: ClientAuth | undefined,
        options: DiscoveryRequestOptions | undefined,
      ) => {
        const configuration = new Configuration(
          metadata(),
          discoveredClientId,
          clientMetadata,
          clientAuthentication,
        );
        const configuredFetch = options?.[customFetch];
        if (configuredFetch) configuration[customFetch] = configuredFetch;
        return configuration;
      },
    },
  );
  return { database, runtime: await registry.discover(providerId) };
}

describe("OIDC back-channel logout-token verification", () => {
  it("verifies a signed, explicitly typed logout token against the bound provider runtime", async () => {
    const { database, runtime } = await openRuntime();
    try {
      const result = await verifyOidcRuntimeBackchannelLogoutToken(
        runtime,
        signedLogoutToken(baseClaims()),
        now,
      );

      expect(result).toEqual({
        expiresAt: new Date(now.getTime() + 300_000),
        issuedAt: new Date(now.getTime() - 1_000),
        issuer,
        sessionId: "provider-session-1",
        subject: "immutable-subject-1",
        tokenId: "provider-logout-token-1",
      });
      expect(JSON.stringify(result)).not.toContain("signature");
    } finally {
      database.close();
    }
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.example/" }, undefined],
    ["wrong audience", { aud: "another-client" }, undefined],
    ["multiple audiences", { aud: [clientId, "another-client"] }, undefined],
    ["expired", { exp: Math.floor(now.getTime() / 1_000) }, undefined],
    [
      "an expiry before the issued-at time",
      {
        exp: Math.floor(now.getTime() / 1_000) + 30,
        iat: Math.floor(now.getTime() / 1_000) + 60,
      },
      undefined,
    ],
    ["missing expiry", { exp: undefined }, undefined],
    ["stale issued-at", { iat: Math.floor(now.getTime() / 1_000) - 301 }, undefined],
    ["missing token identifier", { jti: undefined }, undefined],
    ["forbidden nonce", { nonce: "authentication-nonce" }, undefined],
    ["missing logout event", { events: {} }, undefined],
    [
      "non-object logout event",
      { events: { "http://schemas.openid.net/event/backchannel-logout": true } },
      undefined,
    ],
    ["missing subject and session", { sid: undefined, sub: undefined }, undefined],
    ["wrong explicit type", {}, { alg: "RS256", kid: "primary", typ: "JWT" }],
  ])(
    "rejects %s without returning provider assertion details",
    async (_name, overrides, header) => {
      const { database, runtime } = await openRuntime();
      try {
        const token = signedLogoutToken(baseClaims(overrides), header);
        await expect(
          verifyOidcRuntimeBackchannelLogoutToken(runtime, token, now),
        ).rejects.toMatchObject({ code: "oidc_provider_logout_token_invalid" });
      } finally {
        database.close();
      }
    },
  );

  it("marks a bounded JWKS transport outage as retryable without retaining its details", async () => {
    const { database, runtime } = await openRuntime(async () => {
      throw new OidcSafeFetchError("oidc_timeout", true);
    });
    try {
      await expect(
        verifyOidcRuntimeBackchannelLogoutToken(runtime, signedLogoutToken(baseClaims()), now),
      ).rejects.toMatchObject({
        code: "oidc_provider_logout_token_invalid",
        retryable: true,
      });
    } finally {
      database.close();
    }
  });
});
