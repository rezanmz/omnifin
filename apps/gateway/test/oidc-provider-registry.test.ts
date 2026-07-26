import {
  Configuration,
  authorizationCodeGrant,
  customFetch,
  type ClientAuth,
  type ClientMetadata,
  type CustomFetch,
  type ServerMetadata,
} from "openid-client";
import { describe, expect, it, vi } from "vitest";
import {
  OIDC_PROVIDER_RUNTIME_CACHE_MAX_ENTRIES,
  OIDC_PROVIDER_RUNTIME_CACHE_TTL_MS,
  OidcProviderRegistry,
  oidcClientSecretEncryptionContext,
  oidcProviderRuntimeBinding,
  type OidcProviderRegistryDependencies,
} from "../src/auth/oidc/provider-registry.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { oidcProviders } from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const encryptionKey = Buffer.alloc(32, 19);
const clientSecret = "provider-secret-value";
const initialTime = new Date("2026-07-25T12:00:00.000Z");
const checkedTime = new Date("2026-07-25T13:00:00.000Z");
const providerId = "oidc-home";
const issuer = "https://id.example.test/application/o/omnifin/";
const approvedOrigins = ["https://id.example.test", "https://keys.example.test"];

type ProviderInsert = typeof oidcProviders.$inferInsert;

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
    userinfo_endpoint: "https://id.example.test/application/o/userinfo/",
    ...overrides,
  } as ServerMetadata;
}

function metadataForIssuer(issuerValue: string): ServerMetadata {
  const origin = new URL(issuerValue).origin;
  return metadata({
    authorization_endpoint: `${origin}/authorize`,
    end_session_endpoint: `${origin}/end-session`,
    issuer: issuerValue,
    jwks_uri: `${origin}/jwks`,
    token_endpoint: `${origin}/token`,
    userinfo_endpoint: `${origin}/userinfo`,
  });
}

function unverifiableIdToken(): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return [
    encode({ alg: "RS256", kid: "missing-key", typ: "JWT" }),
    encode({
      aud: "omnifin-client",
      exp: now + 300,
      iat: now,
      iss: issuer,
      nonce: "expected-nonce",
      sub: "immutable-subject",
    }),
    Buffer.from("invalid-signature", "utf8").toString("base64url"),
  ].join(".");
}

function openHarness(): DatabaseHandle {
  const database = openDatabase(":memory:");
  database.migrate();
  return database;
}

function seedProvider(database: DatabaseHandle, overrides: Partial<ProviderInsert> = {}): void {
  const id = overrides.id ?? providerId;
  const tokenEndpointAuthMethod = overrides.tokenEndpointAuthMethod ?? "client_secret_basic";
  const encryptedClientSecret = Object.hasOwn(overrides, "encryptedClientSecret")
    ? overrides.encryptedClientSecret
    : tokenEndpointAuthMethod === "none"
      ? null
      : new EnvelopeCipher(encryptionKey).encrypt(
          clientSecret,
          oidcClientSecretEncryptionContext(id),
        );

  database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson: JSON.stringify(approvedOrigins),
      clientId: "omnifin-client",
      createdAt: initialTime,
      displayName: "Home identity",
      encryptedClientSecret,
      id,
      issuer,
      slug: `home-${id}`,
      tokenEndpointAuthMethod,
      updatedAt: initialTime,
      ...overrides,
    })
    .run();
}

function configuration(
  server: ServerMetadata,
  clientId = "omnifin-client",
  clientMetadata: Partial<ClientMetadata> | string | undefined = {},
  clientAuthentication?: ClientAuth,
): Configuration {
  return new Configuration(server, clientId, clientMetadata, clientAuthentication);
}

function registry(
  database: DatabaseHandle,
  server: ServerMetadata = metadata(),
  dependencies: OidcProviderRegistryDependencies = {},
): OidcProviderRegistry {
  return new OidcProviderRegistry(
    database,
    { encryptionKey },
    {
      clock: () => checkedTime,
      createSafeFetch: () => vi.fn<CustomFetch>(),
      discover: async (_server, clientId, clientMetadata, clientAuthentication) =>
        configuration(server, clientId, clientMetadata, clientAuthentication),
      ...dependencies,
    },
  );
}

function persistedProvider(database: DatabaseHandle) {
  return database.db.select().from(oidcProviders).get();
}

function expectFailedWithoutDetails(database: DatabaseHandle): void {
  const stored = persistedProvider(database);
  expect(stored).toMatchObject({
    discoveryCapabilitiesJson: "{}",
    discoveryCheckedAt: checkedTime,
    discoveryState: "failed",
    updatedAt: initialTime,
  });
  expect(JSON.stringify(stored)).not.toContain(clientSecret);
}

describe("OidcProviderRegistry", () => {
  it("discovers from the exact issuer through the bounded custom fetch and persists only capabilities", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      const requests: Array<{ input: string; method: string; redirect: string }> = [];
      const providerFetch: CustomFetch = async (input, options) => {
        requests.push({ input, method: options.method, redirect: options.redirect });
        return new Response(JSON.stringify(metadata()), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      };
      const createSafeFetch = vi.fn(() => providerFetch);
      const service = new OidcProviderRegistry(
        database,
        { encryptionKey },
        { clock: () => checkedTime, createSafeFetch },
      );

      const runtime = await service.discover(providerId);

      expect(requests).toEqual([
        {
          input: "https://id.example.test/application/o/omnifin/.well-known/openid-configuration",
          method: "GET",
          redirect: "manual",
        },
      ]);
      expect(createSafeFetch).toHaveBeenCalledWith({ approvedOrigins });
      expect(runtime.provider).toEqual({
        allowJitProvisioning: true,
        capabilities: {
          authorizationCodeFlow: true,
          idTokenSigningAlg: "RS256",
          logout: {
            backChannel: true,
            backChannelSession: true,
            frontChannel: true,
            frontChannelSession: true,
            rpInitiated: true,
          },
          pkceS256: true,
          schemaVersion: 1,
          tokenEndpointAuthMethod: "client_secret_basic",
          userInfo: true,
        },
        checkedAt: checkedTime,
        clientId: "omnifin-client",
        displayName: "Home identity",
        id: providerId,
        issuer,
        scopes: ["openid", "profile", "email"],
      });
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(Object.isFrozen(runtime.provider)).toBe(true);
      expect(Object.isFrozen(runtime.provider.capabilities)).toBe(true);
      expect(Object.isFrozen(runtime.provider.capabilities.logout)).toBe(true);
      expect(Object.keys(runtime)).toEqual(["provider"]);
      expect(Reflect.ownKeys(runtime)).toEqual(["provider"]);
      expect(oidcProviderRuntimeBinding(runtime)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect("configuration" in runtime).toBe(false);
      expect((runtime as unknown as Record<PropertyKey, unknown>)[customFetch]).toBeUndefined();
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "configuration"),
      ).toBeUndefined();
      expect(() => JSON.stringify(runtime)).toThrowError(
        "OIDC provider runtime handles cannot be serialized.",
      );
      const stored = persistedProvider(database);
      expect(stored).toMatchObject({
        discoveryCheckedAt: checkedTime,
        discoveryState: "ready",
        updatedAt: initialTime,
      });
      expect(JSON.parse(stored?.discoveryCapabilitiesJson ?? "null")).toEqual(
        runtime.provider.capabilities,
      );
      const publicAndPersisted = `${JSON.stringify(runtime.provider)}${JSON.stringify(stored)}`;
      expect(publicAndPersisted).not.toContain(clientSecret);
      expect(publicAndPersisted).not.toContain("authorization_endpoint");
      expect(publicAndPersisted).not.toContain("jwks_uri");
    } finally {
      database.close();
    }
  });

  it("enables ID-token signature validation while preserving the configured asymmetric algorithm", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      let capturedConfiguration: Configuration | undefined;
      let jwksRequests = 0;
      const protocolFetch: CustomFetch = async (input) => {
        if (input === "https://id.example.test/application/o/token/") {
          return new Response(
            JSON.stringify({
              access_token: "short-lived-access-token",
              id_token: unverifiableIdToken(),
              token_type: "Bearer",
            }),
            {
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
                pragma: "no-cache",
              },
              status: 200,
            },
          );
        }
        if (input === "https://keys.example.test/application/o/omnifin/jwks/") {
          jwksRequests += 1;
          return new Response('{"keys":[]}', {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        }
        throw new Error("Unexpected protocol request.");
      };
      const service = registry(database, metadata(), {
        discover: async (_server, clientId, clientMetadata, clientAuthentication) => {
          capturedConfiguration = configuration(
            metadata(),
            clientId,
            clientMetadata,
            clientAuthentication,
          );
          capturedConfiguration[customFetch] = protocolFetch;
          return capturedConfiguration;
        },
      });

      const runtime = await service.discover(providerId);
      expect("configuration" in runtime).toBe(false);
      expect(capturedConfiguration?.clientMetadata().id_token_signed_response_alg).toBe("RS256");
      await expect(
        authorizationCodeGrant(
          capturedConfiguration as Configuration,
          new URL("https://omnifin.example.test/callback?code=code-1&state=state-1"),
          {
            expectedNonce: "expected-nonce",
            expectedState: "state-1",
            pkceCodeVerifier: "v".repeat(43),
          },
        ),
      ).rejects.toBeDefined();
      expect(jwksRequests).toBe(1);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      assertAuth(body: URLSearchParams, headers: Headers) {
        const authorization = headers.get("authorization");
        expect(authorization).toMatch(/^Basic [A-Za-z0-9+/]+=*$/);
        const encodedCredentials = Buffer.from(authorization?.slice(6) ?? "", "base64").toString(
          "utf8",
        );
        const separator = encodedCredentials.indexOf(":");
        expect(decodeURIComponent(encodedCredentials.slice(0, separator))).toBe("omnifin-client");
        expect(decodeURIComponent(encodedCredentials.slice(separator + 1))).toBe(clientSecret);
        expect(body.toString()).toBe("");
      },
      method: "client_secret_basic" as const,
    },
    {
      assertAuth(body: URLSearchParams, headers: Headers) {
        expect(headers.has("authorization")).toBe(false);
        expect(body.toString()).toBe(
          `client_id=omnifin-client&client_secret=${encodeURIComponent(clientSecret)}`,
        );
      },
      method: "client_secret_post" as const,
    },
    {
      assertAuth(body: URLSearchParams, headers: Headers) {
        expect(headers.has("authorization")).toBe(false);
        expect(body.toString()).toBe("client_id=omnifin-client");
      },
      method: "none" as const,
    },
  ])(
    "selects $method explicitly without putting the secret in client metadata",
    async (fixture) => {
      const database = openHarness();
      try {
        seedProvider(database, { tokenEndpointAuthMethod: fixture.method });
        let capturedAuthentication: ClientAuth | undefined;
        let capturedConfiguration: Configuration | undefined;
        let capturedMetadata: Partial<ClientMetadata> | string | undefined;
        let capturedOptions: Parameters<
          NonNullable<OidcProviderRegistryDependencies["discover"]>
        >[4];
        const providerFetch = vi.fn<CustomFetch>();
        const service = registry(
          database,
          metadata({ token_endpoint_auth_methods_supported: [fixture.method] }),
          {
            createSafeFetch: () => providerFetch,
            discover: async (_server, clientId, clientMetadata, clientAuthentication, options) => {
              capturedAuthentication = clientAuthentication;
              capturedMetadata = clientMetadata;
              capturedOptions = options;
              capturedConfiguration = configuration(
                metadata({ token_endpoint_auth_methods_supported: [fixture.method] }),
                clientId,
                clientMetadata,
                clientAuthentication,
              );
              return capturedConfiguration;
            },
          },
        );

        const runtime = await service.discover(providerId);

        expect(capturedConfiguration?.clientMetadata().client_secret).toBeUndefined();
        expect(Object.values(runtime)).not.toContain(capturedConfiguration);
        expect(capturedMetadata).toEqual({
          grant_types: ["authorization_code"],
          id_token_signed_response_alg: "RS256",
          response_types: ["code"],
          token_endpoint_auth_method: fixture.method,
        });
        expect(JSON.stringify(capturedMetadata)).not.toContain(clientSecret);
        expect(capturedOptions).toMatchObject({ algorithm: "oidc", timeout: 8 });
        expect(capturedOptions?.[customFetch]).toBe(providerFetch);
        const body = new URLSearchParams();
        const headers = new Headers();
        expect(capturedAuthentication).toBeTypeOf("function");
        capturedAuthentication?.(metadata(), { client_id: "omnifin-client" }, body, headers);
        fixture.assertAuth(body, headers);
      } finally {
        database.close();
      }
    },
  );

  it.each([
    ["profile email", "missing openid"],
    ["openid offline_access", "offline access"],
    ["openid OFFLINE_ACCESS", "case-disguised offline access"],
    ["openid openid", "duplicate scope"],
    ["openid  email", "non-canonical separators"],
    ["openid\temail", "non-space separators"],
    [`openid ${"x".repeat(129)}`, "oversized scope"],
    [
      `openid ${Array.from({ length: 32 }, (_, index) => `s${index}`).join(" ")}`,
      "too many scopes",
    ],
  ])("rejects unsafe scope configuration: %s (%s)", async (scopes) => {
    const database = openHarness();
    try {
      seedProvider(database, { scopes });
      const discover = vi.fn<NonNullable<OidcProviderRegistryDependencies["discover"]>>();

      await expect(
        registry(database, metadata(), { discover }).discover(providerId),
      ).rejects.toMatchObject({ code: "oidc_provider_misconfigured" });

      expect(discover).not.toHaveBeenCalled();
      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  it.each([
    ["[]", "empty list"],
    ["[1]", "non-string origin"],
    ['["http://id.example.test"]', "insecure origin"],
    ['["https://id.example.test/path"]', "origin with path"],
    ['["https://id.example.test/ "]', "non-canonical origin"],
    ['["https://id.example.test","https://id.example.test"]', "duplicate origin"],
  ])("rejects unsafe approved-origin configuration: %s (%s)", async (originsJson) => {
    const database = openHarness();
    try {
      seedProvider(database, { approvedEndpointOriginsJson: originsJson });

      await expect(registry(database).discover(providerId)).rejects.toMatchObject({
        code: "oidc_provider_misconfigured",
      });

      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  it.each([
    ["http://id.example.test/application/o/omnifin/", "insecure issuer"],
    [
      "https://id.example.test/application/o/omnifin/.well-known/openid-configuration",
      "discovery-document issuer",
    ],
    ["https://unapproved.example.test/application/o/omnifin/", "unapproved issuer origin"],
    ["https://id.example.test/application/o/omnifin/?tenant=one", "issuer query"],
    ["https://id.example.test", "missing canonical root slash"],
    ["https://ID.EXAMPLE.TEST/application/o/omnifin/", "uppercase host alias"],
    ["HTTPS://id.example.test/application/o/omnifin/", "uppercase scheme alias"],
    ["https://id.example.test:443/application/o/omnifin/", "explicit default port alias"],
    ["https://id.example.test/application/o/../omnifin/", "dot-segment alias"],
  ])("rejects an invalid issuer URL: %s (%s)", async (invalidIssuer) => {
    const database = openHarness();
    try {
      seedProvider(database, { issuer: invalidIssuer });

      await expect(registry(database).discover(providerId)).rejects.toMatchObject({
        code: "oidc_provider_misconfigured",
      });

      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  const unsafeMetadataFixtures: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
    [{ issuer: "https://id.example.test/application/o/other/" }, "issuer mismatch"],
    [{ authorization_endpoint: "http://id.example.test/authorize" }, "insecure authorization"],
    [{ token_endpoint: "https://unapproved.example.test/token" }, "unapproved token endpoint"],
    [{ jwks_uri: undefined }, "missing JWKS endpoint"],
    [{ response_types_supported: ["id_token"] }, "implicit-only response"],
    [{ grant_types_supported: ["implicit"] }, "missing authorization-code grant"],
    [{ code_challenge_methods_supported: ["plain"] }, "missing S256"],
    [{ token_endpoint_auth_methods_supported: ["none"] }, "wrong client authentication"],
    [{ id_token_signing_alg_values_supported: ["HS256"] }, "wrong ID-token algorithm"],
    [{ frontchannel_logout_supported: "true" }, "malformed logout advertisement"],
  ];

  it.each(unsafeMetadataFixtures)(
    "rejects unsafe or incomplete discovery metadata: %s (%s)",
    async (metadataOverride) => {
      const database = openHarness();
      try {
        seedProvider(database);
        const unsafeDetail = "private-provider-diagnostic";
        const service = registry(database, metadata(metadataOverride));

        await expect(service.discover(providerId)).rejects.toEqual(
          expect.objectContaining({
            code: "oidc_provider_misconfigured",
            message: "The identity provider configuration is invalid.",
          }),
        );

        expectFailedWithoutDetails(database);
        expect(JSON.stringify(persistedProvider(database))).not.toContain(unsafeDetail);
      } finally {
        database.close();
      }
    },
  );

  it("reports optional remote endpoint capabilities only when they are advertised", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      const runtime = await registry(
        database,
        metadata({
          end_session_endpoint: undefined,
          userinfo_endpoint: undefined,
        }),
      ).discover(providerId);

      expect(runtime.provider.capabilities.logout).toMatchObject({
        backChannel: true,
        frontChannel: true,
        rpInitiated: false,
      });
      expect(runtime.provider.capabilities.userInfo).toBe(false);
    } finally {
      database.close();
    }
  });

  it.each([
    ["end-session", { end_session_endpoint: "https://logout.example.test/end-session" }],
    ["userinfo", { userinfo_endpoint: "http://id.example.test/userinfo" }],
  ] as const)("rejects an unsafe optional %s endpoint", async (_label, metadataOverride) => {
    const database = openHarness();
    try {
      seedProvider(database);

      await expect(
        registry(database, metadata(metadataOverride)).discover(providerId),
      ).rejects.toMatchObject({ code: "oidc_provider_misconfigured" });
      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  it("decrypts confidential credentials only with the provider-specific AAD context", async () => {
    const database = openHarness();
    try {
      const wrongContextEnvelope = new EnvelopeCipher(encryptionKey).encrypt(
        clientSecret,
        oidcClientSecretEncryptionContext("oidc-other"),
      );
      seedProvider(database, { encryptedClientSecret: wrongContextEnvelope });
      const discover = vi.fn<NonNullable<OidcProviderRegistryDependencies["discover"]>>();

      await expect(
        registry(database, metadata(), { discover }).discover(providerId),
      ).rejects.toMatchObject({ code: "oidc_provider_misconfigured" });

      expect(discover).not.toHaveBeenCalled();
      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  it("converts discovery failures to context-free errors and never persists unsafe diagnostics", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      const unsafeDetail = `upstream returned ${clientSecret} at https://private.example.test`;
      const service = registry(database, metadata(), {
        discover: async () => {
          throw new Error(unsafeDetail);
        },
      });

      let thrown: unknown;
      try {
        await service.discover(providerId);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual(
        expect.objectContaining({
          code: "oidc_provider_discovery_failed",
          message: "The identity provider could not be validated.",
          retryable: true,
        }),
      );
      expect(String(thrown)).not.toContain(clientSecret);
      expect(String(thrown)).not.toContain("private.example.test");
      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  it("fails closed when the approved-origin transport cannot be constructed", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      const discover = vi.fn<NonNullable<OidcProviderRegistryDependencies["discover"]>>();
      const service = registry(database, metadata(), {
        createSafeFetch: () => {
          throw new Error(`unsafe transport diagnostic ${clientSecret}`);
        },
        discover,
      });

      await expect(service.discover(providerId)).rejects.toEqual(
        expect.objectContaining({
          code: "oidc_provider_misconfigured",
          message: "The identity provider configuration is invalid.",
        }),
      );
      expect(discover).not.toHaveBeenCalled();
      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  it("uses an exact stable identifier and rejects disabled providers before discovery", async () => {
    const database = openHarness();
    try {
      seedProvider(database, { enabled: false });
      const discover = vi.fn<NonNullable<OidcProviderRegistryDependencies["discover"]>>();
      const service = registry(database, metadata(), { discover });

      await expect(service.discover("OIDC-HOME")).rejects.toMatchObject({
        code: "oidc_provider_not_found",
      });
      await expect(service.discover("oidc-home' or 1=1 --")).rejects.toMatchObject({
        code: "oidc_provider_not_found",
      });
      await expect(service.discover(providerId)).rejects.toMatchObject({
        code: "oidc_provider_disabled",
      });
      expect(discover).not.toHaveBeenCalled();
      expect(persistedProvider(database)).toMatchObject({ discoveryState: "unchecked" });
    } finally {
      database.close();
    }
  });

  it("accepts the contract-aligned 160-character provider display-name boundary", async () => {
    const database = openHarness();
    try {
      const displayName = "P".repeat(160);
      seedProvider(database, { displayName });

      const runtime = await registry(database).discover(providerId);

      expect(runtime.provider.displayName).toBe(displayName);
    } finally {
      database.close();
    }
  });

  it("rejects a provider display name beyond the contract boundary", async () => {
    const database = openHarness();
    try {
      seedProvider(database, { displayName: "P".repeat(161) });

      await expect(registry(database).discover(providerId)).rejects.toMatchObject({
        code: "oidc_provider_misconfigured",
      });
      expectFailedWithoutDetails(database);
    } finally {
      database.close();
    }
  });

  it("single-flights concurrent discovery and returns one opaque runtime to every caller", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      let releaseDiscovery: (() => void) | undefined;
      const discoveryGate = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const discover: NonNullable<OidcProviderRegistryDependencies["discover"]> = vi.fn(
        async (_server, clientId, clientMetadata, clientAuthentication) => {
          await discoveryGate;
          return configuration(metadata(), clientId, clientMetadata, clientAuthentication);
        },
      );
      const service = registry(database, metadata(), { discover });

      const pending = Array.from({ length: 24 }, () => service.discover(providerId));
      expect(discover).toHaveBeenCalledTimes(1);
      releaseDiscovery?.();
      const runtimes = await Promise.all(pending);

      expect(discover).toHaveBeenCalledTimes(1);
      expect(new Set(runtimes).size).toBe(1);
      expect(runtimes.every((runtime) => runtime === runtimes[0])).toBe(true);
      expect(await service.discover(providerId)).toBe(runtimes[0]);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(persistedProvider(database)).toMatchObject({
        discoveryState: "ready",
        updatedAt: initialTime,
      });
    } finally {
      database.close();
    }
  });

  it("serializes a changed fingerprint behind the active provider flight and retries fresh", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      let releaseFirstDiscovery: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirstDiscovery = resolve;
      });
      let calls = 0;
      const discover: NonNullable<OidcProviderRegistryDependencies["discover"]> = vi.fn(
        async (_server, clientId, clientMetadata, clientAuthentication) => {
          calls += 1;
          if (calls === 1) await firstGate;
          return configuration(metadata(), clientId, clientMetadata, clientAuthentication);
        },
      );
      const service = registry(database, metadata(), { discover });

      const obsolete = service.discover(providerId);
      database.db
        .update(oidcProviders)
        .set({ displayName: "Current identity", updatedAt: new Date(checkedTime.getTime() + 1) })
        .run();
      const current = service.discover(providerId);
      expect(discover).toHaveBeenCalledTimes(1);
      releaseFirstDiscovery?.();

      await expect(obsolete).rejects.toMatchObject({ code: "oidc_provider_changed" });
      const runtime = await current;
      expect(runtime.provider.displayName).toBe("Current identity");
      expect(discover).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("reuses a fingerprint-matched runtime only within the conservative cache TTL", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      let now = new Date(checkedTime);
      const discover: NonNullable<OidcProviderRegistryDependencies["discover"]> = vi.fn(
        async (_server, clientId, clientMetadata, clientAuthentication) =>
          configuration(metadata(), clientId, clientMetadata, clientAuthentication),
      );
      const service = registry(database, metadata(), { clock: () => now, discover });

      const first = await service.discover(providerId);
      expect(await service.discover(providerId)).toBe(first);
      now = new Date(now.getTime() + OIDC_PROVIDER_RUNTIME_CACHE_TTL_MS - 1);
      expect(await service.discover(providerId)).toBe(first);
      now = new Date(now.getTime() + 2);
      const refreshed = await service.discover(providerId);

      expect(refreshed).not.toBe(first);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(await service.discover(providerId)).toBe(refreshed);
      expect(discover).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("invalidates automatically for relevant configuration and updatedAt changes", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      let now = new Date(checkedTime);
      const discover: NonNullable<OidcProviderRegistryDependencies["discover"]> = vi.fn(
        async (_server, clientId, clientMetadata, clientAuthentication) =>
          configuration(metadata(), clientId, clientMetadata, clientAuthentication),
      );
      const service = registry(database, metadata(), { clock: () => now, discover });

      const first = await service.discover(providerId);
      now = new Date(now.getTime() + 1_000);
      database.db
        .update(oidcProviders)
        .set({ displayName: "Updated identity", updatedAt: now })
        .run();
      const afterConfigurationChange = await service.discover(providerId);
      expect(afterConfigurationChange).not.toBe(first);
      expect(afterConfigurationChange.provider.displayName).toBe("Updated identity");

      now = new Date(now.getTime() + 1_000);
      database.db.update(oidcProviders).set({ updatedAt: now }).run();
      const afterTimestampChange = await service.discover(providerId);

      expect(afterTimestampChange).not.toBe(afterConfigurationChange);
      expect(discover).toHaveBeenCalledTimes(3);
      expect(await service.discover(providerId)).toBe(afterTimestampChange);
      expect(discover).toHaveBeenCalledTimes(3);
    } finally {
      database.close();
    }
  });

  it("does not poison the cache after a failed discovery and retries cleanly", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      let attempts = 0;
      const discover: NonNullable<OidcProviderRegistryDependencies["discover"]> = vi.fn(
        async (_server, clientId, clientMetadata, clientAuthentication) => {
          attempts += 1;
          if (attempts === 1) throw new Error(`unsafe first failure ${clientSecret}`);
          return configuration(metadata(), clientId, clientMetadata, clientAuthentication);
        },
      );
      const service = registry(database, metadata(), { discover });

      await expect(service.discover(providerId)).rejects.toMatchObject({
        code: "oidc_provider_discovery_failed",
      });
      const recovered = await service.discover(providerId);

      expect(discover).toHaveBeenCalledTimes(2);
      expect(await service.discover(providerId)).toBe(recovered);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(recovered.provider)).not.toContain(clientSecret);
      expect(persistedProvider(database)).toMatchObject({
        discoveryState: "ready",
        updatedAt: initialTime,
      });
    } finally {
      database.close();
    }
  });

  it("bounds the runtime cache with least-recently-used eviction", async () => {
    const database = openHarness();
    try {
      const providerIds = Array.from(
        { length: OIDC_PROVIDER_RUNTIME_CACHE_MAX_ENTRIES + 1 },
        (_, index) => `oidc-cache-${index}`,
      );
      for (const id of providerIds) {
        const providerIssuer = `https://${id}.example.test/`;
        seedProvider(database, {
          approvedEndpointOriginsJson: JSON.stringify([new URL(providerIssuer).origin]),
          id,
          issuer: providerIssuer,
        });
      }
      const discover: NonNullable<OidcProviderRegistryDependencies["discover"]> = vi.fn(
        async (server, clientId, clientMetadata, clientAuthentication) =>
          configuration(
            metadataForIssuer(server.href),
            clientId,
            clientMetadata,
            clientAuthentication,
          ),
      );
      const service = registry(database, metadata(), { discover });
      const runtimes = [];

      for (const id of providerIds) runtimes.push(await service.discover(id));
      expect(discover).toHaveBeenCalledTimes(providerIds.length);
      expect(Object.keys(service)).toEqual([]);
      expect(JSON.stringify(service)).toBe("{}");

      const refreshedFirst = await service.discover(providerIds[0] ?? "");
      expect(refreshedFirst).not.toBe(runtimes[0]);
      expect(discover).toHaveBeenCalledTimes(providerIds.length + 1);
      expect(await service.discover(providerIds.at(-1) ?? "")).toBe(runtimes.at(-1));
      expect(discover).toHaveBeenCalledTimes(providerIds.length + 1);
    } finally {
      database.close();
    }
  });

  it("turns a malformed clock value into a context-free storage failure", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      const service = registry(database, metadata(), {
        clock: () => "not-a-date" as unknown as Date,
      });

      await expect(service.discover(providerId)).rejects.toEqual(
        expect.objectContaining({
          code: "oidc_provider_storage_failed",
          message: "The identity provider validation state could not be saved.",
        }),
      );
      expect(persistedProvider(database)).toMatchObject({ discoveryState: "unchecked" });
    } finally {
      database.close();
    }
  });

  it.each(["created_at", "updated_at"] as const)(
    "turns a corrupt %s database timestamp into a context-free storage failure",
    async (column) => {
      const database = openHarness();
      try {
        seedProvider(database);
        database.sqlite
          .prepare(`update oidc_providers set ${column} = 'not-a-date' where id = ?`)
          .run(providerId);

        await expect(registry(database).discover(providerId)).rejects.toEqual(
          expect.objectContaining({
            code: "oidc_provider_storage_failed",
            message: "The identity provider validation state could not be saved.",
          }),
        );
        expect(persistedProvider(database)).toMatchObject({ discoveryState: "unchecked" });
      } finally {
        database.close();
      }
    },
  );

  it("does not publish a stale result when configuration changes during discovery", async () => {
    const database = openHarness();
    try {
      seedProvider(database);
      const service = registry(database, metadata(), {
        discover: async (_server, clientId, clientMetadata, clientAuthentication) => {
          database.db
            .update(oidcProviders)
            .set({ displayName: "Updated identity", updatedAt: checkedTime })
            .run();
          return configuration(metadata(), clientId, clientMetadata, clientAuthentication);
        },
      });

      await expect(service.discover(providerId)).rejects.toMatchObject({
        code: "oidc_provider_changed",
      });

      expect(persistedProvider(database)).toMatchObject({
        discoveryState: "unchecked",
        displayName: "Updated identity",
      });
    } finally {
      database.close();
    }
  });
});
