import {
  Configuration,
  type ClientAuth,
  type ClientMetadata,
  type ServerMetadata,
} from "openid-client";
import { describe, expect, it } from "vitest";
import { OidcAuthorizationTransactionService } from "../src/auth/oidc/authorization-transaction.js";
import { OidcIdentityService } from "../src/auth/oidc/identity-service.js";
import {
  createOidcProviderRuntimeBindingVerifier,
  OidcProviderRegistry,
  oidcProviderRuntimeBinding,
} from "../src/auth/oidc/provider-registry.js";
import { OidcProtocolService } from "../src/auth/oidc/protocol.js";
import { OidcSignInService, OidcSignInServiceError } from "../src/auth/oidc/sign-in-service.js";
import { InvitationService } from "../src/auth/invitation-service.js";
import type { AppConfig } from "../src/config.js";
import { SessionService } from "../src/auth/session-service.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  connectorConfigs,
  externalIdentities,
  oidcProviders,
  roleMappings,
  serviceIdentityLinks,
  sessionRotationAliases,
  sessionSecretReservations,
  sessions,
  users,
  invitations,
} from "../src/db/schema.js";
import { EnvelopeCipher, hashToken } from "../src/security/crypto.js";

const ISSUER = "https://id.example.test/application/o/omnifin/";
const LOGIN_TIME = new Date("2026-07-25T16:00:00.000Z");
const EARLIER_TIME = new Date("2026-07-25T15:00:00.000Z");
const ENCRYPTION_KEY = Buffer.alloc(32, 41);

function invitationConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: ENCRYPTION_KEY,
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 60 * 60 * 1_000,
      inactivityTtlMs: 10 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
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

function compactIdToken(payload = "verified-sign-in-fixture") {
  return ["header", Buffer.from(payload, "utf8").toString("base64url"), "signature"].join(".");
}

function providerMetadata(): ServerMetadata {
  const origin = new URL(ISSUER).origin;
  return {
    authorization_endpoint: `${origin}/application/o/authorize/`,
    code_challenge_methods_supported: ["S256"],
    end_session_endpoint: `${origin}/application/o/omnifin/end-session/`,
    grant_types_supported: ["authorization_code"],
    id_token_signing_alg_values_supported: ["RS256"],
    issuer: ISSUER,
    jwks_uri: `${origin}/application/o/omnifin/jwks/`,
    response_types_supported: ["code"],
    token_endpoint: `${origin}/application/o/token/`,
    token_endpoint_auth_methods_supported: ["none"],
  } as ServerMetadata;
}

function seedProvider(database: DatabaseHandle, allowJitProvisioning = true) {
  database.db
    .insert(oidcProviders)
    .values({
      allowJitProvisioning,
      approvedEndpointOriginsJson: JSON.stringify([new URL(ISSUER).origin]),
      clientId: "omnifin",
      createdAt: EARLIER_TIME,
      displayName: "Home identity",
      id: "oidc-home",
      issuer: ISSUER,
      slug: "home",
      updatedAt: EARLIER_TIME,
    })
    .run();
}

function seedExistingIdentity(
  database: DatabaseHandle,
  options: {
    role?: "admin" | "operator" | "requester" | "viewer";
    roleSource?: "default" | "manual" | "oidc_mapping";
    status?: "active" | "disabled" | "pending_link";
  } = {},
) {
  database.db
    .insert(users)
    .values({
      createdAt: EARLIER_TIME,
      displayName: "Existing viewer",
      id: "user-1",
      role: options.role ?? "requester",
      roleSource: options.roleSource ?? "manual",
      status: options.status ?? "active",
      updatedAt: EARLIER_TIME,
    })
    .run();
  database.db
    .insert(externalIdentities)
    .values({
      createdAt: EARLIER_TIME,
      displayClaimsJson: JSON.stringify({ name: "Existing viewer" }),
      id: "external-identity-1",
      issuer: ISSUER,
      lastLoginAt: EARLIER_TIME,
      providerId: "oidc-home",
      subject: "subject-1",
      updatedAt: EARLIER_TIME,
      userId: "user-1",
    })
    .run();
}

function seedJellyfinLink(database: DatabaseHandle) {
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
      externalDisplayName: "Existing viewer",
      externalServerId: "server-1",
      externalUserId: "jellyfin-user-1",
      externalUsername: "existing-viewer",
      healthState: "linked",
      id: "jellyfin-link-1",
      lastVerifiedAt: EARLIER_TIME,
      service: "jellyfin",
      tokenCreatedAt: EARLIER_TIME,
      updatedAt: EARLIER_TIME,
      userId: "user-1",
    })
    .run();
}

function seedOperatorMapping(database: DatabaseHandle) {
  database.db
    .insert(roleMappings)
    .values({
      claimPathJson: JSON.stringify(["groups"]),
      enabled: true,
      id: "operator-group",
      operator: "contains_any",
      priority: 100,
      providerId: "oidc-home",
      role: "operator",
      valuesJson: JSON.stringify(["media-operators"]),
    })
    .run();
}

async function verifiedGrant(
  database: DatabaseHandle,
  rawClaims: Readonly<Record<string, unknown>>,
  idTokenHint = compactIdToken(),
) {
  const runtime = await new OidcProviderRegistry(
    database,
    { encryptionKey: ENCRYPTION_KEY },
    {
      clock: () => new Date(LOGIN_TIME),
      discover: async (
        _issuer: URL,
        clientId: string,
        clientMetadata: Partial<ClientMetadata> | string | undefined,
        clientAuthentication: ClientAuth | undefined,
      ) => new Configuration(providerMetadata(), clientId, clientMetadata, clientAuthentication),
    },
  ).discover("oidc-home");
  const transactions = new OidcAuthorizationTransactionService(
    database,
    {
      baseUrl: new URL("https://omnifin.example"),
      encryptionKey: ENCRYPTION_KEY,
      environment: "test",
      insecureLoopbackPreview: false,
      secureCookies: true,
    },
    { clock: () => new Date(LOGIN_TIME) },
  );
  const created = await transactions.create({
    providerId: "oidc-home",
    providerRuntimeBinding: oidcProviderRuntimeBinding(runtime),
  });
  const transaction = transactions.consume({
    browserBindingToken: created.browserBindingToken,
    providerId: "oidc-home",
    state: created.state,
  });
  const callbackUrl = new URL(created.redirectUri);
  callbackUrl.searchParams.set("code", "authorization-code");
  callbackUrl.searchParams.set("state", created.state);
  return new OidcProtocolService({
    authorizationCodeGrant: async (_runtime, _callbackUrl, checks) => ({
      claims: { ...rawClaims, nonce: checks.expectedNonce },
      idToken: idTokenHint,
    }),
  }).completeAuthorization({ callbackUrl, runtime, transaction });
}

function createHarness(options: { allowJitProvisioning?: boolean } = {}) {
  const database = openDatabase(":memory:");
  database.migrate();
  seedProvider(database, options.allowJitProvisioning);
  let now = new Date(LOGIN_TIME);
  let identityIdentifier = 0;
  let sessionIdentifier = 0;
  let sessionToken = 0;
  const invitationService = new InvitationService(database, invitationConfig(), {
    clock: () => new Date(now),
    createHandoffToken: () => Buffer.alloc(32, 22).toString("base64url"),
  });
  const identityService = new OidcIdentityService(database, {
    clock: () => new Date(now),
    createId: () => `identity-sign-in-${(identityIdentifier += 1)}`,
    invitationService,
    providerBindingVerifier: createOidcProviderRuntimeBindingVerifier(database, {
      encryptionKey: ENCRYPTION_KEY,
    }),
  });
  const sessionService = new SessionService(
    database,
    {
      encryptionKey: ENCRYPTION_KEY,
      session: {
        absoluteTtlMs: 60 * 60 * 1_000,
        inactivityTtlMs: 10 * 60 * 1_000,
        recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
        rotationIntervalMs: 5 * 60 * 1_000,
      },
    },
    {
      clock: () => new Date(now),
      createId: () => `session-sign-in-${(sessionIdentifier += 1)}`,
      createToken: () => Buffer.alloc(32, (sessionToken += 1)).toString("base64url"),
    },
  );
  const service = new OidcSignInService(database, identityService, sessionService);
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    database,
    identityService,
    invitationService,
    service,
    sessionService,
  };
}

function issueInvitationHandoff(database: DatabaseHandle, invitationService: InvitationService) {
  const invitationToken = Buffer.alloc(32, 21).toString("base64url");
  database.db
    .insert(invitations)
    .values({
      createdAt: EARLIER_TIME,
      expiresAt: new Date(LOGIN_TIME.getTime() + 10 * 60_000),
      id: "invite_sign_in",
      tokenHash: hashToken(invitationToken),
    })
    .run();
  return invitationService.exchangeForRegistrationHandoff(invitationToken);
}

describe("OidcSignInService", () => {
  it("rejects an identity service from another database without consuming the verified grant", async () => {
    const primary = createHarness();
    const mismatched = createHarness();
    try {
      const grant = await verifiedGrant(primary.database, claims());

      expect(
        () =>
          new OidcSignInService(
            primary.database,
            mismatched.identityService,
            primary.sessionService,
          ),
      ).toThrow(OidcSignInServiceError);

      const handoff = issueInvitationHandoff(primary.database, primary.invitationService);
      expect(
        primary.service.signIn({
          grant,
          invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
        }),
      ).toMatchObject({ status: "signed_in" });
    } finally {
      mismatched.database.close();
      primary.database.close();
    }
  });

  it("rejects a session service from another database without consuming the verified grant", async () => {
    const primary = createHarness();
    const mismatched = createHarness();
    try {
      const grant = await verifiedGrant(primary.database, claims());

      expect(
        () =>
          new OidcSignInService(
            primary.database,
            primary.identityService,
            mismatched.sessionService,
          ),
      ).toThrow(OidcSignInServiceError);

      const handoff = issueInvitationHandoff(primary.database, primary.invitationService);
      expect(
        primary.service.signIn({
          grant,
          invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
        }),
      ).toMatchObject({ status: "signed_in" });
    } finally {
      mismatched.database.close();
      primary.database.close();
    }
  });

  it("keeps replacement capabilities opaque, same-database, transaction-scoped, and one-shot", () => {
    const primary = createHarness();
    const mismatched = createHarness();
    try {
      const prior = primary.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      let escapedCapability: unknown;

      primary.database.sqlite
        .transaction(() =>
          primary.sessionService.withSessionReplacementCapability(
            prior.sessionToken,
            (capability) => {
              if (!capability) throw new Error("Expected a replacement capability fixture.");
              escapedCapability = capability;
              expect(Object.keys(capability)).toEqual([]);
              expect({ ...capability }).toEqual({});
              expect(Object.getOwnPropertyDescriptor(capability, "toJSON")?.enumerable).toBe(false);
              expect(() => JSON.stringify(capability)).toThrow(
                "Session replacement capabilities cannot be serialized.",
              );
              expect(() =>
                primary.sessionService.verifyReplacementCapabilityForIdentity({}),
              ).toThrow();
              mismatched.database.sqlite
                .transaction(() => {
                  expect(() =>
                    mismatched.sessionService.verifyReplacementCapabilityForIdentity(capability),
                  ).toThrow();
                })
                .immediate();

              expect(
                primary.sessionService.verifyReplacementCapabilityForIdentity(capability),
              ).toMatchObject({ sessionId: prior.principal.sessionId });
              primary.sessionService.completeReplacementIdentityResolution(capability, "resolved");
              expect(
                primary.sessionService.replaceSessionWithCapability(capability, {
                  attribution: { authMethod: "recovery" },
                }),
              ).toMatchObject({ principal: { authenticationMethod: { kind: "recovery" } } });
              expect(() =>
                primary.sessionService.verifyReplacementCapabilityForIdentity(capability),
              ).toThrow();
              expect(() =>
                primary.sessionService.replaceSessionWithCapability(capability, {
                  attribution: { authMethod: "recovery" },
                }),
              ).toThrow();
            },
          ),
        )
        .immediate();

      expect(() =>
        primary.sessionService.verifyReplacementCapabilityForIdentity(escapedCapability),
      ).toThrow();
      primary.database.sqlite
        .transaction(() => {
          expect(() =>
            primary.sessionService.verifyReplacementCapabilityForIdentity(escapedCapability),
          ).toThrow();
        })
        .immediate();
    } finally {
      mismatched.database.close();
      primary.database.close();
    }
  });

  it("rejects an async replacement callback and rolls back its synchronous writes", () => {
    const { database, sessionService } = createHarness();
    try {
      const prior = sessionService.createSession({ attribution: { authMethod: "recovery" } });
      const baselineSessions = database.db.select().from(sessions).all();
      const baselineReservations = database.db.select().from(sessionSecretReservations).all();
      const baselineAudits = database.sqlite.prepare("select * from audit_events").all();

      expect(() =>
        database.sqlite
          .transaction(() =>
            sessionService.withSessionReplacementCapability(
              prior.sessionToken,
              async (capability) => {
                if (!capability) throw new Error("Expected a replacement capability fixture.");
                sessionService.verifyReplacementCapabilityForIdentity(capability);
                sessionService.completeReplacementIdentityResolution(capability, "resolved");
                return sessionService.replaceSessionWithCapability(capability, {
                  attribution: { authMethod: "recovery" },
                });
              },
            ),
          )
          .immediate(),
      ).toThrow("Session replacement callbacks must be synchronous.");

      expect(database.db.select().from(sessions).all()).toEqual(baselineSessions);
      expect(database.db.select().from(sessionSecretReservations).all()).toEqual(
        baselineReservations,
      );
      expect(database.sqlite.prepare("select * from audit_events").all()).toEqual(baselineAudits);
    } finally {
      database.close();
    }
  });

  it("requires exact replacement after resolved identity use while allowing identity denial", () => {
    const { database, sessionService } = createHarness();
    try {
      const prior = sessionService.createSession({ attribution: { authMethod: "recovery" } });

      expect(() =>
        database.sqlite
          .transaction(() =>
            sessionService.withSessionReplacementCapability(prior.sessionToken, (capability) => {
              if (!capability) throw new Error("Expected a replacement capability fixture.");
              sessionService.verifyReplacementCapabilityForIdentity(capability);
              sessionService.completeReplacementIdentityResolution(capability, "resolved");
              return "forgotten-replacement";
            }),
          )
          .immediate(),
      ).toThrow("Proven session replacement did not complete.");

      expect(
        database.sqlite
          .transaction(() =>
            sessionService.withSessionReplacementCapability(prior.sessionToken, (capability) => {
              if (!capability) throw new Error("Expected a replacement capability fixture.");
              sessionService.verifyReplacementCapabilityForIdentity(capability);
              sessionService.completeReplacementIdentityResolution(capability, "denied");
              return "denied" as const;
            }),
          )
          .immediate(),
      ).toBe("denied");
      expect(database.db.select().from(sessions).all()).toEqual([
        expect.objectContaining({ id: prior.principal.sessionId, revokedAt: null }),
      ]);
    } finally {
      database.close();
    }
  });

  it("atomically JIT provisions a pending-link identity and issues its opaque session", async () => {
    const { database, invitationService, service } = createHarness();
    try {
      const grant = await verifiedGrant(
        database,
        claims({ email: "new@example.test", name: "New viewer" }),
      );

      const handoff = issueInvitationHandoff(database, invitationService);
      const result = service.signIn({
        grant,
        invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
        ipAddress: "192.0.2.10",
        requestId: "jit-sign-in-request",
        userAgent: "Omnifin route test",
      });

      expect(result).toMatchObject({
        session: {
          principal: {
            accountState: "pending_link",
            authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
            displayName: "New viewer",
            role: "viewer",
          },
        },
        status: "signed_in",
      });
      expect(database.db.select().from(users).all()).toHaveLength(1);
      expect(database.db.select().from(externalIdentities).all()).toHaveLength(1);
      expect(database.db.select().from(sessions).all()).toHaveLength(1);
      expect(Object.keys(result)).toEqual([]);
      expect({ ...result }).toEqual({});
      expect(Object.getOwnPropertyDescriptor(result, "session")?.enumerable).toBe(false);
      if (result.status !== "signed_in") throw new Error("Expected a signed-in result fixture.");
      const spreadResult = JSON.stringify({ ...result });
      expect(spreadResult).not.toContain(result.session.sessionToken);
      expect(spreadResult).not.toContain(result.session.csrfToken);
      expect(() => JSON.stringify(service)).toThrow("OIDC sign-in services cannot be serialized.");
      expect(() => JSON.stringify(result)).toThrow("OIDC sign-in results cannot be serialized.");
    } finally {
      database.close();
    }
  });

  it("consumes an invitation handoff only for a new identity inside the immediate transaction", async () => {
    const { database, invitationService, service } = createHarness();
    try {
      const grant = await verifiedGrant(database, claims({ email: "invited@example.test" }));
      const handoff = issueInvitationHandoff(database, invitationService);

      const result = service.signIn({
        grant,
        invitation: {
          handoffToken: handoff.handoffToken,
          invitationId: handoff.invitationId,
        },
      });

      expect(result).toMatchObject({ status: "signed_in" });
      expect(database.db.select().from(users).all()).toHaveLength(1);
      expect(database.db.select().from(externalIdentities).all()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rejects an invitation for an already-linked identity without consuming it", async () => {
    const { database, invitationService, service } = createHarness();
    try {
      seedExistingIdentity(database, { status: "pending_link" });
      const grant = await verifiedGrant(database, claims());
      const handoff = issueInvitationHandoff(database, invitationService);

      expect(
        service.signIn({
          grant,
          invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
        }),
      ).toEqual(
        expect.objectContaining({ reason: "invitation_identity_already_linked", status: "denied" }),
      );
      expect(
        database.sqlite
          .prepare("select consumed_at as consumedAt from invitations where id = ?")
          .get(handoff.invitationId),
      ).toEqual({ consumedAt: null });
      expect(database.db.select().from(sessions).all()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rolls back invitation consumption when its audit write fails", async () => {
    const { database, invitationService, service } = createHarness();
    try {
      const grant = await verifiedGrant(database, claims({ email: "rollback@example.test" }));
      const handoff = issueInvitationHandoff(database, invitationService);
      database.sqlite.exec(`
        create trigger reject_invitation_consumed_audit
        before insert on audit_events
        when new.event_type = 'auth.invitation.consumed'
        begin
          select raise(abort, 'forced_invitation_audit_failure');
        end
      `);

      expect(() =>
        service.signIn({
          grant,
          invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
        }),
      ).toThrow(OidcSignInServiceError);
      expect(
        database.sqlite
          .prepare("select consumed_at as consumedAt from invitations where id = ?")
          .get(handoff.invitationId),
      ).toEqual({ consumedAt: null });
      expect(database.db.select().from(users).all()).toHaveLength(0);
      expect(database.db.select().from(externalIdentities).all()).toHaveLength(0);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("signs in an active existing user with its proven Jellyfin context", async () => {
    const { database, service } = createHarness();
    try {
      seedExistingIdentity(database);
      seedJellyfinLink(database);
      const grant = await verifiedGrant(database, claims({ name: "Updated display name" }));

      const result = service.signIn({ grant, requestId: "existing-sign-in-request" });

      expect(result).toMatchObject({
        session: {
          principal: {
            accountState: "active",
            linkedServices: [{ id: "jellyfin-link-1", health: "linked" }],
            role: "requester",
            userId: "user-1",
          },
        },
        status: "signed_in",
      });
      expect(database.db.select().from(users).all()).toHaveLength(1);
      expect(database.db.select().from(sessions).all()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("returns a typed denial without issuing a session or duplicating route-level audit", async () => {
    const { database, service } = createHarness({ allowJitProvisioning: false });
    try {
      const grant = await verifiedGrant(database, claims());

      const result = service.signIn({ grant, requestId: "denied-sign-in-request" });

      expect(result).toEqual(
        expect.objectContaining({ reason: "jit_provisioning_disabled", status: "denied" }),
      );
      expect(Object.keys(result)).toEqual([]);
      expect({ ...result }).toEqual({});
      expect(database.db.select().from(users).all()).toHaveLength(0);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });
      expect(() => JSON.stringify(result)).toThrow("OIDC sign-in results cannot be serialized.");
    } finally {
      database.close();
    }
  });

  it("preserves a proven current session when identity resolution is denied", async () => {
    const { database, service, sessionService } = createHarness({ allowJitProvisioning: false });
    try {
      const prior = sessionService.createSession({ attribution: { authMethod: "recovery" } });
      const grant = await verifiedGrant(database, claims());

      expect(
        service.signIn({
          currentSessionToken: prior.sessionToken,
          grant,
          requestId: "denied-preserved-session-request",
        }),
      ).toEqual(expect.objectContaining({ reason: "jit_provisioning_disabled", status: "denied" }));

      expect(database.db.select().from(sessions).all()).toEqual([
        expect.objectContaining({ id: prior.principal.sessionId, revokedAt: null }),
      ]);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.oidc.identity.denied'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("preserves non-enumerable ID-token and sid proofs through encrypted session storage", async () => {
    const { database, service } = createHarness();
    try {
      seedExistingIdentity(database);
      seedJellyfinLink(database);
      const idTokenHint = compactIdToken("private-sign-in-id-token");
      const oidcSessionId = "private-upstream-session";
      const grant = await verifiedGrant(database, claims({ sid: oidcSessionId }), idTokenHint);

      const result = service.signIn({ grant, requestId: "proof-sign-in-request" });
      if (result.status !== "signed_in") throw new Error("Expected a signed-in result fixture.");
      const stored = database.db.select().from(sessions).get();

      expect(stored?.encryptedIdTokenHint).toMatch(/^v2\./);
      expect(
        new EnvelopeCipher(ENCRYPTION_KEY).decrypt(
          stored?.encryptedIdTokenHint ?? "",
          `session:${stored?.id}:oidc-id-token-hint`,
        ),
      ).toBe(idTokenHint);
      expect(stored?.oidcSessionIdHash).toHaveLength(22);
      expect(stored?.oidcSessionIdHash).not.toBe(oidcSessionId);
      expect(JSON.stringify(stored)).not.toContain(idTokenHint);
      expect(JSON.stringify(stored)).not.toContain(oidcSessionId);
    } finally {
      database.close();
    }
  });

  it("rolls back JIT identity and audit writes while leaving a failed grant one-shot", async () => {
    const { database, invitationService, service } = createHarness();
    try {
      const grant = await verifiedGrant(database, claims());
      const handoff = issueInvitationHandoff(database, invitationService);
      database.sqlite.exec(`
        create trigger reject_oidc_session
        before insert on sessions
        begin
          select raise(abort, 'forced_session_failure');
        end
      `);

      expect(() =>
        service.signIn({
          grant,
          invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
          requestId: "failed-jit-request",
        }),
      ).toThrow(OidcSignInServiceError);

      expect(database.db.select().from(users).all()).toHaveLength(0);
      expect(database.db.select().from(externalIdentities).all()).toHaveLength(0);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });

      database.sqlite.exec("drop trigger reject_oidc_session");
      expect(service.signIn({ grant, requestId: "replayed-jit-request" })).toEqual(
        expect.objectContaining({ reason: "invalid_verified_context", status: "denied" }),
      );
      expect(database.db.select().from(users).all()).toHaveLength(0);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rolls back the inserted session, reservations, identity, and audits when session auditing fails", async () => {
    const { database, invitationService, service } = createHarness();
    try {
      const grant = await verifiedGrant(database, claims());
      const handoff = issueInvitationHandoff(database, invitationService);
      database.sqlite.exec(`
        create trigger reject_session_audit
        before insert on audit_events
        when new.event_type = 'auth.session.created'
        begin
          select raise(abort, 'forced_session_audit_failure');
        end
      `);

      expect(() =>
        service.signIn({
          grant,
          invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
          requestId: "failed-audit-request",
        }),
      ).toThrow(OidcSignInServiceError);

      expect(database.db.select().from(users).all()).toHaveLength(0);
      expect(database.db.select().from(externalIdentities).all()).toHaveLength(0);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);
      expect(database.db.select().from(sessionSecretReservations).all()).toHaveLength(0);
      expect(database.db.select().from(sessionRotationAliases).all()).toHaveLength(0);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("replaces the user's current OIDC session after a successful mapped-role transition", async () => {
    const { database, service, sessionService } = createHarness();
    try {
      seedExistingIdentity(database, { role: "viewer", roleSource: "oidc_mapping" });
      seedJellyfinLink(database);
      seedOperatorMapping(database);
      const prior = sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "external-identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      const grant = await verifiedGrant(database, claims({ groups: ["media-operators"] }));

      const result = service.signIn({
        currentSessionToken: prior.sessionToken,
        grant,
        requestId: "successful-role-change-request",
      });

      expect(result).toMatchObject({
        session: {
          principal: {
            role: "operator",
            userId: "user-1",
          },
        },
        status: "signed_in",
      });
      expect(database.db.select().from(users).get()).toMatchObject({
        role: "operator",
        roleSource: "oidc_mapping",
        updatedAt: LOGIN_TIME,
      });
      expect(database.db.select().from(sessions).all()).toEqual([
        expect.objectContaining({ id: prior.principal.sessionId, revokedAt: LOGIN_TIME }),
        expect.objectContaining({ authMethod: "oidc", revokedAt: null }),
      ]);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("rolls back a mapped-role replacement when its late replacement audit fails", async () => {
    const { advance, database, service, sessionService } = createHarness();
    try {
      seedExistingIdentity(database, { role: "viewer", roleSource: "oidc_mapping" });
      seedJellyfinLink(database);
      seedOperatorMapping(database);
      const prior = sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "external-identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      advance(6 * 60 * 1_000);
      const rotated = sessionService.resolveAndRefresh(prior.sessionToken);
      expect(rotated?.rotatedSessionToken).toBeTypeOf("string");
      const grant = await verifiedGrant(database, claims({ groups: ["media-operators"] }));
      const baselineSessions = database.db.select().from(sessions).all();
      const baselineReservations = database.db.select().from(sessionSecretReservations).all();
      const baselineAliases = database.db.select().from(sessionRotationAliases).all();
      const baselineAudits = database.sqlite.prepare("select * from audit_events").all();
      database.sqlite.exec(`
        create trigger reject_late_replacement_audit
        before insert on audit_events
        when new.event_type = 'auth.session.replaced'
        begin
          select raise(abort, 'forced_late_replacement_audit_failure');
        end
      `);

      expect(() =>
        service.signIn({
          currentSessionToken: prior.sessionToken,
          grant,
          requestId: "failed-late-replacement-request",
        }),
      ).toThrow(OidcSignInServiceError);

      expect(database.db.select().from(users).get()).toMatchObject({
        role: "viewer",
        roleSource: "oidc_mapping",
        updatedAt: EARLIER_TIME,
      });
      expect(database.db.select().from(externalIdentities).get()).toMatchObject({
        lastLoginAt: EARLIER_TIME,
        updatedAt: EARLIER_TIME,
      });
      expect(database.db.select().from(sessions).all()).toEqual(baselineSessions);
      expect(database.db.select().from(sessionSecretReservations).all()).toEqual(
        baselineReservations,
      );
      expect(database.db.select().from(sessionRotationAliases).all()).toEqual(baselineAliases);
      expect(database.sqlite.prepare("select * from audit_events").all()).toEqual(baselineAudits);
      expect(sessionService.resolveAndRefresh(prior.sessionToken)).toMatchObject({
        principal: { sessionId: prior.principal.sessionId },
      });
      expect(sessionService.resolveAndRefresh(rotated?.rotatedSessionToken)).toMatchObject({
        principal: { sessionId: prior.principal.sessionId },
      });
    } finally {
      database.close();
    }
  });

  it("never falls back to issuance when the exact proven session cannot be revoked", async () => {
    const { database, service, sessionService } = createHarness();
    try {
      seedExistingIdentity(database, { role: "viewer", roleSource: "oidc_mapping" });
      seedJellyfinLink(database);
      seedOperatorMapping(database);
      const prior = sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "external-identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      const grant = await verifiedGrant(database, claims({ groups: ["media-operators"] }));
      const baselineSessions = database.db.select().from(sessions).all();
      const baselineReservations = database.db.select().from(sessionSecretReservations).all();
      const baselineAudits = database.sqlite.prepare("select * from audit_events").all();
      database.sqlite.exec(`
        create trigger reject_exact_session_revocation
        before update of revoked_at on sessions
        when old.id = '${prior.principal.sessionId}' and new.revoked_at is not null
        begin
          select raise(abort, 'forced_exact_session_revocation_failure');
        end
      `);

      expect(() =>
        service.signIn({
          currentSessionToken: prior.sessionToken,
          grant,
          requestId: "failed-exact-revocation-request",
        }),
      ).toThrow(OidcSignInServiceError);

      expect(database.db.select().from(users).get()).toMatchObject({
        role: "viewer",
        roleSource: "oidc_mapping",
        updatedAt: EARLIER_TIME,
      });
      expect(database.db.select().from(externalIdentities).get()).toMatchObject({
        lastLoginAt: EARLIER_TIME,
        updatedAt: EARLIER_TIME,
      });
      expect(database.db.select().from(sessions).all()).toEqual(baselineSessions);
      expect(database.db.select().from(sessionSecretReservations).all()).toEqual(
        baselineReservations,
      );
      expect(database.sqlite.prepare("select * from audit_events").all()).toEqual(baselineAudits);
    } finally {
      database.close();
    }
  });

  it("rolls back role changes and prior-session revocation when replacement cannot be issued", async () => {
    const { database, service, sessionService } = createHarness();
    try {
      seedExistingIdentity(database, { role: "viewer", roleSource: "oidc_mapping" });
      seedJellyfinLink(database);
      seedOperatorMapping(database);
      const prior = sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "external-identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      const baselineAuditCount = database.sqlite
        .prepare("select count(*) as count from audit_events")
        .get() as { count: number };
      const baselineReservationCount = database.db
        .select()
        .from(sessionSecretReservations)
        .all().length;
      const grant = await verifiedGrant(database, claims({ groups: ["media-operators"] }));
      database.sqlite.exec(`
        create trigger reject_role_change_session
        before insert on sessions
        begin
          select raise(abort, 'forced_role_change_session_failure');
        end
      `);

      expect(() =>
        service.signIn({
          currentSessionToken: prior.sessionToken,
          grant,
          requestId: "failed-role-change-request",
        }),
      ).toThrow(OidcSignInServiceError);

      expect(database.db.select().from(users).get()).toMatchObject({
        role: "viewer",
        roleSource: "oidc_mapping",
        updatedAt: EARLIER_TIME,
      });
      expect(database.db.select().from(externalIdentities).get()).toMatchObject({
        lastLoginAt: EARLIER_TIME,
        updatedAt: EARLIER_TIME,
      });
      expect(database.db.select().from(sessions).all()).toEqual([
        expect.objectContaining({ id: prior.principal.sessionId, revokedAt: null }),
      ]);
      expect(database.db.select().from(sessionSecretReservations).all()).toHaveLength(
        baselineReservationCount,
      );
      expect(database.db.select().from(sessionRotationAliases).all()).toHaveLength(0);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual(
        baselineAuditCount,
      );
    } finally {
      database.close();
    }
  });

  it.each(["current", "rotation-grace"] as const)(
    "replaces a %s session token after successful OIDC authentication",
    async (tokenState) => {
      const { advance, database, invitationService, service, sessionService } = createHarness();
      try {
        const prior = sessionService.createSession({ attribution: { authMethod: "recovery" } });
        if (tokenState === "rotation-grace") {
          advance(6 * 60 * 1_000);
          expect(
            sessionService.resolveAndRefresh(prior.sessionToken)?.rotatedSessionToken,
          ).toBeTypeOf("string");
          expect(database.db.select().from(sessionRotationAliases).all()).toHaveLength(1);
        }
        const grant = await verifiedGrant(database, claims());
        const handoff = issueInvitationHandoff(database, invitationService);

        const result = service.signIn({
          currentSessionToken: prior.sessionToken,
          grant,
          invitation: { handoffToken: handoff.handoffToken, invitationId: handoff.invitationId },
          requestId: `${tokenState}-replacement-request`,
        });

        expect(result).toMatchObject({
          session: {
            principal: { authenticationMethod: { kind: "oidc", providerId: "oidc-home" } },
          },
          status: "signed_in",
        });
        expect(database.db.select().from(sessions).all()).toEqual([
          expect.objectContaining({ id: prior.principal.sessionId, revokedAt: expect.any(Date) }),
          expect.objectContaining({ authMethod: "oidc", revokedAt: null }),
        ]);
        expect(database.db.select().from(sessionRotationAliases).all()).toHaveLength(0);
      } finally {
        database.close();
      }
    },
  );

  it("reuses the pre-expiry grace proof timestamp when the callback crosses the boundary", async () => {
    const { advance, database, service, sessionService } = createHarness();
    try {
      seedExistingIdentity(database, { role: "viewer", roleSource: "oidc_mapping" });
      seedJellyfinLink(database);
      seedOperatorMapping(database);
      const prior = sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "external-identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      advance(6 * 60 * 1_000);
      expect(sessionService.resolveAndRefresh(prior.sessionToken)?.rotatedSessionToken).toBeTypeOf(
        "string",
      );
      advance(9_999);
      const grant = await verifiedGrant(database, claims({ groups: ["media-operators"] }));

      const result = service.signIn({
        currentSessionToken: prior.sessionToken,
        get grant() {
          advance(2);
          return grant;
        },
        requestId: "pre-expiry-grace-request",
      });

      expect(result).toMatchObject({
        session: { principal: { role: "operator", userId: "user-1" } },
        status: "signed_in",
      });
      expect(database.db.select().from(sessions).all()).toEqual([
        expect.objectContaining({
          id: prior.principal.sessionId,
          revokedAt: new Date(LOGIN_TIME.getTime() + 6 * 60 * 1_000 + 9_999),
        }),
        expect.objectContaining({
          createdAt: new Date(LOGIN_TIME.getTime() + 6 * 60 * 1_000 + 9_999),
          revokedAt: null,
        }),
      ]);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("does not preserve a grace token presented at its exact expiry boundary", async () => {
    const { advance, database, service, sessionService } = createHarness();
    try {
      seedExistingIdentity(database);
      seedJellyfinLink(database);
      const prior = sessionService.createSession({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "external-identity-1",
          oidcProviderId: "oidc-home",
          serviceIdentityLinkId: "jellyfin-link-1",
          userId: "user-1",
        },
      });
      advance(6 * 60 * 1_000);
      expect(sessionService.resolveAndRefresh(prior.sessionToken)?.rotatedSessionToken).toBeTypeOf(
        "string",
      );
      advance(10_000);
      const grant = await verifiedGrant(database, claims());

      expect(
        service.signIn({
          currentSessionToken: prior.sessionToken,
          grant,
          requestId: "expired-grace-request",
        }),
      ).toMatchObject({ status: "signed_in" });

      expect(database.db.select().from(sessions).all()).toEqual([
        expect.objectContaining({ id: prior.principal.sessionId, revokedAt: null }),
        expect.objectContaining({ authMethod: "oidc", revokedAt: null }),
      ]);
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.replaced'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
