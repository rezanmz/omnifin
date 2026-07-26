import { roleMappingSchema, type Role, type RoleMapping } from "@omnifin/contracts/auth";
import {
  Configuration,
  type ClientAuth,
  type ClientMetadata,
  type ServerMetadata,
} from "openid-client";
import { describe, expect, it } from "vitest";
import { OidcAuthorizationTransactionService } from "../src/auth/oidc/authorization-transaction.js";
import {
  OidcIdentityService,
  OidcIdentityServiceError,
} from "../src/auth/oidc/identity-service.js";
import {
  createOidcProviderRuntimeBindingVerifier,
  OidcProviderRegistry,
  oidcClientSecretEncryptionContext,
  oidcProviderRuntimeBinding,
  type OidcProviderRuntime,
} from "../src/auth/oidc/provider-registry.js";
import {
  isVerifiedOidcGrant,
  OidcProtocolService,
  type VerifiedOidcGrant,
} from "../src/auth/oidc/protocol.js";
import { SessionService } from "../src/auth/session-service.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  roleMappings,
  serviceIdentityLinks,
  sessions,
  users,
} from "../src/db/schema.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const ISSUER = "https://id.example.test/application/o/omnifin/";
const LOGIN_TIME = new Date("2026-07-25T16:00:00.000Z");
const EARLIER_TIME = new Date("2026-07-25T15:00:00.000Z");
const PROTOCOL_KEY = Buffer.alloc(32, 29);

interface GrantBinding {
  idTokenHint?: string;
  providerId?: string;
}

interface ResolveOptions extends GrantBinding {
  requestId?: string;
}

function claims(input: Readonly<Record<string, unknown>> = {}) {
  return Object.freeze({
    aud: "omnifin",
    exp: 1_900_000_000,
    iat: 1_800_000_000,
    iss: ISSUER,
    sub: "subject-1",
    ...input,
  });
}

function compactIdToken(payload = "verified-identity-fixture") {
  return ["header", Buffer.from(payload, "utf8").toString("base64url"), "signature"].join(".");
}

function providerMetadata(
  providerIssuer: string,
  overrides: Partial<ServerMetadata> = {},
): ServerMetadata {
  const origin = new URL(providerIssuer).origin;
  return {
    authorization_endpoint: `${origin}/application/o/authorize/`,
    code_challenge_methods_supported: ["S256"],
    end_session_endpoint: `${origin}/application/o/omnifin/end-session/`,
    grant_types_supported: ["authorization_code"],
    id_token_signing_alg_values_supported: ["RS256"],
    issuer: providerIssuer,
    jwks_uri: `${origin}/application/o/omnifin/jwks/`,
    response_types_supported: ["code"],
    token_endpoint: `${origin}/application/o/token/`,
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    ...overrides,
  } as ServerMetadata;
}

function seedProvider(
  database: DatabaseHandle,
  overrides: Partial<typeof oidcProviders.$inferInsert> = {},
) {
  const providerIssuer = overrides.issuer ?? ISSUER;
  database.db
    .insert(oidcProviders)
    .values({
      approvedEndpointOriginsJson:
        overrides.approvedEndpointOriginsJson ?? JSON.stringify([new URL(providerIssuer).origin]),
      clientId: "omnifin",
      createdAt: EARLIER_TIME,
      discoveryCapabilitiesJson: JSON.stringify({ authorizationCode: true, pkceS256: true }),
      discoveryCheckedAt: EARLIER_TIME,
      discoveryState: "ready",
      displayName: "Home identity",
      id: "oidc-home",
      issuer: providerIssuer,
      slug: "home",
      updatedAt: EARLIER_TIME,
      ...overrides,
    })
    .run();
}

async function discoverRuntime(
  database: DatabaseHandle,
  providerId = "oidc-home",
  metadataOverrides: Partial<ServerMetadata> = {},
): Promise<OidcProviderRuntime> {
  const providerIssuer = database.sqlite
    .prepare("select issuer from oidc_providers where id = ?")
    .get(providerId) as { issuer: string } | undefined;
  if (!providerIssuer) throw new Error("Missing OIDC provider fixture.");
  const runtime = await new OidcProviderRegistry(
    database,
    { encryptionKey: PROTOCOL_KEY },
    {
      clock: () => new Date(LOGIN_TIME),
      discover: async (
        _issuerUrl: URL,
        discoveredClientId: string,
        clientMetadata: Partial<ClientMetadata> | string | undefined,
        clientAuthentication: ClientAuth | undefined,
      ) =>
        new Configuration(
          providerMetadata(providerIssuer.issuer, metadataOverrides),
          discoveredClientId,
          clientMetadata,
          clientAuthentication,
        ),
    },
  ).discover(providerId);
  return runtime;
}

async function verifiedGrantFromRuntime(
  database: DatabaseHandle,
  runtime: OidcProviderRuntime,
  rawClaims: Readonly<Record<string, unknown>>,
  binding: Pick<GrantBinding, "idTokenHint"> = {},
): Promise<VerifiedOidcGrant> {
  const providerId = runtime.provider.id;
  const transactions = new OidcAuthorizationTransactionService(database, {
    baseUrl: new URL("https://omnifin.example"),
    encryptionKey: PROTOCOL_KEY,
    environment: "test",
    secureCookies: true,
  });
  const created = await transactions.create({
    providerId,
    providerRuntimeBinding: oidcProviderRuntimeBinding(runtime),
  });
  const transaction = transactions.consume({
    browserBindingToken: created.browserBindingToken,
    providerId,
    state: created.state,
  });
  const callbackUrl = new URL(created.redirectUri);
  callbackUrl.searchParams.set("code", "authorization-code");
  callbackUrl.searchParams.set("state", created.state);
  const protocol = new OidcProtocolService({
    authorizationCodeGrant: async (_runtime, _currentUrl, checks) => ({
      claims: {
        ...rawClaims,
        nonce: checks.expectedNonce,
      },
      idToken: binding.idTokenHint ?? compactIdToken(),
    }),
  });
  return await protocol.completeAuthorization({ callbackUrl, runtime, transaction });
}

async function verifiedGrant(
  database: DatabaseHandle,
  rawClaims: Readonly<Record<string, unknown>>,
  binding: GrantBinding = {},
): Promise<VerifiedOidcGrant> {
  const runtime = await discoverRuntime(database, binding.providerId);
  return verifiedGrantFromRuntime(database, runtime, rawClaims, binding);
}

function mapping(overrides: Partial<RoleMapping> = {}) {
  return roleMappingSchema.parse({
    claimPath: ["groups"],
    enabled: true,
    id: "operators",
    operator: "contains_any",
    priority: 100,
    providerId: "oidc-home",
    role: "operator",
    values: ["media-operators"],
    ...overrides,
  });
}

function seedMappings(database: DatabaseHandle, mappings: readonly RoleMapping[]) {
  if (mappings.length === 0) return;
  database.db
    .insert(roleMappings)
    .values(
      mappings.map((candidate) => ({
        claimPathJson: JSON.stringify(candidate.claimPath),
        enabled: candidate.enabled,
        id: candidate.id,
        operator: candidate.operator,
        priority: candidate.priority,
        providerId: candidate.providerId,
        role: candidate.role,
        valuesJson: JSON.stringify(candidate.values),
      })),
    )
    .run();
}

function seedIdentity(
  database: DatabaseHandle,
  overrides: {
    displayClaims?: Readonly<Record<string, unknown>>;
    identityId?: string;
    providerId?: string;
    role?: Role;
    roleSource?: "default" | "manual" | "oidc_mapping" | "recovery_bootstrap";
    status?: "active" | "disabled" | "pending_link";
    subject?: string;
    userId?: string;
  } = {},
) {
  const userId = overrides.userId ?? "user-1";
  const identityId = overrides.identityId ?? "identity-1";
  database.db
    .insert(users)
    .values({
      createdAt: EARLIER_TIME,
      displayName: "Existing user",
      id: userId,
      role: overrides.role ?? "viewer",
      roleSource: overrides.roleSource ?? "default",
      status: overrides.status ?? "pending_link",
      updatedAt: EARLIER_TIME,
    })
    .run();
  database.db
    .insert(externalIdentities)
    .values({
      createdAt: EARLIER_TIME,
      displayClaimsJson: JSON.stringify(overrides.displayClaims ?? {}),
      id: identityId,
      issuer: ISSUER,
      lastLoginAt: EARLIER_TIME,
      providerId: overrides.providerId ?? "oidc-home",
      subject: overrides.subject ?? "subject-1",
      updatedAt: EARLIER_TIME,
      userId,
    })
    .run();
  return { identityId, userId };
}

function createHarness(prefix = "identity-fixture") {
  const database = openDatabase(":memory:");
  database.migrate();
  let identifier = 0;
  const service = new OidcIdentityService(database, {
    clock: () => new Date(LOGIN_TIME),
    createId: () => `${prefix}-${(identifier += 1)}`,
    providerBindingVerifier: createOidcProviderRuntimeBindingVerifier(database, {
      encryptionKey: PROTOCOL_KEY,
    }),
  });
  return { database, service };
}

async function resolve(
  database: DatabaseHandle,
  service: OidcIdentityService,
  rawClaims: Readonly<Record<string, unknown>>,
  options: ResolveOptions = {},
) {
  const { requestId = "request-1", ...binding } = options;
  return service.resolve({
    grant: await verifiedGrant(database, rawClaims, binding),
    requestId,
  });
}

function readAudit(database: DatabaseHandle) {
  return database.sqlite
    .prepare(
      `select
        event_type as eventType,
        outcome,
        target_type as targetType,
        target_id as targetId,
        request_id as requestId,
        metadata_json as metadataJson
       from audit_events
       order by rowid`,
    )
    .all() as {
    eventType: string;
    metadataJson: string;
    outcome: string;
    requestId: string | null;
    targetId: string | null;
    targetType: string;
  }[];
}

function seedActiveSession(database: DatabaseHandle, identityId: string, userId: string) {
  database.db
    .insert(sessions)
    .values({
      absoluteExpiresAt: new Date("2026-07-26T15:00:00.000Z"),
      authMethod: "oidc",
      createdAt: EARLIER_TIME,
      csrfTokenHash: "c".repeat(43),
      encryptedCsrfToken: "v2.fixture-csrf",
      expiresAt: new Date("2026-07-25T20:00:00.000Z"),
      externalIdentityId: identityId,
      id: "session-1",
      lastRotatedAt: EARLIER_TIME,
      lastSeenAt: EARLIER_TIME,
      oidcProviderId: "oidc-home",
      serviceIdentityLinkId: "link-1",
      tokenHash: "t".repeat(43),
      userId,
    })
    .run();
}

function seedJellyfinLink(
  database: DatabaseHandle,
  overrides: Partial<typeof serviceIdentityLinks.$inferInsert> = {},
) {
  database.db
    .insert(connectorConfigs)
    .values({
      baseUrl: "https://jellyfin.example.test",
      createdAt: EARLIER_TIME,
      displayName: "Home Jellyfin",
      encryptedCredentials: "v2.fixture-connector-credentials",
      healthState: "healthy",
      id: "jellyfin-home",
      type: "jellyfin",
      updatedAt: EARLIER_TIME,
    })
    .run();
  database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-home",
      createdAt: EARLIER_TIME,
      deviceId: "device-1",
      encryptedAccessToken: "v2.fixture-jellyfin-token",
      externalDisplayName: "Existing user",
      externalServerId: "server-1",
      externalUserId: "jellyfin-user-1",
      externalUsername: "existing-user",
      healthState: "linked",
      id: "link-1",
      lastVerifiedAt: EARLIER_TIME,
      service: "jellyfin",
      tokenCreatedAt: EARLIER_TIME,
      updatedAt: EARLIER_TIME,
      userId: "user-1",
      ...overrides,
    })
    .run();
}

describe("OidcIdentityService", () => {
  it("rejects the internal resolution path outside a transaction without consuming the grant", async () => {
    const { database, service } = createHarness();
    try {
      seedProvider(database);
      const grant = await verifiedGrant(database, claims());

      expect(() =>
        service.resolveInExistingTransaction({ grant, requestId: "guarded-request" }),
      ).toThrow(OidcIdentityServiceError);

      expect(service.resolve({ grant, requestId: "root-request" })).toMatchObject({
        status: "resolved",
      });
    } finally {
      database.close();
    }
  });

  it("rejects a raw session identifier on the internal path without consuming the grant", async () => {
    const { database, service } = createHarness();
    try {
      seedProvider(database);
      const grant = await verifiedGrant(database, claims());
      const unsafeResolve = service.resolveInExistingTransaction.bind(service) as unknown as (
        input: { grant: typeof grant; requestId: string },
        options: { preserveSessionId: string },
      ) => unknown;

      database.sqlite
        .transaction(() => {
          expect(() =>
            unsafeResolve(
              { grant, requestId: "raw-preservation-request" },
              { preserveSessionId: "attacker-selected-session" },
            ),
          ).toThrow(OidcIdentityServiceError);
        })
        .immediate();

      expect(service.resolve({ grant, requestId: "safe-root-request" })).toMatchObject({
        status: "resolved",
      });
    } finally {
      database.close();
    }
  });

  it("keeps the root key and verifier capability outside reflective service state", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const verifier = createOidcProviderRuntimeBindingVerifier(database, {
        encryptionKey: PROTOCOL_KEY,
      });
      const service = new OidcIdentityService(database, {
        providerBindingVerifier: verifier,
      });

      expect(Object.keys(verifier)).toEqual([]);
      expect(Object.isFrozen(verifier)).toBe(true);
      expect(() => JSON.stringify(verifier)).toThrow(
        "OIDC provider binding verifiers cannot be serialized.",
      );
      const ownKeys = Reflect.ownKeys(service).map(String);
      expect(ownKeys).not.toContain("encryptionKey");
      expect(ownKeys).not.toContain("providerBindingVerifier");
      const descriptors = Object.getOwnPropertyDescriptors(service);
      expect(
        Object.values(descriptors).some(
          (descriptor) =>
            "value" in descriptor &&
            Buffer.isBuffer(descriptor.value) &&
            descriptor.value.equals(PROTOCOL_KEY),
        ),
      ).toBe(false);
      const spread = { ...service } as Record<string, unknown>;
      expect(spread).not.toHaveProperty("encryptionKey");
      expect(spread).not.toHaveProperty("providerBindingVerifier");
      expect(() => JSON.stringify(service)).toThrow("OIDC identity services cannot be serialized.");
    } finally {
      database.close();
    }
  });

  it("never links a new subject to an existing account by matching email or username", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedIdentity(database, {
      displayClaims: { email: "shared@example.test", preferredUsername: "shared" },
      subject: "victim-subject",
    });

    const result = await resolve(
      database,
      service,
      claims({
        email: "shared@example.test",
        preferred_username: "shared",
        sub: "attacker-subject",
      }),
    );

    expect(result).toMatchObject({ provisioned: true, status: "resolved" });
    expect(result.status === "resolved" && result.attribution.userId).not.toBe("user-1");
    expect(database.db.select().from(users).all()).toHaveLength(2);
    expect(database.db.select().from(externalIdentities).all()).toHaveLength(2);
    database.close();
  });

  it("keys identities by immutable issuer and subject", async () => {
    const { database, service } = createHarness();
    const workIssuer = "https://work-id.example.test/application/o/omnifin/";
    seedProvider(database);
    seedProvider(database, {
      clientId: "omnifin-work",
      displayName: "Work identity",
      id: "oidc-work",
      issuer: workIssuer,
      slug: "work",
    });

    const home = await resolve(database, service, claims({ sub: "shared-subject" }));
    const work = await resolve(
      database,
      service,
      claims({ aud: "omnifin-work", iss: workIssuer, sub: "shared-subject" }),
      {
        providerId: "oidc-work",
        requestId: "request-2",
      },
    );

    expect(home).toMatchObject({ provisioned: true, status: "resolved" });
    expect(work).toMatchObject({ provisioned: true, status: "resolved" });
    if (home.status === "resolved" && work.status === "resolved") {
      expect(work.attribution.userId).not.toBe(home.attribution.userId);
    }
    expect(database.db.select().from(users).all()).toHaveLength(2);
    database.close();
  });

  it("accepts protocol-verified multi-audience claims and still requires current provider bindings", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    const multiAudienceClaims = claims({
      aud: ["omnifin", "media-api"],
      azp: "omnifin",
    });

    const accepted = await resolve(database, service, multiAudienceClaims);
    expect(accepted).toMatchObject({ provisioned: true, status: "resolved" });
    database.close();

    const changed = createHarness("changed-provider-fixture");
    seedProvider(changed.database);
    const boundGrant = await verifiedGrant(changed.database, multiAudienceClaims);
    changed.database.sqlite
      .prepare("update oidc_providers set client_id = 'replacement-client' where id = 'oidc-home'")
      .run();
    expect(changed.service.resolve({ grant: boundGrant, requestId: "request-2" })).toEqual({
      reason: "provider_context_mismatch",
      status: "denied",
    });
    expect(changed.database.db.select().from(users).all()).toHaveLength(0);
    changed.database.close();
  });

  it("rejects grants when any persisted provider security binding changes", async () => {
    const encryptedSecret = (value: string) =>
      new EnvelopeCipher(PROTOCOL_KEY).encrypt(
        value,
        oidcClientSecretEncryptionContext("oidc-home"),
      );
    const cases: ReadonlyArray<{
      mutate: (database: DatabaseHandle) => void;
      name: string;
      seedOverrides?: Partial<typeof oidcProviders.$inferInsert>;
    }> = [
      {
        mutate: (database) => {
          database.sqlite
            .prepare(
              "update oidc_providers set id_token_signing_alg = 'RS384' where id = 'oidc-home'",
            )
            .run();
        },
        name: "ID-token signing algorithm",
      },
      {
        mutate: (database) => {
          database.sqlite
            .prepare(
              "update oidc_providers set token_endpoint_auth_method = 'client_secret_basic', encrypted_client_secret = ? where id = 'oidc-home'",
            )
            .run(encryptedSecret("new-client-secret"));
        },
        name: "token authentication configuration",
      },
      {
        mutate: (database) => {
          database.sqlite
            .prepare("update oidc_providers set encrypted_client_secret = ? where id = 'oidc-home'")
            .run(encryptedSecret("replacement-client-secret"));
        },
        name: "encrypted client secret",
        seedOverrides: {
          encryptedClientSecret: encryptedSecret("original-client-secret"),
          tokenEndpointAuthMethod: "client_secret_basic",
        },
      },
      {
        mutate: (database) => {
          database.sqlite
            .prepare(
              "update oidc_providers set scopes = 'openid profile email groups' where id = 'oidc-home'",
            )
            .run();
        },
        name: "requested scopes",
      },
      {
        mutate: (database) => {
          database.sqlite
            .prepare(
              `update oidc_providers
               set claim_config_json = '{"groupsClaim":"groups"}'
               where id = 'oidc-home'`,
            )
            .run();
        },
        name: "claim configuration",
      },
      {
        mutate: (database) => {
          database.sqlite
            .prepare(
              "update oidc_providers set approved_endpoint_origins_json = ? where id = 'oidc-home'",
            )
            .run(JSON.stringify(["https://id.example.test", "https://keys.example.test"]));
        },
        name: "approved endpoint origins",
      },
      {
        mutate: (database) => {
          const stored = database.sqlite
            .prepare(
              "select discovery_capabilities_json as snapshot from oidc_providers where id = 'oidc-home'",
            )
            .get() as { snapshot: string };
          const snapshot = JSON.parse(stored.snapshot) as {
            capabilities: { logout: { frontChannel: boolean } };
          };
          snapshot.capabilities.logout.frontChannel = true;
          database.sqlite
            .prepare(
              "update oidc_providers set discovery_capabilities_json = ? where id = 'oidc-home'",
            )
            .run(JSON.stringify(snapshot));
        },
        name: "discovered capabilities",
      },
    ];

    for (const candidate of cases) {
      const { database, service } = createHarness(`binding-${candidate.name.replaceAll(" ", "-")}`);
      seedProvider(database, candidate.seedOverrides);
      const grant = await verifiedGrant(database, claims());
      const before = database.sqlite
        .prepare(
          "select id, issuer, client_id as clientId from oidc_providers where id = 'oidc-home'",
        )
        .get();

      candidate.mutate(database);

      expect(
        service.resolve({ grant, requestId: "request-binding-change" }),
        candidate.name,
      ).toEqual({
        reason: "invalid_verified_context",
        status: "denied",
      });
      expect(
        database.sqlite
          .prepare(
            "select id, issuer, client_id as clientId from oidc_providers where id = 'oidc-home'",
          )
          .get(),
      ).toEqual(before);
      expect(database.db.select().from(users).all()).toHaveLength(0);
      expect(readAudit(database)).toEqual([
        expect.objectContaining({
          eventType: "auth.oidc.identity.denied",
          metadataJson: JSON.stringify({ reason: "invalid_verified_context" }),
          outcome: "denied",
        }),
      ]);
      database.close();
    }
  });

  it("rotates the sealed runtime binding across real metadata endpoint transitions", async () => {
    const origin = new URL(ISSUER).origin;
    const metadataA: Partial<ServerMetadata> = {
      authorization_endpoint: `${origin}/runtime-a/authorize`,
      end_session_endpoint: `${origin}/runtime-a/end-session`,
      jwks_uri: `${origin}/runtime-a/jwks`,
      token_endpoint: `${origin}/runtime-a/token`,
      userinfo_endpoint: `${origin}/runtime-a/userinfo`,
    };
    const endpointTransitions: ReadonlyArray<{
      field:
        | "authorization_endpoint"
        | "end_session_endpoint"
        | "jwks_uri"
        | "token_endpoint"
        | "userinfo_endpoint";
      value: string;
    }> = [
      { field: "authorization_endpoint", value: `${origin}/runtime-b/authorize` },
      { field: "token_endpoint", value: `${origin}/runtime-b/token` },
      { field: "jwks_uri", value: `${origin}/runtime-b/jwks` },
      { field: "end_session_endpoint", value: `${origin}/runtime-b/end-session` },
      { field: "userinfo_endpoint", value: `${origin}/runtime-b/userinfo` },
    ];

    for (const transition of endpointTransitions) {
      const { database, service } = createHarness(`endpoint-${transition.field}`);
      seedProvider(database);
      const localConfiguration = () =>
        database.sqlite
          .prepare(
            `select
               id,
               issuer,
               client_id as clientId,
               encrypted_client_secret as encryptedClientSecret,
               token_endpoint_auth_method as tokenEndpointAuthMethod,
               id_token_signing_alg as idTokenSigningAlg,
               scopes,
               claim_config_json as claimConfigJson,
               approved_endpoint_origins_json as approvedEndpointOriginsJson
             from oidc_providers
             where id = 'oidc-home'`,
          )
          .get();
      const discoverySeal = () => {
        const stored = database.sqlite
          .prepare(
            "select discovery_capabilities_json as snapshot from oidc_providers where id = 'oidc-home'",
          )
          .get() as { snapshot: string };
        return (JSON.parse(stored.snapshot) as { runtimeSecuritySeal: string }).runtimeSecuritySeal;
      };

      const runtimeA = await discoverRuntime(database, "oidc-home", metadataA);
      const oldGrant = await verifiedGrantFromRuntime(database, runtimeA, claims());
      const localBefore = localConfiguration();
      const capabilitiesBefore = runtimeA.provider.capabilities;
      const sealA = discoverySeal();

      const metadataB = { ...metadataA, [transition.field]: transition.value };
      const runtimeB = await discoverRuntime(database, "oidc-home", metadataB);
      const sealB = discoverySeal();

      expect(runtimeB.provider.capabilities, transition.field).toEqual(capabilitiesBefore);
      expect(localConfiguration(), transition.field).toEqual(localBefore);
      expect(sealB, transition.field).not.toBe(sealA);
      expect(oidcProviderRuntimeBinding(runtimeB), transition.field).not.toBe(
        oidcProviderRuntimeBinding(runtimeA),
      );
      expect(
        service.resolve({ grant: oldGrant, requestId: `old-${transition.field}` }),
        transition.field,
      ).toEqual({ reason: "invalid_verified_context", status: "denied" });

      const currentGrant = await verifiedGrantFromRuntime(database, runtimeB, claims());
      expect(
        service.resolve({ grant: currentGrant, requestId: `current-${transition.field}` }),
        transition.field,
      ).toMatchObject({ provisioned: true, status: "resolved" });
      const auditJson = JSON.stringify(readAudit(database));
      expect(auditJson).not.toContain(sealA);
      expect(auditJson).not.toContain(sealB);
      expect(auditJson).not.toContain(transition.value);
      expect(readAudit(database)[0]).toMatchObject({
        metadataJson: JSON.stringify({ reason: "invalid_verified_context" }),
        outcome: "denied",
      });
      database.close();
    }
  });

  it("preserves provider availability and JIT denial fidelity", async () => {
    const jit = createHarness("jit-disabled-fixture");
    seedProvider(jit.database, { allowJitProvisioning: false });
    expect(await resolve(jit.database, jit.service, claims())).toEqual({
      reason: "jit_provisioning_disabled",
      status: "denied",
    });
    jit.database.close();

    const unchecked = createHarness("provider-unchecked-fixture");
    seedProvider(unchecked.database, {
      discoveryCapabilitiesJson: "{}",
      discoveryCheckedAt: null,
      discoveryState: "unchecked",
    });
    const uncheckedGrant = await verifiedGrant(unchecked.database, claims());
    unchecked.database.sqlite
      .prepare(
        "update oidc_providers set discovery_state = 'unchecked', discovery_checked_at = null, discovery_capabilities_json = '{}' where id = 'oidc-home'",
      )
      .run();
    expect(unchecked.service.resolve({ grant: uncheckedGrant, requestId: "request-1" })).toEqual({
      reason: "provider_not_ready",
      status: "denied",
    });
    unchecked.database.close();

    const disabled = createHarness("provider-disabled-fixture");
    seedProvider(disabled.database);
    const disabledGrant = await verifiedGrant(disabled.database, claims());
    disabled.database.sqlite
      .prepare("update oidc_providers set enabled = 0 where id = 'oidc-home'")
      .run();
    expect(disabled.service.resolve({ grant: disabledGrant, requestId: "request-1" })).toEqual({
      reason: "provider_disabled",
      status: "denied",
    });
    disabled.database.close();

    const missing = createHarness("provider-missing-fixture");
    const grantDatabase = openDatabase(":memory:");
    grantDatabase.migrate();
    seedProvider(grantDatabase);
    const missingGrant = await verifiedGrant(grantDatabase, claims());
    grantDatabase.close();
    expect(missing.service.resolve({ grant: missingGrant, requestId: "request-1" })).toEqual({
      reason: "provider_not_found",
      status: "denied",
    });
    missing.database.close();
  });

  it("creates an explicit pending-link account without inferring a Jellyfin identity", async () => {
    const { database, service } = createHarness();
    seedProvider(database);

    const result = await resolve(database, service, claims({ sid: "upstream-session-1" }));

    expect(result).toMatchObject({
      accountStatus: "pending_link",
      attribution: {
        authMethod: "oidc",
        oidcProviderId: "oidc-home",
      },
      provisioned: true,
      role: "viewer",
      roleSource: "default",
      status: "resolved",
    });
    if (result.status !== "resolved") throw new Error("Expected resolved identity fixture.");
    expect(result.attribution.oidcSessionId).toBe("upstream-session-1");
    expect(Object.keys(result.attribution)).not.toContain("oidcSessionId");
    expect(database.db.select().from(users).get()).toMatchObject({
      role: "viewer",
      roleSource: "default",
      status: "pending_link",
    });
    expect(database.db.select().from(serviceIdentityLinks).all()).toHaveLength(0);
    expect(readAudit(database).map((event) => event.eventType)).toEqual([
      "auth.oidc.identity.jit_provisioned",
      "auth.oidc.identity.login",
    ]);
    database.close();
  });

  it("computes privileged roles only from current persisted mappings", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedMappings(database, [mapping()]);

    const result = await resolve(database, service, claims({ groups: ["media-operators"] }));

    expect(result).toMatchObject({
      provisioned: true,
      role: "operator",
      roleSource: "oidc_mapping",
      status: "resolved",
    });
    expect(database.db.select().from(users).get()).toMatchObject({
      role: "operator",
      roleSource: "oidc_mapping",
    });
    database.close();
  });

  it("denies ambiguous current mappings without accepting a caller-supplied role result", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedMappings(database, [
      mapping({ id: "operator", role: "operator", values: ["staff"] }),
      mapping({ id: "admin", role: "admin", values: ["staff"] }),
    ]);

    expect(await resolve(database, service, claims({ groups: ["staff"] }))).toEqual({
      reason: "role_mapping_denied",
      status: "denied",
    });
    expect(database.db.select().from(users).all()).toHaveLength(0);
    database.close();
  });

  it("requires a usable Jellyfin link for active accounts", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedIdentity(database, { status: "active" });

    expect(await resolve(database, service, claims())).toEqual({
      reason: "active_service_link_required",
      status: "denied",
    });
    seedJellyfinLink(database, { healthState: "unavailable" });
    const accepted = await resolve(database, service, claims(), { requestId: "request-2" });
    expect(accepted).toMatchObject({
      accountStatus: "active",
      attribution: { serviceIdentityLinkId: "link-1" },
      status: "resolved",
    });
    database.close();
  });

  it("keeps ID-token and sid proofs nonserializable and passes them directly to encrypted session storage", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedIdentity(database, { role: "requester", roleSource: "manual", status: "active" });
    seedJellyfinLink(database);
    const idTokenHint = compactIdToken("private-id-token-hint");
    const oidcSessionId = "private-upstream-session-id";

    const identity = await resolve(database, service, claims({ sid: oidcSessionId }), {
      idTokenHint,
    });
    if (identity.status !== "resolved") throw new Error("Expected resolved identity fixture.");
    expect(identity.attribution.idTokenHint).toBe(idTokenHint);
    expect(identity.attribution.oidcSessionId).toBe(oidcSessionId);
    expect(Object.keys(identity.attribution)).not.toContain("idTokenHint");
    expect(Object.keys(identity.attribution)).not.toContain("oidcSessionId");
    expect(Object.getOwnPropertyDescriptor(identity.attribution, "idTokenHint")?.enumerable).toBe(
      false,
    );
    expect(Object.getOwnPropertyDescriptor(identity.attribution, "oidcSessionId")?.enumerable).toBe(
      false,
    );
    expect(() => JSON.stringify(identity.attribution)).toThrow(
      "OIDC session attribution cannot be serialized.",
    );
    expect(() => JSON.stringify(identity)).toThrow(
      "Resolved OIDC identities cannot be serialized.",
    );
    expect(JSON.stringify({ ...identity.attribution })).not.toContain(idTokenHint);
    expect(JSON.stringify({ ...identity.attribution })).not.toContain(oidcSessionId);

    let identifier = 0;
    let token = 0;
    const sessionService = new SessionService(
      database,
      {
        encryptionKey: Buffer.alloc(32, 7),
        session: {
          absoluteTtlMs: 60 * 60 * 1_000,
          inactivityTtlMs: 10 * 60 * 1_000,
          recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
          rotationIntervalMs: 5 * 60 * 1_000,
        },
      },
      {
        clock: () => new Date(LOGIN_TIME),
        createId: () => `active-session-fixture-${(identifier += 1)}`,
        createToken: () => Buffer.alloc(32, (token += 1)).toString("base64url"),
      },
    );

    const issued = sessionService.createSession({ attribution: identity.attribution });
    expect(issued.principal).toMatchObject({
      accountState: "active",
      authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
      linkedServices: [{ id: "link-1", health: "linked" }],
      role: "requester",
      userId: "user-1",
    });
    const stored = database.db.select().from(sessions).get();
    expect(stored?.encryptedIdTokenHint).toMatch(/^v2\./);
    expect(stored?.encryptedIdTokenHint).not.toContain(idTokenHint);
    expect(stored?.oidcSessionIdHash).toHaveLength(22);
    expect(stored?.oidcSessionIdHash).not.toBe(oidcSessionId);
    const persisted = JSON.stringify({
      audit: readAudit(database),
      externalIdentities: database.db.select().from(externalIdentities).all(),
      sessions: database.db.select().from(sessions).all(),
      users: database.db.select().from(users).all(),
    });
    expect(persisted).not.toContain(idTokenHint);
    expect(persisted).not.toContain(oidcSessionId);
    database.close();
  });

  it("rejects corrupt persisted identity identifiers and timestamps", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedIdentity(database);
    database.sqlite
      .prepare("update external_identities set updated_at = ? where id = 'identity-1'")
      .run(LOGIN_TIME.getTime() + 1);

    expect(await resolve(database, service, claims())).toEqual({
      reason: "identity_integrity_failure",
      status: "denied",
    });
    expect(database.db.select().from(externalIdentities).get()?.displayClaimsJson).toBe("{}");
    database.close();
  });

  it.each(["manual", "recovery_bootstrap"] as const)(
    "preserves a %s role when current OIDC mappings resolve differently",
    async (roleSource) => {
      const { database, service } = createHarness();
      seedProvider(database);
      seedIdentity(database, { role: "admin", roleSource, status: "active" });
      seedJellyfinLink(database);
      seedActiveSession(database, "identity-1", "user-1");

      const result = await resolve(database, service, claims());

      expect(result).toMatchObject({
        role: "admin",
        roleChanged: false,
        roleSource,
        status: "resolved",
      });
      expect(database.db.select().from(sessions).get()?.revokedAt).toBeNull();
      database.close();
    },
  );

  it("recomputes mapped roles and atomically revokes every active session", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedMappings(database, [mapping()]);
    seedIdentity(database, { role: "viewer", roleSource: "default", status: "active" });
    seedJellyfinLink(database);
    seedActiveSession(database, "identity-1", "user-1");

    const result = await resolve(database, service, claims({ groups: ["media-operators"] }));

    expect(result).toMatchObject({
      role: "operator",
      roleChanged: true,
      roleSource: "oidc_mapping",
      status: "resolved",
    });
    expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(LOGIN_TIME);
    expect(readAudit(database)[0]).toMatchObject({
      eventType: "auth.oidc.role.changed",
      metadataJson: JSON.stringify({
        currentRole: "viewer",
        currentRoleSource: "default",
        newRole: "operator",
        newRoleSource: "oidc_mapping",
        revokedSessionCount: 1,
      }),
    });
    database.close();
  });

  it("revokes active sessions when a mapped user is demoted to viewer", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedMappings(database, [mapping()]);
    seedIdentity(database, { role: "operator", roleSource: "oidc_mapping", status: "active" });
    seedJellyfinLink(database);
    seedActiveSession(database, "identity-1", "user-1");

    const result = await resolve(database, service, claims({ groups: ["viewers"] }));

    expect(result).toMatchObject({
      role: "viewer",
      roleChanged: true,
      roleSource: "default",
      status: "resolved",
    });
    expect(database.db.select().from(sessions).get()?.revokedAt).toEqual(LOGIN_TIME);
    database.close();
  });

  it("denies disabled users without refreshing stored identity material", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    seedIdentity(database, {
      displayClaims: { displayName: "Before" },
      status: "disabled",
    });

    expect(await resolve(database, service, claims({ name: "After" }))).toEqual({
      reason: "disabled_user",
      status: "denied",
    });
    expect(database.db.select().from(externalIdentities).get()).toMatchObject({
      displayClaimsJson: JSON.stringify({ displayName: "Before" }),
      lastLoginAt: EARLIER_TIME,
    });
    database.close();
  });

  it("stores only normalized display claims and never audits assertion contents", async () => {
    const { database, service } = createHarness();
    seedProvider(database);

    const result = await resolve(
      database,
      service,
      claims({
        access_token: "private-token",
        email: " riley@example.test ",
        email_verified: true,
        groups: ["private-admin-group"],
        name: " Riley   Example ",
        phone_number: "+1-555-0100",
        preferred_username: " riley ",
        sub: "private-subject",
      }),
    );

    expect(result).toMatchObject({ status: "resolved" });
    expect(database.db.select().from(users).get()?.displayName).toBe("Riley Example");
    expect(database.db.select().from(externalIdentities).get()).toMatchObject({
      displayClaimsJson: JSON.stringify({
        displayName: "Riley Example",
        preferredUsername: "riley",
        email: "riley@example.test",
        emailVerified: true,
      }),
      subject: "private-subject",
    });
    const auditJson = JSON.stringify(readAudit(database));
    for (const secret of [
      "private-token",
      "riley@example.test",
      "private-admin-group",
      "private-subject",
      "+1-555-0100",
    ]) {
      expect(auditJson).not.toContain(secret);
    }
    database.close();
  });

  it("is idempotent across service instances using fresh one-time grants", async () => {
    const { database, service } = createHarness("first-fixture");
    seedProvider(database);
    const rawClaims = claims({ name: "First login" });

    const first = await resolve(database, service, rawClaims);
    let secondIdentifier = 0;
    const secondService = new OidcIdentityService(database, {
      clock: () => new Date(LOGIN_TIME.getTime() + 1_000),
      createId: () => `second-fixture-${(secondIdentifier += 1)}`,
      providerBindingVerifier: createOidcProviderRuntimeBindingVerifier(database, {
        encryptionKey: PROTOCOL_KEY,
      }),
    });
    const second = await resolve(database, secondService, rawClaims, { requestId: "request-2" });

    expect(first).toMatchObject({ provisioned: true, status: "resolved" });
    expect(second).toMatchObject({ provisioned: false, status: "resolved" });
    if (first.status === "resolved" && second.status === "resolved") {
      expect(second.attribution.userId).toBe(first.attribution.userId);
      expect(second.attribution.externalIdentityId).toBe(first.attribution.externalIdentityId);
    }
    expect(database.db.select().from(users).all()).toHaveLength(1);
    expect(database.db.select().from(externalIdentities).all()).toHaveLength(1);
    database.close();
  });

  it("rolls back JIT state when a uniqueness conflict occurs", async () => {
    const database = openDatabase(":memory:");
    database.migrate();
    seedProvider(database);
    database.db
      .insert(users)
      .values({ displayName: "Existing unrelated user", id: "duplicate-id" })
      .run();
    const service = new OidcIdentityService(database, {
      clock: () => new Date(LOGIN_TIME),
      createId: () => "duplicate-id",
      providerBindingVerifier: createOidcProviderRuntimeBindingVerifier(database, {
        encryptionKey: PROTOCOL_KEY,
      }),
    });
    const grant = await verifiedGrant(database, claims());

    expect(() => service.resolve({ grant, requestId: "request-1" })).toThrow(
      OidcIdentityServiceError,
    );
    expect(database.db.select().from(users).all()).toHaveLength(1);
    expect(database.db.select().from(externalIdentities).all()).toHaveLength(0);
    expect(readAudit(database)).toHaveLength(0);
    database.close();
  });

  it("consumes a genuine grant once and rejects forged, cloned, proxied, or replayed grants", async () => {
    const { database, service } = createHarness();
    seedProvider(database);
    const idTokenHint = compactIdToken("secret-grant-token");
    const sessionId = "secret-upstream-session";
    const grant = await verifiedGrant(database, claims({ sid: sessionId }), { idTokenHint });
    const copiedSymbols = Object.create(null) as Record<PropertyKey, unknown>;
    for (const symbol of Object.getOwnPropertySymbols(grant)) copiedSymbols[symbol] = true;
    const invalidGrants: unknown[] = [
      {},
      { ...grant },
      Object.create(grant) as object,
      copiedSymbols,
      new Proxy(grant, {}),
    ];

    expect(isVerifiedOidcGrant(grant)).toBe(true);
    expect(() => JSON.stringify(grant)).toThrow("Verified OIDC grants cannot be serialized.");
    for (const [index, invalidGrant] of invalidGrants.entries()) {
      expect(
        service.resolve({
          grant: invalidGrant as VerifiedOidcGrant,
          requestId: `invalid-request-${index}`,
        }),
      ).toEqual({ reason: "invalid_verified_context", status: "denied" });
    }

    const accepted = service.resolve({ grant, requestId: "valid-request" });
    expect(accepted).toMatchObject({ status: "resolved" });
    expect(isVerifiedOidcGrant(grant)).toBe(false);
    expect(service.resolve({ grant, requestId: "replayed-request" })).toEqual({
      reason: "invalid_verified_context",
      status: "denied",
    });
    expect(database.db.select().from(users).all()).toHaveLength(1);
    const auditJson = JSON.stringify(readAudit(database));
    expect(auditJson).not.toContain(idTokenHint);
    expect(auditJson).not.toContain(sessionId);
    expect(auditJson).not.toContain("subject-1");
    expect(readAudit(database).filter((event) => event.outcome === "denied")).toHaveLength(6);
    database.close();
  });

  it("burns a presented grant before validating a hostile ancillary request envelope", async () => {
    const { database, service } = createHarness("hostile-envelope-fixture");
    seedProvider(database);
    const idTokenHint = compactIdToken("hostile-envelope-token");
    const sessionId = "hostile-envelope-session";
    const grant = await verifiedGrant(database, claims({ sid: sessionId }), { idTokenHint });
    const hostileEnvelope = new Proxy(
      { grant, requestId: "unreachable-request" },
      {
        get(target, property, receiver) {
          if (property === "requestId") throw new Error("hostile request identifier getter");
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );

    expect(
      service.resolve(hostileEnvelope as unknown as Parameters<OidcIdentityService["resolve"]>[0]),
    ).toEqual({ reason: "invalid_request", status: "denied" });
    expect(isVerifiedOidcGrant(grant)).toBe(false);
    expect(service.resolve({ grant, requestId: "replay-after-invalid-envelope" })).toEqual({
      reason: "invalid_verified_context",
      status: "denied",
    });
    expect(database.db.select().from(users).all()).toHaveLength(0);
    const auditJson = JSON.stringify(readAudit(database));
    expect(auditJson).not.toContain(idTokenHint);
    expect(auditJson).not.toContain(sessionId);
    expect(auditJson).not.toContain("subject-1");
    expect(readAudit(database).map((event) => JSON.parse(event.metadataJson))).toEqual([
      { reason: "invalid_request" },
      { reason: "invalid_verified_context" },
    ]);
    database.close();
  });
});
