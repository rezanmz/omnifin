import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JellyfinProvisioningAdminClient } from "@omnifin/connectors/auth/jellyfin-provisioning-admin-client";
import { SessionService } from "../src/auth/session-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { InviteBackedOidcActivationService } from "../src/operations/invite-backed-oidc-activation-service.js";
import { JellyfinActivationOperationRepository } from "../src/operations/jellyfin-activation-operation.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const key = Buffer.alloc(32, 0x5a);
const config: Pick<AppConfig, "encryptionKey" | "session"> = {
  encryptionKey: key,
  session: {
    absoluteTtlMs: 60 * 60 * 1_000,
    inactivityTtlMs: 30 * 60 * 1_000,
    recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
    rotationIntervalMs: 5 * 60 * 1_000,
  },
};
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture(
  expiry = 8_640_000_000_000_000,
  options: { prepareOperation?: boolean; bindMarker?: boolean } = {},
) {
  const database = openDatabase(":memory:");
  database.migrate();
  const cipher = new EnvelopeCipher(key);
  const serverId = "server-1";
  const identityHash = createHmac("sha256", key)
    .update("omnifin:v1:connector-instance-identity\x00", "utf8")
    .update(serverId, "utf8")
    .digest("base64url");
  const connectorRevision = createHash("sha256")
    .update("jellyfin\x00activation-connector\x000", "utf8")
    .digest("base64url");
  database.sqlite.exec(`
    insert into oidc_providers (
      id, slug, display_name, issuer, client_id, approved_endpoint_origins_json,
      discovery_state, discovery_capabilities_json, discovery_checked_at, enabled, created_at, updated_at
    ) values (
      'activation-provider', 'activation-provider', 'Activation Provider',
      'https://issuer.example', 'client', '["https://issuer.example"]',
      'ready', '{"authorizationCode":true}', 1, 1, 1, 1
    );
    insert into users (id, display_name, role, role_source, status, created_at, updated_at)
      values ('activation-user', 'Activation User', 'viewer', 'default', 'pending_link', 1, 1);
    insert into external_identities (
      id, user_id, provider_id, issuer, subject, display_claims_json,
      last_login_at, created_at, updated_at
    ) values (
      'activation-identity', 'activation-user', 'activation-provider',
      'https://issuer.example', 'activation-subject', '{}', 1, 1, 1
    );
    insert into connector_configs (
      id, type, display_name, base_url, encrypted_credentials,
      instance_generation, config_generation, instance_identity_hash,
      insecure_http_approved, tls_policy, enabled, created_at, updated_at
    ) values (
      'activation-connector', 'jellyfin', 'Activation Jellyfin',
      'https://jellyfin.example', '${cipher.encrypt(
        JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }),
        "connector_credentials:jellyfin:activation-connector",
      )}', 0, 0, '${identityHash}', 0, 'strict', 1, 1, 1
    );
    insert into jellyfin_provisioning_configs (
      connector_id, connector_revision, connector_instance_generation,
      connector_instance_identity_hash, encrypted_configuration, revision,
      created_at, updated_at
    ) values ('activation-connector', '${connectorRevision}', 0, '${identityHash}', '${cipher.encrypt(
      JSON.stringify({
        credential: { accessToken: "admin-token", kind: "access_token" },
        enabled: true,
        protocolVersion: "10.11",
        schemaVersion: 2,
        template: { policy: { IsAdministrator: false } },
      }),
      `jellyfin_provisioning:activation-connector:${connectorRevision}:0:${identityHash}`,
    )}', 1, 1, 1);
    insert into invitations (id, token_hash, expires_at, consumed_at, created_at)
      values ('invite_activation_test', '${"i".repeat(43)}', ${expiry}, 100, 1);
  `);

  let now = 100;
  const sessions = new SessionService(database, config, { clock: () => new Date(now) });
  const pending = sessions.createSession({
    attribution: {
      authMethod: "oidc",
      externalIdentityId: "activation-identity",
      oidcProviderId: "activation-provider",
      userId: "activation-user",
    },
  });
  const pairing = sessions.beginValidatedOidcPairingSession(
    sessions.validateSessionCsrf(pending.sessionToken, pending.csrfToken)!,
  )!;
  const repository = new JellyfinActivationOperationRepository(database.sqlite, key);
  if (options.prepareOperation !== false) {
    const reservation = {
      connectorConfigGeneration: 0,
      connectorId: "activation-connector",
      connectorInstanceGeneration: 0,
      connectorInstanceIdentityHash: identityHash,
      externalIdentityId: "activation-identity",
      id: "jellyfin_activation_test",
      invitationClaimedAt: 100,
      invitationId: "invite_activation_test",
      leaseExpiresAt: 200,
      leaseOwner: "fixture-owner",
      now: 100,
      pendingOidcSessionId: pairing.sessionId,
      provisioningRevision: 1,
      userId: "activation-user",
    } as const;
    if (options.bindMarker) {
      database.sqlite.transaction(() => repository.reserveInExistingTransaction(reservation))();
    } else {
      repository.reserve(reservation);
    }
    repository.dispatchCreate({
      id: "jellyfin_activation_test",
      leaseOwner: "fixture-owner",
      now: 102,
    });
    repository.recordCreatedIdArtifact({
      id: "jellyfin_activation_test",
      createdId: "upstream-user",
      now: 103,
    });
    repository.recordStageArtifact({
      artifact: { createdId: "upstream-user", password: "password", username: "activation-user" },
      id: "jellyfin_activation_test",
      now: 104,
      state: "created",
    });
    repository.recordStageArtifact({
      artifact: { createdId: "upstream-user", password: "password", username: "activation-user" },
      id: "jellyfin_activation_test",
      now: 105,
      state: "policy_pending",
    });
    repository.recordStageArtifact({
      artifact: {
        accessToken: "upstream-access-token",
        createdId: "upstream-user",
        serverId: "server-1",
        username: "activation-user",
      },
      id: "jellyfin_activation_test",
      now: 106,
      state: "auth_pending",
    });
  }
  cleanup.push(() => database.close());

  return {
    advance(value: number) {
      now = value;
    },
    database,
    pairing,
    pending,
    repository,
    sessions,
  };
}

function activationWithClock(
  fixtureValue: ReturnType<typeof fixture>,
  afterSagaReturn?: () => void,
) {
  const dependencies = {
    clock: () => 100,
    createId: () => "activation-link",
    leaseOwner: "activation-test",
    ...(afterSagaReturn ? { afterSagaReturn } : {}),
  };
  return new InviteBackedOidcActivationService(
    fixtureValue.database,
    config,
    dependencies,
    {
      verifyExistingIdentityInExistingTransaction: () => ({
        externalIdentityId: "activation-identity",
        providerId: "activation-provider",
        userId: "activation-user",
      }),
    } as never,
    fixtureValue.sessions,
  );
}

function client(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    authenticateCreatedUser: vi.fn(async () => ({
      accessToken: "upstream-access-token",
      serverId: "server-1",
      userId: "upstream-user",
    })),
    applyUserPolicy: vi.fn(async () => undefined),
    createUser: vi.fn(async () => "upstream-user"),
    deleteUser: vi.fn(async () => "deleted" as const),
    readServerIdentity: vi.fn(async () => "server-1"),
    ...overrides,
  } as unknown as JellyfinProvisioningAdminClient;
}

function completeActivation(
  value: ReturnType<typeof fixture>,
  fakeClient: JellyfinProvisioningAdminClient,
  extra: {
    finalizationFailpoint?: (
      stage:
        | "before_link"
        | "after_link_insert"
        | "after_user_activation"
        | "after_session_replacement"
        | "after_operation_completion",
    ) => void;
  } = {},
) {
  const createId = vi
    .fn()
    .mockReturnValueOnce("activation-operation")
    .mockReturnValue("activation-link");
  return new InviteBackedOidcActivationService(
    value.database,
    config,
    {
      clock: () => 100,
      createClient: () => fakeClient,
      createId,
      leaseOwner: "activation-test",
      ...extra,
    },
    {
      resolveInExistingTransaction: () => ({
        attribution: {
          authMethod: "oidc",
          externalIdentityId: "activation-identity",
          oidcProviderId: "activation-provider",
          userId: "activation-user",
        },
        status: "resolved",
      }),
      verifyExistingIdentityInExistingTransaction: () => ({
        externalIdentityId: "activation-identity",
        providerId: "activation-provider",
        userId: "activation-user",
      }),
    } as never,
    value.sessions,
  );
}

const grant = {} as never;

describe("InviteBackedOidcActivationService hardening", () => {
  it("completes an eligible invitation and exposes only the internal activation outcome", async () => {
    const value = fixture(8_640_000_000_000_000, { prepareOperation: false });
    const fake = client();
    const result = await completeActivation(value, fake).complete({
      grant,
      handoffToken: "handoff-token",
      invitationId: "invite_activation_test",
      ipAddress: "192.0.2.10",
      requestId: "activation-request",
      userAgent: "activation-test",
    });

    expect("status" in result).toBe(false);
    if ("status" in result) throw new Error("expected activation result");
    expect(result).toMatchObject({ disposition: "active" });
    if (result.disposition !== "active") throw new Error("expected active result");
    expect(result.session.principal).toMatchObject({
      accountState: "active",
      authenticationMethod: { kind: "oidc" },
      linkedServices: [expect.objectContaining({ id: "activation-link", service: "jellyfin" })],
      userId: "activation-user",
    });
    expect(fake.createUser).toHaveBeenCalledTimes(1);
    expect(fake.applyUserPolicy).toHaveBeenCalledTimes(1);
    expect(fake.authenticateCreatedUser).toHaveBeenCalledTimes(1);

    const link = value.database.sqlite
      .prepare(
        "select id, encrypted_access_token as ciphertext from service_identity_links where user_id = ?",
      )
      .get("activation-user") as { ciphertext: string; id: string };
    expect(link.id).toBe("activation-link");
    expect(() => new EnvelopeCipher(key).decrypt(link.ciphertext, "wrong-context")).toThrow();
    expect(
      new EnvelopeCipher(key).decrypt(
        link.ciphertext,
        "service_identity_access_token:jellyfin:activation-link",
      ),
    ).toBe("upstream-access-token");
    expect(
      value.database.sqlite.prepare("select status from users where id = ?").get("activation-user"),
    ).toEqual({ status: "active" });
    expect(value.repository.read("jellyfin_activation-operation")).toMatchObject({
      activationStatus: "completed",
      state: "tombstoned",
    });
    expect(
      value.database.sqlite
        .prepare(
          "select encrypted_stage_artifact as artifact, cleanup_eligible as cleanup from jellyfin_activation_operations where id = ?",
        )
        .get("jellyfin_activation-operation"),
    ).toEqual({ artifact: null, cleanup: 0 });
    expect(Object.keys(result)).toEqual([]);
    expect(() => JSON.stringify(result)).toThrow(TypeError);
    const publicText = JSON.stringify({
      disposition: result.disposition,
      reason: result.saga.reason,
    });
    expect(publicText).not.toContain("upstream-user");
    expect(publicText).not.toContain("upstream-access-token");
    expect(publicText).not.toContain("password");
    expect(publicText).not.toContain("Activation Provider");
    const audits = value.database.sqlite
      .prepare("select metadata_json as metadata from audit_events")
      .all() as Array<{ metadata: string }>;
    expect(JSON.stringify(audits)).not.toMatch(
      /upstream-user|upstream-access-token|password|ciphertext/,
    );
  });

  it("keeps a valid pending session when provisioning cannot be reached", async () => {
    const value = fixture(8_640_000_000_000_000, { prepareOperation: false });
    const fake = client({
      readServerIdentity: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const result = await completeActivation(value, fake).complete({
      grant,
      handoffToken: "handoff-token",
      invitationId: "invite_activation_test",
    });

    expect("status" in result).toBe(false);
    if ("status" in result) throw new Error("expected activation result");
    expect(result).toMatchObject({
      disposition: "pending_link",
      saga: { disposition: "manual_pairing", reason: "connector_unavailable" },
    });
    if (result.disposition !== "pending_link") throw new Error("expected pending result");
    expect(
      value.sessions.resumeIssuedOidcPairingSession(
        result.session.sessionToken,
        "activation-user",
        "activation-identity",
      ),
    ).not.toBeNull();
    expect(
      value.database.sqlite.prepare("select status from users where id = ?").get("activation-user"),
    ).toEqual({
      status: "pending_link",
    });
    expect(
      value.database.sqlite.prepare("select count(*) as count from service_identity_links").get(),
    ).toEqual({
      count: 0,
    });
    expect(Object.keys(result)).toEqual([]);
    expect(() => JSON.stringify(result)).toThrow(TypeError);
    expect(
      JSON.stringify({ disposition: result.saga.disposition, reason: result.saga.reason }),
    ).not.toContain("offline");
  });

  it.each([
    "after_link_insert",
    "after_user_activation",
    "after_session_replacement",
    "after_operation_completion",
  ] as const)("rolls back finalization at %s", async (stage) => {
    const value = fixture(8_640_000_000_000_000, { prepareOperation: false });
    const fake = client();
    const result = await completeActivation(value, fake, {
      finalizationFailpoint: (current) => {
        if (current === stage) throw new Error(`failpoint:${stage}`);
      },
    }).complete({
      grant,
      handoffToken: "handoff-token",
      invitationId: "invite_activation_test",
    });

    expect("status" in result).toBe(false);
    if ("status" in result) throw new Error("expected activation result");
    expect(result).toMatchObject({
      disposition: "pending_link",
      saga: { disposition: "activated_ready" },
    });
    if (result.disposition !== "pending_link") throw new Error("expected pending result");
    expect(value.repository.read("jellyfin_activation-operation")).toMatchObject({
      activationStatus: "pending",
      state: "auth_pending",
    });
    expect(value.repository.readStageArtifact("jellyfin_activation-operation")).toMatchObject({
      accessToken: "upstream-access-token",
      createdId: "upstream-user",
    });
    expect(
      value.database.sqlite.prepare("select status from users where id = ?").get("activation-user"),
    ).toEqual({
      status: "pending_link",
    });
    expect(
      value.database.sqlite.prepare("select count(*) as count from service_identity_links").get(),
    ).toEqual({
      count: 0,
    });
    expect(
      value.database.sqlite
        .prepare("select revoked_at as revokedAt from sessions where id = ?")
        .get(result.session.principal.sessionId),
    ).toEqual({ revokedAt: null });
  });

  it("resumes auth_pending directly without repeating upstream work or admission", async () => {
    const value = fixture(8_640_000_000_000_000, { bindMarker: true });
    const fake = client();
    const stages: string[] = [];
    const service = completeActivation(value, fake, {
      finalizationFailpoint: (stage) => stages.push(stage),
    });
    expect(
      value.sessions.resumeValidatedOidcPairingSessionById(
        value.pairing.sessionId,
        "activation-user",
        "activation-identity",
        "activation-provider",
        value.pairing.sessionId,
      ),
    ).not.toBeNull();
    const result = await service.resume({
      activationOperationId: "jellyfin_activation_test",
      grant,
      pendingOidcSessionId: value.pairing.sessionId,
    });

    if (!result)
      throw new Error(
        `stages=${stages.join(",")}; operation=${value.repository.read("jellyfin_activation_test")?.state}; session=${JSON.stringify(
          value.database.sqlite
            .prepare(
              "select id, user_id as userId, external_identity_id as externalIdentityId, oidc_provider_id as providerId, revoked_at as revokedAt from sessions where id = ?",
            )
            .get(value.pairing.sessionId),
        )}`,
      );
    expect(result).toMatchObject({ disposition: "active" });
    expect(fake.createUser).not.toHaveBeenCalled();
    expect(fake.applyUserPolicy).not.toHaveBeenCalled();
    expect(fake.authenticateCreatedUser).not.toHaveBeenCalled();
    expect(value.repository.read("jellyfin_activation_test")).toMatchObject({
      activationStatus: "completed",
      state: "tombstoned",
    });
    expect(
      value.database.sqlite.prepare("select status from users where id = ?").get("activation-user"),
    ).toEqual({
      status: "active",
    });
    expect(
      value.database.sqlite
        .prepare("select revoked_at as revokedAt from sessions where id = ?")
        .get(value.pairing.sessionId),
    ).toMatchObject({ revokedAt: 100 });
    expect(
      value.database.sqlite
        .prepare("select count(*) as count from jellyfin_activation_operations")
        .get(),
    ).toEqual({
      count: 1,
    });
  });

  it("does not finalize when the invitation expires after the saga returns", async () => {
    const value = fixture(200);
    let now = 100;
    const service = new InviteBackedOidcActivationService(
      value.database,
      config,
      {
        afterSagaReturn: () => {
          now = 200;
        },
        clock: () => now,
        createId: () => "activation-link",
        leaseOwner: "activation-test",
      },
      {
        verifyExistingIdentityInExistingTransaction: () => ({
          externalIdentityId: "activation-identity",
          providerId: "activation-provider",
          userId: "activation-user",
        }),
      } as never,
      value.sessions,
    );

    expect(
      await service.resume({
        activationOperationId: "jellyfin_activation_test",
        grant,
        pendingOidcSessionId: value.pairing.sessionId,
      }),
    ).toBeNull();
    expect(value.repository.read("jellyfin_activation_test")).toMatchObject({
      activationStatus: "pending",
      state: "auth_pending",
    });
    expect(value.repository.readStageArtifact("jellyfin_activation_test")).toMatchObject({
      accessToken: "upstream-access-token",
    });
    expect(
      value.database.sqlite.prepare("select status from users where id = ?").get("activation-user"),
    ).toEqual({ status: "pending_link" });
    expect(
      value.database.sqlite.prepare("select count(*) as count from service_identity_links").get(),
    ).toEqual({ count: 0 });
    expect(
      value.database.sqlite
        .prepare("select revoked_at as revokedAt from sessions where id = ?")
        .get(value.pairing.sessionId),
    ).toEqual({ revokedAt: null });
  });

  it("rejects a second valid pending session instead of substituting the operation-bound session", async () => {
    const value = fixture();
    const second = value.sessions.createSession({
      attribution: {
        authMethod: "oidc",
        externalIdentityId: "activation-identity",
        oidcProviderId: "activation-provider",
        userId: "activation-user",
      },
    });
    expect(
      await activationWithClock(value).resume({
        activationOperationId: "jellyfin_activation_test",
        grant,
        pendingOidcSessionId: second.principal.sessionId,
      }),
    ).toBeNull();
    expect(
      value.database.sqlite.prepare("select count(*) as count from service_identity_links").get(),
    ).toEqual({ count: 0 });
    expect(value.repository.read("jellyfin_activation_test")).toMatchObject({
      state: "auth_pending",
    });
    expect(
      value.database.sqlite
        .prepare("select revoked_at as revokedAt from sessions where id = ?")
        .get(second.principal.sessionId),
    ).toEqual({ revokedAt: null });
  });

  it("does not finalize after the provider becomes unavailable after the saga", async () => {
    const value = fixture();
    const now = 100;
    const service = new InviteBackedOidcActivationService(
      value.database,
      config,
      {
        afterSagaReturn: () => {
          value.database.sqlite
            .prepare("update oidc_providers set enabled = 0 where id = ?")
            .run("activation-provider");
        },
        clock: () => now,
        createId: () => "activation-link",
        leaseOwner: "activation-test",
      },
      {
        verifyExistingIdentityInExistingTransaction: () => ({
          externalIdentityId: "activation-identity",
          providerId: "activation-provider",
          userId: "activation-user",
        }),
      } as never,
      value.sessions,
    );
    expect(
      await service.resume({
        activationOperationId: "jellyfin_activation_test",
        grant,
        pendingOidcSessionId: value.pairing.sessionId,
      }),
    ).toBeNull();
    expect(value.repository.read("jellyfin_activation_test")).toMatchObject({
      state: "auth_pending",
    });
    expect(
      value.database.sqlite.prepare("select status from users where id = ?").get("activation-user"),
    ).toEqual({ status: "pending_link" });
    expect(
      value.database.sqlite.prepare("select count(*) as count from service_identity_links").get(),
    ).toEqual({ count: 0 });
    expect(
      value.database.sqlite
        .prepare("select revoked_at as revokedAt from sessions where id = ?")
        .get(value.pairing.sessionId),
    ).toEqual({ revokedAt: null });
  });
});
