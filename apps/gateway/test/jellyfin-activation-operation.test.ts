import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeRestoredDatabase } from "../src/db/maintenance.js";
import { openDatabase } from "../src/db/client.js";
import {
  JellyfinActivationOperationRepository,
  jellyfinActivationArtifactEncryptionContext,
} from "../src/operations/jellyfin-activation-operation.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const key = Buffer.alloc(32, 0x41);
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture(databaseUrl = ":memory:") {
  const database = openDatabase(databaseUrl);
  database.migrate();
  const sqlite = database.sqlite;
  sqlite.exec(`
    insert into oidc_providers (id, slug, display_name, issuer, client_id)
      values ('provider-1', 'provider-1', 'Provider', 'https://issuer.example', 'client');
    insert into users (id, display_name, status, created_at, updated_at)
      values ('user-0001', 'User', 'pending_link', 1, 1), ('user-0002', 'Other', 'pending_link', 1, 1);
    insert into connector_configs (id, type, display_name, base_url, encrypted_credentials,
      instance_generation, config_generation, created_at, updated_at)
      values ('connector-0001', 'jellyfin', 'Jellyfin', 'https://jellyfin.example', 'cipher', 0, 0, 1, 1),
             ('connector-0002', 'jellyfin', 'Other Jellyfin', 'https://other.example', 'cipher', 0, 0, 1, 1);
    insert into invitations (id, token_hash, expires_at, created_at)
      values ('invite_0001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 100000, 1),
             ('invite_0002', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 100000, 1);
    insert into external_identities (id, user_id, provider_id, issuer, subject, last_login_at)
      values ('identity-0001', 'user-0001', 'provider-1', 'https://issuer.example', 'subject-1', 1),
             ('identity-0002', 'user-0002', 'provider-1', 'https://issuer.example', 'subject-2', 1);
  `);
  const repository = new JellyfinActivationOperationRepository(sqlite, key);
  cleanup.push(() => database.close());
  return { database, repository, sqlite };
}

function prepareCreated(repository: JellyfinActivationOperationRepository) {
  repository.reserve(reservation());
  repository.claimLease({
    id: "jellyfin_activation_1",
    expectedOwner: "worker-1",
    expectedExpiresAt: 200,
    leaseOwner: "worker-2",
    leaseExpiresAt: 400,
    now: 201,
  });
  repository.dispatchCreate({ id: "jellyfin_activation_1", leaseOwner: "worker-2", now: 202 });
  repository.recordCreatedIdArtifact({
    id: "jellyfin_activation_1",
    createdId: "upstream-1",
    now: 203,
  });
}

function reservation(
  overrides: Partial<Parameters<JellyfinActivationOperationRepository["reserve"]>[0]> = {},
) {
  return {
    id: "jellyfin_activation_1",
    invitationId: "invite_0001",
    userId: "user-0001",
    externalIdentityId: "identity-0001",
    connectorId: "connector-0001",
    connectorConfigGeneration: 0,
    connectorInstanceGeneration: 0,
    connectorInstanceIdentityHash: null,
    provisioningRevision: 1,
    leaseOwner: "worker-1",
    leaseExpiresAt: 200,
    now: 100,
    ...overrides,
  };
}

describe("Jellyfin activation operation repository", () => {
  it.each([
    ["invitationId", { invitationId: "invite_0001", id: "jellyfin_activation_2" }],
    ["userId", { userId: "user-0001", id: "jellyfin_activation_2", invitationId: "invite_0002" }],
    [
      "externalIdentityId",
      {
        externalIdentityId: "identity-0001",
        id: "jellyfin_activation_2",
        invitationId: "invite_0002",
      },
    ],
  ])("rejects a second reservation for the same %s", (_name, override) => {
    const { repository } = fixture();
    repository.reserve(reservation());
    expect(() => repository.reserve(reservation(override))).toThrowError(
      expect.objectContaining({ code: "reservation_conflict" }),
    );
  });

  it("serializes concurrent reservations through the immediate transaction", async () => {
    const { repository, sqlite } = fixture();
    const attempts = [
      repository.reserve(reservation()),
      (() => {
        try {
          return repository.reserve(reservation({ id: "jellyfin_activation_2" }));
        } catch (error) {
          return error;
        }
      })(),
    ];
    await Promise.all(attempts.map(async (attempt) => attempt));
    expect(
      sqlite.prepare("select count(*) as count from jellyfin_activation_operations").get(),
    ).toEqual({ count: 1 });
  });

  it("claims an expired lease with revision CAS and permits only one create dispatch", () => {
    const { repository } = fixture();
    repository.reserve(reservation());
    const claimed = repository.claimLease({
      id: "jellyfin_activation_1",
      expectedOwner: "worker-1",
      expectedExpiresAt: 200,
      leaseOwner: "worker-2",
      leaseExpiresAt: 400,
      now: 201,
    });
    expect(claimed.revision).toBe(1);
    const dispatched = repository.dispatchCreate({
      id: claimed.id,
      leaseOwner: "worker-2",
      now: 202,
    });
    expect(dispatched.state).toBe("create_dispatched");
    expect(dispatched.createAttemptCount).toBe(1);
    expect(() =>
      repository.dispatchCreate({ id: claimed.id, leaseOwner: "worker-2", now: 203 }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("does not expose ciphertext through the operation view or shallow spread", () => {
    const { repository, sqlite } = fixture();
    repository.reserve(reservation());
    repository.claimLease({
      id: "jellyfin_activation_1",
      expectedOwner: "worker-1",
      expectedExpiresAt: 200,
      leaseOwner: "worker-2",
      leaseExpiresAt: 400,
      now: 201,
    });
    repository.dispatchCreate({ id: "jellyfin_activation_1", leaseOwner: "worker-2", now: 202 });
    repository.recordCreatedIdArtifact({
      id: "jellyfin_activation_1",
      createdId: "upstream-1",
      now: 203,
    });
    const view = repository.read("jellyfin_activation_1")!;
    expect({ ...view }).not.toHaveProperty("encryptedStageArtifact");
    expect(
      sqlite.prepare("select encrypted_stage_artifact from jellyfin_activation_operations").get(),
    ).toMatchObject({ encrypted_stage_artifact: expect.any(String) });
    expect(() => JSON.stringify(view)).toThrow("internal-only");
  });

  it("binds artifacts to operation and revision context and rejects foreign context", () => {
    const { repository, sqlite } = fixture();
    repository.reserve(reservation());
    repository.claimLease({
      id: "jellyfin_activation_1",
      expectedOwner: "worker-1",
      expectedExpiresAt: 200,
      leaseOwner: "worker-2",
      leaseExpiresAt: 400,
      now: 201,
    });
    repository.dispatchCreate({ id: "jellyfin_activation_1", leaseOwner: "worker-2", now: 202 });
    repository.recordCreatedIdArtifact({
      id: "jellyfin_activation_1",
      createdId: "upstream-1",
      now: 203,
    });
    const envelope = (
      sqlite
        .prepare("select encrypted_stage_artifact as value from jellyfin_activation_operations")
        .get() as { value: string }
    ).value;
    const cipher = new EnvelopeCipher(key);
    expect(() =>
      cipher.decrypt(
        envelope,
        jellyfinActivationArtifactEncryptionContext("jellyfin_activation_2", 1),
      ),
    ).toThrow();
    expect(() =>
      cipher.decrypt(
        envelope,
        jellyfinActivationArtifactEncryptionContext("jellyfin_activation_1", 2),
      ),
    ).toThrow();
    sqlite
      .prepare(
        "update jellyfin_activation_operations set encrypted_stage_artifact = ? where id = ?",
      )
      .run("not-an-envelope", "jellyfin_activation_1");
    expect(() => repository.readCreatedIdArtifact("jellyfin_activation_1")).toThrowError(
      expect.objectContaining({ code: "artifact_not_found" }),
    );
  });

  it("retains only exact ID for confirmed cleanup and scrubs credentials", () => {
    const { repository, sqlite } = fixture();
    prepareCreated(repository);
    repository.recordStageArtifact({
      id: "jellyfin_activation_1",
      state: "policy_pending",
      now: 204,
      artifact: {
        createdId: "upstream-1",
        username: "generated-user",
        password: "generated-password",
        accessToken: "user-token",
        policy: { IsAdministrator: false },
      },
    });
    repository.markManualRequired({
      id: "jellyfin_activation_1",
      failureCode: "manual_required",
      now: 205,
    });
    expect(repository.readCreatedIdArtifact("jellyfin_activation_1")).toBe("upstream-1");
    const row = sqlite
      .prepare(
        "select encrypted_stage_artifact as artifact, artifact_revision as revision from jellyfin_activation_operations",
      )
      .get() as { artifact: string; revision: number };
    expect(
      JSON.parse(
        new EnvelopeCipher(key).decrypt(
          row.artifact,
          jellyfinActivationArtifactEncryptionContext("jellyfin_activation_1", row.revision),
        ),
      ),
    ).toMatchObject({
      createdId: "upstream-1",
      username: "generated-user",
      password: "generated-password",
      accessToken: "user-token",
    });
  });

  it("scrubs a no-created-ID manual failure and tombstones it", () => {
    const { repository, sqlite } = fixture();
    repository.reserve(reservation());
    repository.markManualRequired({
      id: "jellyfin_activation_1",
      failureCode: "create_outcome_uncertain",
      now: 201,
    });
    expect(
      sqlite
        .prepare(
          "select encrypted_stage_artifact, cleanup_eligible from jellyfin_activation_operations",
        )
        .get(),
    ).toEqual({ encrypted_stage_artifact: null, cleanup_eligible: 0 });
    repository.tombstone("jellyfin_activation_1", 202);
    expect(repository.read("jellyfin_activation_1")?.state).toBe("tombstoned");
  });

  it("enforces marker user and connector relationship", () => {
    const { repository, sqlite } = fixture();
    repository.reserve(reservation());
    const values =
      "'link-1','user-0001','jellyfin','connector-0001',0,'server','upstream-1','name','Name','token','jellyfin_activation_1','device',1,'linked',null,null,0,1,1";
    sqlite.exec(
      `insert into service_identity_links (id,user_id,service,connector_id,connector_instance_generation,external_server_id,external_user_id,external_username,external_display_name,encrypted_access_token,provisioned_by_activation_id,device_id,token_created_at,health_state,last_verified_at,revoked_at,revision,created_at,updated_at) values (${values})`,
    );
    expect(
      sqlite.prepare("select provisioned_by_activation_id from service_identity_links").get(),
    ).toEqual({ provisioned_by_activation_id: "jellyfin_activation_1" });
    expect(() =>
      sqlite.exec(
        `insert into service_identity_links (id,user_id,service,connector_id,connector_instance_generation,external_server_id,external_user_id,external_username,external_display_name,encrypted_access_token,provisioned_by_activation_id,device_id,token_created_at,health_state,revision,created_at,updated_at) values ('link-2','user-0002','jellyfin','connector-0001',0,'server','upstream-2','name','Name','token','jellyfin_activation_1','device',1,'linked',0,1,1)`,
      ),
    ).toThrow();
    expect(() =>
      sqlite.exec(
        `insert into service_identity_links (id,user_id,service,connector_id,connector_instance_generation,external_server_id,external_user_id,external_username,external_display_name,encrypted_access_token,provisioned_by_activation_id,device_id,token_created_at,health_state,revision,created_at,updated_at) values ('link-3','user-0001','jellyfin','connector-0002',0,'server','upstream-3','name','Name','token','jellyfin_activation_1','device',1,'linked',0,1,1)`,
      ),
    ).toThrow();
  });

  it("rejects malformed persisted state", () => {
    const { repository, sqlite } = fixture();
    repository.reserve(reservation());
    sqlite.pragma("ignore_check_constraints = ON");
    sqlite.prepare("update jellyfin_activation_operations set state = 'corrupt'").run();
    expect(() => repository.read("jellyfin_activation_1")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("sanitizes a nonterminal operation on no-current-timeline restore", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-activation-restore-"));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    const databasePath = path.join(directory, "database.sqlite");
    const database = fixture(databasePath);
    prepareCreated(database.repository);
    database.database.close();
    sanitizeRestoredDatabase(databasePath, { now: new Date(300) });
    const restored = new Database(databasePath);
    cleanup.push(() => restored.close());
    expect(
      restored
        .prepare(
          "select state, encrypted_stage_artifact, cleanup_eligible from jellyfin_activation_operations",
        )
        .get(),
    ).toEqual({ state: "manual_required", encrypted_stage_artifact: null, cleanup_eligible: 0 });
    expect(() =>
      new JellyfinActivationOperationRepository(restored, key).dispatchCreate({
        id: "jellyfin_activation_1",
        leaseOwner: "worker-2",
        now: 301,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });
});
