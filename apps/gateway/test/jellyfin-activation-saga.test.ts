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
    insert into invitations (id, token_hash, expires_at, created_at)
      values ('invite_phase_two', '${"i".repeat(43)}', 10000, 1);
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
  repository.reserve({
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
  });
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
});
