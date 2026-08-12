import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { EnvelopeCipher } from "../src/security/crypto.js";
import { JellyfinActivationOperationRepository } from "../src/operations/jellyfin-activation-operation.js";
import { JellyfinActivationSaga } from "../src/operations/jellyfin-activation-saga.js";
import type { JellyfinProvisioningAdminClient } from "@omnifin/connectors/auth/jellyfin-provisioning-admin-client";

const key = Buffer.alloc(32, 0x52);
const serverId = "server-phase-two";
const identityHash = createHmac("sha256", key)
  .update("omnifin:v1:connector-instance-identity\0", "utf8")
  .update(serverId, "utf8")
  .digest("base64url");
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture(options: { status?: "active" | "pending_link"; link?: boolean } = {}) {
  const database = openDatabase(":memory:");
  database.migrate();
  const now = 100;
  const cipher = new EnvelopeCipher(key);
  database.sqlite.exec(`
    insert into oidc_providers (id, slug, display_name, issuer, client_id)
      values ('provider-phase-two', 'provider-phase-two', 'Provider', 'https://issuer.example', 'client');
    insert into users (id, display_name, status, created_at, updated_at)
      values ('phase-two-user', 'Phase Two User', '${options.status ?? "pending_link"}', 1, 1);
    insert into connector_configs (
      id, type, display_name, base_url, encrypted_credentials,
      instance_generation, config_generation, instance_identity_hash, enabled, created_at, updated_at
    ) values (
      'phase-two-connector', 'jellyfin', 'Phase Two Jellyfin', 'https://jellyfin.example',
      '${cipher.encrypt(JSON.stringify({ credentials: { kind: "none" }, schemaVersion: 1 }), "connector_credentials:jellyfin:phase-two-connector")}',
      0, 0, '${identityHash}', 1, 1, 1
    );
    insert into invitations (id, token_hash, expires_at, consumed_at, created_at)
      values ('invite_phase_two', '${"i".repeat(43)}', 10000, 100, 1);
    insert into external_identities (id, user_id, provider_id, issuer, subject, last_login_at, created_at, updated_at)
      values ('identity-phase-two', 'phase-two-user', 'provider-phase-two', 'https://issuer.example', 'subject', 1, 1, 1);
  `);
  const connectorRevision = createHash("sha256")
    .update("jellyfin\x00phase-two-connector\x000", "utf8")
    .digest("base64url");
  database.sqlite
    .prepare(
      `insert into jellyfin_provisioning_configs (
        connector_id, connector_revision, connector_instance_generation,
        connector_instance_identity_hash, encrypted_configuration, revision, created_at, updated_at
      ) values (?, ?, 0, ?, ?, 1, 1, 1)`,
    )
    .run(
      "phase-two-connector",
      connectorRevision,
      identityHash,
      cipher.encrypt(
        JSON.stringify({
          credential: { kind: "access_token", accessToken: "admin-capability" },
          enabled: true,
          protocolVersion: "10.11",
          schemaVersion: 2,
          template: { policy: { EnableAllFolders: true, IsAdministrator: false } },
          validatedAt: 1,
        }),
        `jellyfin_provisioning:phase-two-connector:${connectorRevision}:0:${identityHash}`,
      ),
    );
  if (options.link) {
    database.sqlite.exec(`
      insert into service_identity_links (
        id, user_id, service, connector_id, external_server_id, external_user_id,
        external_username, external_display_name, encrypted_access_token, device_id,
        token_created_at, health_state, revision, created_at, updated_at
      ) values (
        'existing-phase-two-link', 'phase-two-user', 'jellyfin', 'phase-two-connector',
        '${serverId}', 'existing-upstream', 'existing', 'Existing', 'token', 'device', 1,
        'linked', 0, 1, 1
      )
    `);
  }
  const repository = new JellyfinActivationOperationRepository(database.sqlite, key);
  database.sqlite.transaction(() =>
    repository.reserveInExistingTransaction({
      connectorConfigGeneration: 0,
      connectorId: "phase-two-connector",
      connectorInstanceGeneration: 0,
      connectorInstanceIdentityHash: identityHash,
      externalIdentityId: "identity-phase-two",
      id: "jellyfin_phase_two",
      invitationId: "invite_phase_two",
      leaseExpiresAt: 200,
      leaseOwner: "reservation-worker",
      now,
      provisioningRevision: 1,
      userId: "phase-two-user",
      invitationClaimedAt: 100,
      pendingOidcSessionId: "pending-session",
    }),
  )();
  cleanup.push(() => database.close());
  return { database, repository };
}

function client(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    authenticateCreatedUser: vi.fn(async () => ({
      accessToken: "created-user-token",
      serverId,
      userId: "created-upstream-id",
    })),
    applyUserPolicy: vi.fn(async () => undefined),
    createUser: vi.fn(async () => "created-upstream-id"),
    deleteUser: vi.fn(async () => "deleted" as const),
    readServerIdentity: vi.fn(async () => serverId),
    ...overrides,
  } as unknown as JellyfinProvisioningAdminClient;
}

function saga(
  database: ReturnType<typeof fixture>["database"],
  fakeClient: JellyfinProvisioningAdminClient,
) {
  return new JellyfinActivationSaga(
    database,
    { encryptionKey: key },
    {
      clock: () => 300,
      createClient: () => fakeClient,
      createId: () => "phase-two-audit-id",
      leaseOwner: "phase-two-saga",
    },
  );
}

describe("JellyfinActivationSaga", () => {
  it("creates once, applies policy by exact ID, authenticates, and leaves local activation untouched", async () => {
    const { database, repository } = fixture();
    const fake = client();
    const result = await saga(database, fake).run("jellyfin_phase_two");
    expect(result).toEqual({ disposition: "activated_ready", reason: null });
    expect(fake.createUser).toHaveBeenCalledTimes(1);
    expect(fake.applyUserPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "created-upstream-id",
        policy: { EnableAllFolders: true, IsAdministrator: false },
      }),
    );
    expect(fake.authenticateCreatedUser).toHaveBeenCalledTimes(1);
    expect(
      database.sqlite.prepare("select count(*) as count from service_identity_links").get(),
    ).toEqual({ count: 0 });
    expect(
      database.sqlite.prepare("select status from users where id = 'phase-two-user'").get(),
    ).toEqual({ status: "pending_link" });
    expect(repository.readStageArtifact("jellyfin_phase_two")).toMatchObject({
      accessToken: "created-user-token",
      createdId: "created-upstream-id",
    });
  });

  it.each([
    [
      "revoked",
      "update invitations set revoked_at = 9999, consumed_at = null where id = 'invite_phase_two'",
    ],
    [
      "changed consumption",
      "update invitations set consumed_at = 200 where id = 'invite_phase_two'",
    ],
    [
      "cleared consumption",
      "update invitations set consumed_at = null where id = 'invite_phase_two'",
    ],
    [
      "expired",
      "update invitations set expires_at = 200, consumed_at = 100 where id = 'invite_phase_two'",
    ],
  ])("does not bypass invitation binding from auth_pending after %s", async (_name, mutation) => {
    const { database, repository } = fixture();
    const fake = client();
    await saga(database, fake).run("jellyfin_phase_two");
    for (const trigger of [
      "invitations_revocation_binding_guard",
      "invitations_consumption_binding_guard",
    ]) {
      database.sqlite.exec(`drop trigger if exists ${trigger}`);
    }
    database.sqlite.exec(mutation);
    const result = await saga(database, fake).run("jellyfin_phase_two");
    expect(result.disposition).toBe("manual_pairing");
    expect(result.reason).not.toBeNull();
    expect(repository.read("jellyfin_phase_two")?.state).toBe("manual_required");
    expect(fake.deleteUser).not.toHaveBeenCalled();
  });

  it("serializes concurrent callers behind the one-create fence", async () => {
    const { database } = fixture();
    const fake = client({
      createUser: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "created-upstream-id";
      }),
    });
    const first = saga(database, fake).run("jellyfin_phase_two");
    const second = saga(database, fake).run("jellyfin_phase_two");
    await Promise.all([first, second]);
    expect(fake.createUser).toHaveBeenCalledTimes(1);
  });

  it("does not retry or authenticate after an ambiguous create outcome", async () => {
    const { database, repository } = fixture();
    const fake = client({
      createUser: vi.fn(async () => {
        const error = new Error("transport timeout") as Error & { cancellationSource: string };
        error.cancellationSource = "timeout";
        throw error;
      }),
    });
    const result = await saga(database, fake).run("jellyfin_phase_two");
    expect(result).toEqual({ disposition: "manual_pairing", reason: "create_outcome_uncertain" });
    expect(fake.createUser).toHaveBeenCalledTimes(1);
    expect(fake.applyUserPolicy).not.toHaveBeenCalled();
    expect(fake.authenticateCreatedUser).not.toHaveBeenCalled();
    expect(repository.read("jellyfin_phase_two")?.state).toBe("manual_required");
  });

  it("normalizes definitive create failure and does not adopt an existing user", async () => {
    const { database, repository } = fixture();
    const fake = client({
      createUser: vi.fn(async () => {
        throw new Error("duplicate name from upstream");
      }),
    });
    const result = await saga(database, fake).run("jellyfin_phase_two");
    expect(result).toEqual({ disposition: "manual_pairing", reason: "create_failed" });
    expect(repository.read("jellyfin_phase_two")?.state).toBe("manual_required");
    expect(fake.applyUserPolicy).not.toHaveBeenCalled();
    expect(fake.authenticateCreatedUser).not.toHaveBeenCalled();
  });

  it("bounds policy retries and validates exact authentication identity", async () => {
    const { database, repository } = fixture();
    const fake = client({
      applyUserPolicy: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary policy failure"))
        .mockRejectedValueOnce(new Error("temporary policy failure"))
        .mockResolvedValueOnce(undefined),
    });
    const result = await saga(database, fake).run("jellyfin_phase_two");
    expect(result.disposition).toBe("activated_ready");
    expect(fake.applyUserPolicy).toHaveBeenCalledTimes(3);
    expect(repository.read("jellyfin_phase_two")?.state).toBe("auth_pending");

    const malformed = fixture();
    const invalid = client({
      authenticateCreatedUser: vi.fn(async () => ({
        accessToken: "token",
        serverId,
        userId: "wrong-id",
      })),
    });
    const invalidResult = await saga(malformed.database, invalid).run("jellyfin_phase_two");
    expect(invalidResult).toEqual({ disposition: "manual_pairing", reason: "response_invalid" });
    expect(malformed.repository.read("jellyfin_phase_two")?.state).toBe("manual_required");
  });

  it("stops before mutation when user status, link, or connector binding is unsafe", async () => {
    for (const options of [{ status: "active" as const }, { link: true }]) {
      const { database, repository } = fixture(options);
      const fake = client();
      const result = await saga(database, fake).run("jellyfin_phase_two");
      expect(result.disposition).toBe("manual_pairing");
      expect(fake.createUser).not.toHaveBeenCalled();
      expect(repository.read("jellyfin_phase_two")?.state).toBe("manual_required");
    }
    const changed = fixture();
    changed.database.sqlite
      .prepare("update connector_configs set config_generation = 1 where id = ?")
      .run("phase-two-connector");
    const changedFake = client();
    expect((await saga(changed.database, changedFake).run("jellyfin_phase_two")).reason).toBe(
      "binding_changed",
    );
    expect(changedFake.createUser).not.toHaveBeenCalled();
  });

  it("resumes known-ID stages only and keeps secrets out of result and audit serialization", async () => {
    const { database, repository } = fixture();
    const fake = client();
    await saga(database, fake).run("jellyfin_phase_two");
    const result = await saga(database, fake).run("jellyfin_phase_two");
    expect(result.disposition).toBe("activated_ready");
    expect(() => JSON.stringify(result)).toThrow("internal-only");
    expect(() => JSON.stringify(repository.read("jellyfin_phase_two"))).toThrow("internal-only");
    const audit = database.sqlite
      .prepare("select metadata_json as metadata from audit_events")
      .all();
    expect(JSON.stringify(audit)).not.toContain("created-user-token");
    expect(JSON.stringify(audit)).not.toContain("admin-capability");
  });

  it("expires invitations before any external mutation and seals long upstream IDs", async () => {
    const { database, repository } = fixture();
    database.sqlite
      .prepare("update invitations set expires_at = 200 where id = ?")
      .run("invite_phase_two");
    const fake = client();
    const result = await new JellyfinActivationSaga(
      database,
      { encryptionKey: key },
      {
        clock: () => 300,
        createClient: () => fake,
        leaseOwner: "expired-invite-saga",
      },
    ).run("jellyfin_phase_two");
    expect(result).toEqual({ disposition: "manual_pairing", reason: "invite_expired" });
    expect(fake.createUser).not.toHaveBeenCalled();
    expect(repository.read("jellyfin_phase_two")?.state).toBe("manual_required");

    const longId = "u".repeat(200);
    const longClient = client({
      createUser: vi.fn(async () => longId),
      authenticateCreatedUser: vi.fn(async () => ({
        accessToken: "created-user-token",
        serverId,
        userId: longId,
      })),
    });
    const longFixture = fixture();
    const longResult = await saga(longFixture.database, longClient).run("jellyfin_phase_two");
    expect(longResult.disposition).toBe("activated_ready");
    expect(longFixture.repository.readStageArtifact("jellyfin_phase_two").createdId).toBe(longId);
  });

  it("terminalizes an expired create fence without calling the client", async () => {
    const { database, repository } = fixture();
    database.sqlite
      .prepare(
        "update jellyfin_activation_operations set state = 'create_dispatched', create_attempt_count = 1, create_dispatched_at = 150, lease_owner = 'crashed-worker', lease_expires_at = 200 where id = ?",
      )
      .run("jellyfin_phase_two");
    const fake = client();
    const sagaInstance = new JellyfinActivationSaga(
      database,
      { encryptionKey: key },
      {
        clock: () => 300,
        createClient: () => fake,
        leaseOwner: "restart-saga",
      },
    );
    expect(await sagaInstance.run("jellyfin_phase_two")).toEqual({
      disposition: "manual_pairing",
      reason: "create_outcome_uncertain",
    });
    expect(await sagaInstance.run("jellyfin_phase_two")).toEqual({
      disposition: "manual_pairing",
      reason: "create_outcome_uncertain",
    });
    expect(fake.createUser).not.toHaveBeenCalled();
    expect(repository.read("jellyfin_phase_two")?.state).toBe("manual_required");
  });

  it("requires trusted confirmation and exact binding for confirmed cleanup", async () => {
    const { database, repository } = fixture();
    const fake = client();
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "manual_required",
      now: 400,
    });
    const sagaInstance = saga(database, fake);
    const rejected = await sagaInstance.confirmedCleanup(
      {} as Parameters<typeof sagaInstance.confirmedCleanup>[0],
    );
    expect(rejected.disposition).toBe("cleanup_rejected");
    expect(fake.deleteUser).not.toHaveBeenCalled();

    const capability = sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two");
    const cleaned = await sagaInstance.confirmedCleanup(capability);
    expect(cleaned.disposition).toBe("cleanup_confirmed");
    expect(fake.deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "created-upstream-id" }),
    );
    expect(repository.read("jellyfin_phase_two")?.state).toBe("tombstoned");
    expect(() => JSON.stringify(capability)).toThrow("internal-only");
  });

  it("cleans an exact known ID after invitation expiry without invitation preflight", async () => {
    const { database, repository } = fixture();
    const fake = client();
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "invite_expired",
      now: 400,
    });
    database.sqlite
      .prepare("update invitations set expires_at = 200 where id = 'invite_phase_two'")
      .run();

    const result = await saga(database, fake).confirmedCleanup(
      saga(database, fake).createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(result.disposition).toBe("cleanup_confirmed");
    expect(fake.deleteUser).toHaveBeenCalledTimes(1);
    expect(fake.deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "created-upstream-id" }),
    );
  });

  it.each([
    ["revocation", "update invitations set revoked_at = 200 where id = 'invite_phase_two'"],
    ["consumption", "update invitations set consumed_at = 200 where id = 'invite_phase_two'"],
  ])("blocks mutation of a claimed invitation during cleanup (%s)", async (_name, update) => {
    const { database, repository } = fixture();
    const fake = client();
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "manual_required",
      now: 400,
    });
    expect(() => database.sqlite.exec(update)).toThrow();
    expect(fake.deleteUser).not.toHaveBeenCalled();
  });

  it("does not let a fresh non-eligible operation bypass cleanup preconditions", async () => {
    const { database } = fixture();
    const fake = client();
    const sagaInstance = saga(database, fake);
    const result = await sagaInstance.confirmedCleanup(
      sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(result.disposition).toBe("cleanup_rejected");
    expect(fake.deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    ["204", "deleted" as const],
    ["404", "not_found" as const],
  ])("confirms exact-ID cleanup for upstream %s", async (_status, deleteResult) => {
    const { database, repository } = fixture();
    const fake = client({ deleteUser: vi.fn(async () => deleteResult) });
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    const sagaInstance = saga(database, fake);
    const result = await sagaInstance.confirmedCleanup(
      sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(result.disposition).toBe("cleanup_confirmed");
    expect(repository.read("jellyfin_phase_two")?.state).toBe("tombstoned");
    expect(
      database.sqlite
        .prepare(
          "select outcome, event_type from audit_events where event_type = 'activation.cleanup.confirmed'",
        )
        .get(),
    ).toEqual({ event_type: "activation.cleanup.confirmed", outcome: "success" });
  });

  it("turns ambiguous cleanup into uncertainty and never retries DELETE", async () => {
    const { database, repository } = fixture();
    const fake = client({
      deleteUser: vi.fn(async () => {
        throw Object.assign(new Error("timeout"), { cancellationSource: "timeout" });
      }),
    });
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "alternate_reason",
      now: 400,
    });
    const sagaInstance = saga(database, fake);
    const capability = sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two");
    const first = await sagaInstance.confirmedCleanup(capability);
    database.sqlite
      .prepare(
        "update jellyfin_activation_cleanup_reservations set lease_expires_at = 1 where operation_id = 'jellyfin_phase_two'",
      )
      .run();
    const second = await sagaInstance.confirmedCleanup(capability);
    expect(first.disposition).toBe("cleanup_uncertain");
    expect(second.disposition).toBe("cleanup_rejected");
    expect(fake.deleteUser).toHaveBeenCalledTimes(1);
    expect(repository.read("jellyfin_phase_two")?.failureCode).toBe("cleanup_uncertain");
    expect(
      database.sqlite
        .prepare(
          "select outcome, event_type from audit_events where event_type = 'activation.cleanup.uncertain'",
        )
        .get(),
    ).toEqual({ event_type: "activation.cleanup.uncertain", outcome: "failure" });
    const repeat = await sagaInstance.confirmedCleanup(
      sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(repeat.disposition).toBe("cleanup_rejected");
    expect(fake.deleteUser).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent cleanup callers and reports the live dispatch", async () => {
    const { database, repository } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client({
      deleteUser: vi.fn(async () => {
        await gate;
        return "deleted" as const;
      }),
    });
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    const first = saga(database, fake).confirmedCleanup(
      saga(database, fake).createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    await Promise.resolve();
    const second = await saga(database, fake).confirmedCleanup(
      saga(database, fake).createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(second.disposition).toBe("cleanup_in_progress");
    expect(fake.deleteUser).toHaveBeenCalledTimes(1);
    release();
    expect((await first).disposition).toBe("cleanup_confirmed");
  });

  it("marks a post-delete revision race uncertain and never retries", async () => {
    const { database, repository } = fixture();
    const fake = client({
      deleteUser: vi.fn(async () => {
        database.sqlite
          .prepare(
            "update jellyfin_activation_operations set updated_at = updated_at + 1 where id = 'jellyfin_phase_two'",
          )
          .run();
        database.sqlite
          .prepare(
            "update jellyfin_activation_operations set revision = revision + 1 where id = 'jellyfin_phase_two'",
          )
          .run();
        return "deleted" as const;
      }),
    });
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    const sagaInstance = saga(database, fake);
    const capability = sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two");
    const first = await sagaInstance.confirmedCleanup(capability);
    database.sqlite
      .prepare(
        "update jellyfin_activation_cleanup_reservations set lease_expires_at = 1 where operation_id = 'jellyfin_phase_two'",
      )
      .run();
    const second = await sagaInstance.confirmedCleanup(capability);
    expect(first.disposition).toBe("cleanup_uncertain");
    expect(second.disposition).toBe("cleanup_rejected");
    expect(fake.deleteUser).toHaveBeenCalledTimes(1);
    expect(repository.read("jellyfin_phase_two")?.failureCode).toBe("cleanup_uncertain");
    expect(
      database.sqlite
        .prepare(
          "select outcome, event_type from audit_events where event_type = 'activation.cleanup.uncertain'",
        )
        .get(),
    ).toEqual({ event_type: "activation.cleanup.uncertain", outcome: "failure" });
  });

  it("rejects cleanup for changed connector, provisioning, or server binding", async () => {
    for (const mutation of [
      (database: ReturnType<typeof fixture>["database"]) =>
        database.sqlite.exec(
          "update connector_configs set config_generation = 1 where id = 'phase-two-connector'",
        ),
      (database: ReturnType<typeof fixture>["database"]) =>
        database.sqlite.exec(
          "update jellyfin_provisioning_configs set revision = 2 where connector_id = 'phase-two-connector'",
        ),
    ]) {
      const { database, repository } = fixture();
      const fake = client();
      await saga(database, fake).run("jellyfin_phase_two");
      repository.markManualRequired({
        id: "jellyfin_phase_two",
        failureCode: "policy_failed",
        now: 400,
      });
      mutation(database);
      const result = await saga(database, fake).confirmedCleanup(
        saga(database, fake).createConfirmedCleanupCapability("jellyfin_phase_two"),
      );
      expect(result.disposition).toBe("cleanup_rejected");
      expect(fake.deleteUser).not.toHaveBeenCalled();
    }
    const { database, repository } = fixture();
    const setupFake = client();
    await saga(database, setupFake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    const fake = client({ readServerIdentity: vi.fn(async () => "other-server") });
    const result = await saga(database, fake).confirmedCleanup(
      saga(database, fake).createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(result.disposition).toBe("cleanup_rejected");
    expect(fake.deleteUser).not.toHaveBeenCalled();
  });

  it("cannot clean a missing ID, forged capability, or operation with an existing link", async () => {
    const missing = fixture();
    const missingFake = client();
    const missingRepo = missing.repository;
    await saga(missing.database, missingFake).run("jellyfin_phase_two");
    missingRepo.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    missing.database.sqlite.exec(
      "update jellyfin_activation_operations set encrypted_stage_artifact = null, cleanup_eligible = 0 where id = 'jellyfin_phase_two'",
    );
    const missingResult = await saga(missing.database, missingFake).confirmedCleanup(
      saga(missing.database, missingFake).createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(missingResult.disposition).toBe("cleanup_rejected");
    expect(missingFake.deleteUser).not.toHaveBeenCalled();
    const forged = fixture();
    const forgedFake = client();
    const forgedSaga = saga(forged.database, forgedFake);
    expect(
      (
        await forgedSaga.confirmedCleanup(
          forgedSaga.createConfirmedCleanupCapability("jellyfin_other"),
        )
      ).disposition,
    ).toBe("cleanup_rejected");
    expect(forgedFake.deleteUser).not.toHaveBeenCalled();
    const linked = fixture();
    const linkedFake = client();
    await saga(linked.database, linkedFake).run("jellyfin_phase_two");
    linked.repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    linked.database.sqlite.exec(
      "insert into service_identity_links (id,user_id,service,connector_id,external_server_id,external_user_id,external_username,external_display_name,encrypted_access_token,device_id,token_created_at,health_state,revision,created_at,updated_at) values ('unmarked-after','phase-two-user','jellyfin','phase-two-connector','server','existing','name','Name','token','device',1,'linked',0,1,1)",
    );
    expect(
      (
        await saga(linked.database, linkedFake).confirmedCleanup(
          saga(linked.database, linkedFake).createConfirmedCleanupCapability("jellyfin_phase_two"),
        )
      ).disposition,
    ).toBe("cleanup_rejected");
    expect(linkedFake.deleteUser).not.toHaveBeenCalled();
  });

  it("audit write failure cannot undo confirmed cleanup", async () => {
    const { database, repository } = fixture();
    const fake = client();
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    database.sqlite.exec(
      "create trigger fail_cleanup_audit before insert on audit_events when new.event_type like 'activation.cleanup.%' begin select raise(abort, 'audit unavailable'); end",
    );
    const sagaInstance = saga(database, fake);
    const result = await sagaInstance.confirmedCleanup(
      sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(result.disposition).toBe("cleanup_confirmed");
    expect(fake.deleteUser).toHaveBeenCalledTimes(1);
    expect(repository.read("jellyfin_phase_two")?.state).toBe("tombstoned");
    expect(
      (
        await sagaInstance.confirmedCleanup(
          sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
        )
      ).disposition,
    ).toBe("cleanup_rejected");
    expect(fake.deleteUser).toHaveBeenCalledTimes(1);
  });

  it("returns opaque in-progress and terminal uncertainty outcomes", async () => {
    const { database, repository } = fixture();
    const fake = client();
    await saga(database, fake).run("jellyfin_phase_two");
    repository.markManualRequired({
      id: "jellyfin_phase_two",
      failureCode: "policy_failed",
      now: 400,
    });
    const owner = "live-cleanup";
    const reserved = repository.reserveCleanup({
      id: "jellyfin_phase_two",
      leaseOwner: owner,
      leaseExpiresAt: 500,
      now: 400,
    });
    const sagaInstance = saga(database, fake);
    const live = await sagaInstance.confirmedCleanup(
      sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(live.disposition).toBe("cleanup_in_progress");
    database.sqlite
      .prepare(
        "update jellyfin_activation_cleanup_reservations set lease_expires_at = 250 where operation_id = ?",
      )
      .run(reserved.id);
    const stale = await sagaInstance.confirmedCleanup(
      sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(stale.disposition).toBe("cleanup_rejected");
    expect(stale).toMatchObject({ reason: "cleanup_uncertain" });
    expect(fake.deleteUser).not.toHaveBeenCalled();
    expect(repository.read("jellyfin_phase_two")?.failureCode).toBe("cleanup_uncertain");
    expect(
      database.sqlite
        .prepare(
          "select state, lease_owner as leaseOwner, operation_revision as operationRevision from jellyfin_activation_cleanup_reservations where operation_id = ?",
        )
        .get("jellyfin_phase_two"),
    ).toMatchObject({
      state: "uncertain",
      leaseOwner: owner,
      operationRevision: reserved.revision,
    });
    expect(
      database.sqlite
        .prepare(
          "select outcome, event_type from audit_events where event_type = 'activation.cleanup.uncertain'",
        )
        .get(),
    ).toEqual({ event_type: "activation.cleanup.uncertain", outcome: "failure" });
    const repeat = await sagaInstance.confirmedCleanup(
      sagaInstance.createConfirmedCleanupCapability("jellyfin_phase_two"),
    );
    expect(repeat).toMatchObject({
      disposition: "cleanup_rejected",
      reason: "cleanup_uncertain",
    });
    expect(fake.deleteUser).not.toHaveBeenCalled();
    expect(
      database.sqlite
        .prepare("select count(*) as count from jellyfin_activation_cleanup_reservations")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare(
          "select state from jellyfin_activation_cleanup_reservations where operation_id = ?",
        )
        .get("jellyfin_phase_two"),
    ).toEqual({ state: "uncertain" });
    expect(() => JSON.stringify(stale)).toThrow("internal-only");
    expect(() => JSON.stringify({ ...stale })).not.toThrow();
    expect(Object.keys({ ...stale })).not.toContain("createdId");
  });

  it("wraps an invalid capability in an opaque nonserializable cleanup result", async () => {
    const { database } = fixture();
    const fake = client();
    const result = await saga(database, fake).confirmedCleanup({} as never);
    expect(result.disposition).toBe("cleanup_rejected");
    expect(() => JSON.stringify(result)).toThrow("internal-only");
    const copy = { ...result };
    expect(copy).not.toHaveProperty("createdId");
    expect(JSON.stringify(copy)).not.toMatch(/cipher|secret|error|created-upstream-id/iu);
    expect(fake.deleteUser).not.toHaveBeenCalled();
  });
});
