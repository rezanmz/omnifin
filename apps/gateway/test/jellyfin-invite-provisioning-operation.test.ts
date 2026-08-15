import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import {
  JellyfinInviteProvisioningOperationService,
  type JellyfinInviteProvisioningOperationError,
  type ReserveJellyfinInviteProvisioningInput,
} from "../src/operations/jellyfin-invite-provisioning-operation.js";

function fixture() {
  const database = openDatabase(":memory:");
  database.migrate();
  return {
    database,
    service: new JellyfinInviteProvisioningOperationService(database.sqlite),
  };
}

function seed(
  database: ReturnType<typeof openDatabase>,
  input: ReserveJellyfinInviteProvisioningInput,
) {
  database.sqlite
    .prepare(
      `insert into invitations (id, token_hash, expires_at, created_at)
       values (?, ?, 20000, 1000)`,
    )
    .run(input.invitationId, input.invitationId.slice(7).padEnd(43, "x"));
  database.sqlite
    .prepare(
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials,
         instance_generation, config_generation, instance_identity_hash, created_at, updated_at
       ) values (?, 'jellyfin', 'Jellyfin', 'https://jellyfin.example.test',
                 'v1.fixture', ?, ?, ?, 1000, 1000)`,
    )
    .run(
      input.connectorId,
      input.connectorInstanceGeneration,
      input.connectorConfigGeneration,
      input.connectorInstanceIdentityHash,
    );
  database.sqlite
    .prepare(
      `insert into jellyfin_provisioning_configs (
         connector_id, connector_revision, connector_instance_generation,
         connector_instance_identity_hash, encrypted_configuration, revision, created_at, updated_at
       ) values (?, ?, ?, ?, 'v1.fixture', 0, 1000, 1000)`,
    )
    .run(
      input.connectorId,
      input.connectorRevision,
      input.connectorInstanceGeneration,
      input.connectorInstanceIdentityHash,
    );
}

const INVITATION_PATTERN = /^invite_[A-Za-z0-9_-]{1,121}$/u;

function seedInvitation(database: ReturnType<typeof openDatabase>, invitationId: string) {
  if (!INVITATION_PATTERN.test(invitationId)) return;
  database.sqlite
    .prepare(
      `insert into invitations (id, token_hash, expires_at, created_at)
       values (?, ?, 20000, 1000)`,
    )
    .run(invitationId, invitationId.slice(7).padEnd(43, "x"));
}

function reservation(
  token: string,
  overrides: Partial<ReserveJellyfinInviteProvisioningInput> = {},
): ReserveJellyfinInviteProvisioningInput {
  return {
    connectorConfigGeneration: 12,
    connectorId: `jellyfin-${token}`,
    connectorInstanceGeneration: 7,
    connectorInstanceIdentityHash: "i".repeat(43),
    connectorRevision: token.repeat(24),
    fingerprintHash: token.repeat(22),
    id: `jellyfin_invite_provision_operation_${token.repeat(22)}`,
    invitationId: `invite_${token.repeat(22)}`,
    leaseExpiresAt: 2_000,
    leaseOwner: "worker-one",
    now: 1_000,
    templateIdentifier: `template-${token}`,
    ...overrides,
  };
}

describe("jellyfin invite provisioning operation", () => {
  it("reserves one durable operation per invitation and replays the single dispatch", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("a");
      seed(database, input);
      const reserved = service.reserve(input);
      expect(reserved).toMatchObject({
        createAttemptCount: 0,
        leaseOwner: "worker-one",
        state: "reserved",
      });
      expect(service.replay({ invitationId: input.invitationId })).toMatchObject({
        id: input.id,
        state: "reserved",
      });
      expect(() => service.reserve(input)).toThrowError(
        expect.objectContaining<Partial<JellyfinInviteProvisioningOperationError>>({
          code: "reservation_conflict",
        }),
      );
      expect(
        database.sqlite
          .prepare("select count(*) as count from jellyfin_invite_provisioning_operations")
          .get(),
      ).toEqual({ count: 1 });
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("transitions only the exact reserved lease to creating and never re-dispatches", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("b");
      seed(database, input);
      service.reserve(input);

      expect(() =>
        service.markCreating({ id: input.id, leaseOwner: "other-worker", now: 1_100 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(() =>
        service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 3_000 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

      expect(
        service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_500 }),
      ).toMatchObject({ createAttemptCount: 1, creatingAt: 1_500, state: "creating" });

      expect(() =>
        service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_600 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(() =>
        service.claimStaleReserved({
          expectedLeaseExpiresAt: input.leaseExpiresAt,
          expectedLeaseOwner: input.leaseOwner,
          id: input.id,
          leaseExpiresAt: 4_000,
          leaseOwner: "worker-two",
          now: 3_000,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(
        database.sqlite
          .prepare(
            "select create_attempt_count as count from jellyfin_invite_provisioning_operations where id = ?",
          )
          .get(input.id),
      ).toEqual({ count: 1 });

      const stale = reservation("c");
      seed(database, stale);
      service.reserve(stale);
      expect(
        service.claimStaleReserved({
          expectedLeaseExpiresAt: stale.leaseExpiresAt,
          expectedLeaseOwner: stale.leaseOwner,
          id: stale.id,
          leaseExpiresAt: 4_000,
          leaseOwner: "worker-two",
          now: 3_000,
        }),
      ).toMatchObject({ leaseOwner: "worker-two", state: "reserved" });
      expect(
        service.markCreating({ id: stale.id, leaseOwner: "worker-two", now: 3_500 }),
      ).toMatchObject({ createAttemptCount: 1, state: "creating" });
    } finally {
      database.close();
    }
  });

  it("fails before dispatch when the live connector binding no longer matches", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("x");
      seed(database, input);
      service.reserve(input);
      database.sqlite
        .prepare(
          "update connector_configs set config_generation = config_generation + 1 where id = ?",
        )
        .run(input.connectorId);

      expect(
        service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_200 }),
      ).toMatchObject({
        createAttemptCount: 0,
        completedAt: 1_200,
        failureCode: "connector_binding_mismatch",
        state: "failed",
      });
      expect(service.finalizationEligibility(input.id)).toEqual({
        eligible: false,
        reason: "failed",
      });
      expect(() => service.reserve(input)).toThrowError(
        expect.objectContaining({ code: "reservation_conflict" }),
      );
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("persists the validated create response before any policy transition", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("d");
      seed(database, input);
      service.reserve(input);
      service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_200 });
      expect(() =>
        service.markCreated({ id: input.id, now: 1_250, provisionedUserId: "bad id!" }),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));

      const created = service.markCreated({
        id: input.id,
        now: 1_300,
        provisionedUserId: "upstream-user-1234",
      });
      expect(created).toMatchObject({
        provisionedAt: 1_300,
        provisionedUserId: "upstream-user-1234",
        state: "created",
      });
      expect(() =>
        service.markCreated({ id: input.id, now: 1_350, provisionedUserId: "another-user" }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

      expect(service.markPolicyPending({ id: input.id, now: 1_500 })).toMatchObject({
        policyPendingAt: 1_500,
        state: "policy_pending",
      });
      expect(service.markSucceeded({ id: input.id, now: 1_600 })).toMatchObject({
        completedAt: 1_600,
        failureCode: null,
        policyCompletedAt: 1_600,
        state: "succeeded",
      });
      expect(service.finalizationEligibility(input.id)).toEqual({
        eligible: true,
        reason: "ready",
      });
    } finally {
      database.close();
    }
  });

  it("reaches reconcile_required on policy failure and can never return to create", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("e");
      seed(database, input);
      service.reserve(input);
      service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_200 });
      service.markCreated({ id: input.id, now: 1_300, provisionedUserId: "upstream-user-1234" });
      service.markPolicyPending({ id: input.id, now: 1_400 });

      const reconciling = service.markReconcileRequired({
        failureCode: "policy_rejected",
        id: input.id,
        now: 1_700,
      });
      expect(reconciling).toMatchObject({
        failureCode: "policy_rejected",
        provisionedUserId: "upstream-user-1234",
        reconcileRequiredAt: 1_700,
        state: "reconcile_required",
      });
      expect(service.finalizationEligibility(input.id)).toEqual({
        eligible: false,
        reason: "reconcile_required",
      });
      expect(() =>
        service.markCreated({ id: input.id, now: 1_800, provisionedUserId: "another-user" }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(() =>
        service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_800 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(() => service.markPolicyPending({ id: input.id, now: 1_800 })).toThrowError(
        expect.objectContaining({ code: "invalid_transition" }),
      );
      expect(service.read(input.id)).toMatchObject({
        provisionedAt: 1_300,
        provisionedUserId: "upstream-user-1234",
        state: "reconcile_required",
      });

      const beforePolicy = reservation("p");
      seed(database, beforePolicy);
      service.reserve(beforePolicy);
      service.markCreating({
        id: beforePolicy.id,
        leaseOwner: beforePolicy.leaseOwner,
        now: 1_200,
      });
      service.markCreated({
        id: beforePolicy.id,
        now: 1_300,
        provisionedUserId: "upstream-user-5678",
      });
      expect(
        service.markReconcileRequired({
          failureCode: "policy_validation_failed",
          id: beforePolicy.id,
          now: 1_400,
        }),
      ).toMatchObject({
        failureCode: "policy_validation_failed",
        provisionedUserId: "upstream-user-5678",
        state: "reconcile_required",
      });
    } finally {
      database.close();
    }
  });

  it("turns ambiguous outcomes into uncertain while retaining the operation and lock", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("f");
      seed(database, input);
      service.reserve(input);
      service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_200 });
      expect(() =>
        service.completeUncertain({ failureCode: "outcome_unknown", id: input.id, now: 1_300 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

      service.markReconcileRequired({ failureCode: "outcome_unknown", id: input.id, now: 1_400 });
      expect(
        service.completeUncertain({ failureCode: "outcome_unknown", id: input.id, now: 1_500 }),
      ).toMatchObject({
        completedAt: 1_500,
        failureCode: "outcome_unknown",
        reconcileRequiredAt: 1_400,
        state: "uncertain",
        uncertainAt: 1_500,
      });
      expect(service.read(input.id)).toMatchObject({ state: "uncertain" });
      expect(service.finalizationEligibility(input.id)).toEqual({
        eligible: false,
        reason: "uncertain",
      });
      expect(
        database.sqlite
          .prepare("select count(*) as count from jellyfin_invite_provisioning_operations")
          .get(),
      ).toEqual({ count: 1 });
      expect(() => service.reserve(reservation("f"))).toThrowError(
        expect.objectContaining({ code: "reservation_conflict" }),
      );

      const reconciling = reservation("g");
      seed(database, reconciling);
      service.reserve(reconciling);
      service.markCreating({ id: reconciling.id, leaseOwner: reconciling.leaseOwner, now: 1_200 });
      service.markReconcileRequired({
        failureCode: "read_after_write_required",
        id: reconciling.id,
        now: 1_300,
      });
      expect(() => service.reserve(reservation("g"))).toThrowError(
        expect.objectContaining({ code: "reservation_conflict" }),
      );
    } finally {
      database.close();
    }
  });

  it("distinguishes known pre-dispatch failure from post-dispatch ambiguity", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("h");
      seed(database, input);
      service.reserve(input);
      expect(() =>
        service.markFailed({ failureCode: "not a valid code!", id: input.id, now: 1_200 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
      const failed = service.markFailed({
        failureCode: "invitation_expired",
        id: input.id,
        now: 1_200,
      });
      expect(failed).toMatchObject({
        completedAt: 1_200,
        createAttemptCount: 0,
        creatingAt: null,
        failureCode: "invitation_expired",
        state: "failed",
      });
      expect(service.finalizationEligibility(input.id)).toEqual({
        eligible: false,
        reason: "failed",
      });
      expect(() =>
        service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_300 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(() =>
        service.markReconcileRequired({ failureCode: "outcome_unknown", id: input.id, now: 1_300 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

      const ambiguous = reservation("i");
      seed(database, ambiguous);
      service.reserve(ambiguous);
      service.markCreating({ id: ambiguous.id, leaseOwner: ambiguous.leaseOwner, now: 1_200 });
      expect(() =>
        service.markFailed({ failureCode: "invitation_expired", id: ambiguous.id, now: 1_300 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(
        service.markReconcileRequired({
          failureCode: "outcome_unknown",
          id: ambiguous.id,
          now: 1_400,
        }),
      ).toMatchObject({ state: "reconcile_required" });
      expect(service.read(ambiguous.id)).toMatchObject({ state: "reconcile_required" });
    } finally {
      database.close();
    }
  });

  it("stores no username, password, credential, policy payload, or upstream error detail", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("j");
      seed(database, input);
      service.reserve(input);
      service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_200 });
      service.markCreated({ id: input.id, now: 1_300, provisionedUserId: "upstream-user-1234" });
      service.markPolicyPending({ id: input.id, now: 1_400 });
      service.markSucceeded({ id: input.id, now: 1_500 });

      const row = database.sqlite
        .prepare("select * from jellyfin_invite_provisioning_operations where id = ?")
        .get(input.id) as Record<string, unknown>;
      const storedValues = Object.values(row)
        .filter((value): value is string => typeof value === "string")
        .join("\u0000");
      expect(storedValues).not.toMatch(
        /sentinel-username|sentinel-password|sentinel-policy-payload|sentinel-credential|sentinel-secret|upstream-error-detail|hunter2/iu,
      );

      const columns = (
        database.sqlite.pragma("table_info(jellyfin_invite_provisioning_operations)") as {
          name: string;
        }[]
      ).map(({ name }) => name);
      for (const forbidden of [
        "username",
        "password",
        "credential",
        "encrypted_request",
        "policy_payload",
        "policy_json",
        "upstream_error_detail",
        "token",
        "secret",
      ]) {
        expect(columns).not.toContain(forbidden);
      }

      const bounded = reservation("k");
      seed(database, bounded);
      service.reserve(bounded);
      service.markCreating({ id: bounded.id, leaseOwner: bounded.leaseOwner, now: 1_200 });
      service.markCreated({ id: bounded.id, now: 1_300, provisionedUserId: "upstream-user-9999" });
      service.markReconcileRequired({ failureCode: "outcome_unknown", id: bounded.id, now: 1_400 });
      expect(
        database.sqlite
          .prepare(
            "select failure_code as failureCode from jellyfin_invite_provisioning_operations where id = ?",
          )
          .get(bounded.id),
      ).toEqual({ failureCode: "outcome_unknown" });
    } finally {
      database.close();
    }
  });

  it("rejects malformed connector snapshots, fingerprints, and identities before reserving", () => {
    const { database, service } = fixture();
    try {
      const base = reservation("l");
      database.sqlite
        .prepare(
          `insert or ignore into connector_configs (
             id, type, display_name, base_url, encrypted_credentials,
             instance_generation, config_generation, created_at, updated_at
           ) values (?, 'jellyfin', 'Jellyfin', 'https://jellyfin.example.test',
                     'v1.fixture', 7, 12, 1000, 1000)`,
        )
        .run(base.connectorId);
      const cases: Array<Partial<ReserveJellyfinInviteProvisioningInput>> = [
        { connectorRevision: "short" },
        { connectorRevision: "x".repeat(200) },
        { connectorRevision: `bad/rev${"x".repeat(16)}` },
        { connectorRevision: `bad.rev${"x".repeat(16)}` },
        { connectorInstanceIdentityHash: "x".repeat(22) },
        { connectorInstanceIdentityHash: `bad!${"x".repeat(43)}` },
        { fingerprintHash: "x".repeat(21) },
        { fingerprintHash: `x${"y".repeat(21)}!` },
        { templateIdentifier: "" },
        { templateIdentifier: "-bad-start" },
        { templateIdentifier: "x".repeat(130) },
        { templateIdentifier: "bad/identifier" },
        { connectorInstanceGeneration: -1 },
        { connectorConfigGeneration: 9_007_199_254_740_992 },
        { leaseExpiresAt: 1_000 },
        { leaseExpiresAt: Number.NaN },
        { invitationId: "nope" },
        { invitationId: `invite_bad!${"y".repeat(16)}` },
        { leaseOwner: "" },
        { connectorId: "" },
      ];
      for (const [index, overrides] of cases.entries()) {
        const token = String.fromCharCode(109 + index);
        const input: ReserveJellyfinInviteProvisioningInput = {
          ...base,
          ...overrides,
          id: `jellyfin_invite_provision_operation_${token.repeat(22)}`,
          invitationId: overrides.invitationId ?? `invite_${token.repeat(22)}`,
        };
        seedInvitation(database, input.invitationId);
        expect(() => service.reserve(input), JSON.stringify(overrides)).toThrowError(
          expect.objectContaining<Partial<JellyfinInviteProvisioningOperationError>>({
            code: "invalid_input",
          }),
        );
      }
      expect(
        database.sqlite
          .prepare("select count(*) as count from jellyfin_invite_provisioning_operations")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("reports finalization eligibility only for completed policy evidence", () => {
    const { database, service } = fixture();
    try {
      const input = reservation("z");
      seed(database, input);
      expect(service.finalizationEligibility(input.id)).toBeUndefined();
      service.reserve(input);
      expect(service.finalizationEligibility(input.id)).toEqual({
        eligible: false,
        reason: "incomplete",
      });
      service.markCreating({ id: input.id, leaseOwner: input.leaseOwner, now: 1_200 });
      expect(service.finalizationEligibility(input.id)).toEqual({
        eligible: false,
        reason: "incomplete",
      });
    } finally {
      database.close();
    }
  });
});
