import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import {
  ExternalMutationJournal,
  externalMutationRequestEncryptionContext,
  type ExternalMutationJournalError,
  type ExternalMutationKind,
  type ExternalMutationParentOperationType,
} from "../src/operations/external-mutation-journal.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const encryptionKey = Buffer.alloc(32, 41);

function fixture() {
  const database = openDatabase(":memory:");
  database.migrate();
  return {
    database,
    journal: new ExternalMutationJournal(database.sqlite, encryptionKey),
  };
}

function reservation(
  token: string,
  overrides: Partial<{
    kind: ExternalMutationKind;
    parentOperationId: string;
    parentOperationType: ExternalMutationParentOperationType;
    targetDigest: string;
  }> = {},
) {
  return {
    connectorConfigGeneration: 1_700_000_000_000,
    connectorId: "jellyfin-home",
    connectorInstanceGeneration: 7,
    id: `mutation_dispatch_${token.repeat(22)}`,
    kind: "playback.progress" as const,
    leaseExpiresAt: 2_000,
    leaseOwner: "worker-one",
    normalizedRequest: { z: 3, nested: { y: true, a: "first" }, a: [2, 1] },
    now: 1_000,
    parentOperationId: `playback_progress_operation_${token.repeat(22)}`,
    parentOperationType: "playback_progress_operation" as const,
    targetDigest: token.repeat(22),
    userId: "user-one",
    ...overrides,
  };
}

describe("external mutation journal", () => {
  it("encrypts one canonical normalized request under the typed dispatch context", () => {
    const { database, journal } = fixture();
    try {
      const input = reservation("a");
      const result = journal.reserve(input);
      expect(result.normalizedRequest).toEqual({
        a: [2, 1],
        nested: { a: "first", y: true },
        z: 3,
      });
      const stored = database.sqlite
        .prepare(
          `select encrypted_normalized_request as encryptedRequest
           from external_mutation_dispatches where id = ?`,
        )
        .get(input.id) as { encryptedRequest: string };
      expect(stored.encryptedRequest).not.toContain("nested");
      const cipher = new EnvelopeCipher(encryptionKey);
      expect(
        cipher.decrypt(
          stored.encryptedRequest,
          externalMutationRequestEncryptionContext(input.id, input.kind),
        ),
      ).toBe('{"a":[2,1],"nested":{"a":"first","y":true},"z":3}');
      expect(() =>
        cipher.decrypt(
          stored.encryptedRequest,
          externalMutationRequestEncryptionContext(
            `mutation_dispatch_${"b".repeat(22)}`,
            input.kind,
          ),
        ),
      ).toThrow(/authenticated/u);
    } finally {
      database.close();
    }
  });

  it("serializes exact targets and releases locks only after policy-terminal outcomes", () => {
    const { database, journal } = fixture();
    try {
      const first = reservation("c");
      const second = reservation("d", { targetDigest: first.targetDigest });
      journal.reserve(first);
      expect(() => journal.reserve(second)).toThrowError(
        expect.objectContaining<Partial<ExternalMutationJournalError>>({ code: "target_locked" }),
      );
      expect(
        database.sqlite.prepare("select count(*) as count from external_mutation_dispatches").get(),
      ).toEqual({ count: 1 });

      journal.markDispatched({ id: first.id, leaseOwner: first.leaseOwner, now: 1_500 });
      journal.completeSucceeded({ id: first.id, now: 1_600 });
      expect(
        database.sqlite
          .prepare("select count(*) as count from external_mutation_target_locks")
          .get(),
      ).toEqual({ count: 0 });
      expect(journal.reserve(second).state).toBe("reserved");
    } finally {
      database.close();
    }
  });

  it("claims only the exact stale reserved lease and never reclaims after dispatch", () => {
    const { database, journal } = fixture();
    try {
      const input = reservation("e");
      journal.reserve(input);
      expect(
        journal.claimStaleReserved({
          expectedLeaseExpiresAt: input.leaseExpiresAt,
          expectedLeaseOwner: input.leaseOwner,
          id: input.id,
          leaseExpiresAt: 4_000,
          leaseOwner: "worker-two",
          now: 3_000,
        }),
      ).toMatchObject({ leaseOwner: "worker-two", state: "reserved" });
      expect(() =>
        journal.claimStaleReserved({
          expectedLeaseExpiresAt: input.leaseExpiresAt,
          expectedLeaseOwner: input.leaseOwner,
          id: input.id,
          leaseExpiresAt: 5_000,
          leaseOwner: "worker-three",
          now: 4_500,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

      expect(
        journal.markDispatched({ id: input.id, leaseOwner: "worker-two", now: 3_500 }),
      ).toMatchObject({ dispatchAttemptCount: 1, state: "dispatched" });
      expect(() =>
        journal.claimStaleReserved({
          expectedLeaseExpiresAt: 4_000,
          expectedLeaseOwner: "worker-two",
          id: input.id,
          leaseExpiresAt: 6_000,
          leaseOwner: "worker-three",
          now: 5_000,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
    } finally {
      database.close();
    }
  });

  it("retains uncertain and definitive terminal rows while enforcing state constraints", () => {
    const { database, journal } = fixture();
    try {
      const uncertain = reservation("f");
      journal.reserve(uncertain);
      journal.markDispatched({ id: uncertain.id, leaseOwner: uncertain.leaseOwner, now: 1_200 });
      journal.markReconcileRequired({
        failureCode: "read_after_write_required",
        id: uncertain.id,
        now: 1_300,
      });
      expect(
        journal.completeUncertain({
          failureCode: "outcome_unknown",
          id: uncertain.id,
          now: 1_400,
        }),
      ).toMatchObject({ failureCode: "outcome_unknown", state: "uncertain" });
      expect(() => journal.releaseTargetLock({ id: uncertain.id })).toThrowError(
        expect.objectContaining({ code: "invalid_transition" }),
      );
      expect(
        database.sqlite
          .prepare("select count(*) as count from external_mutation_target_locks")
          .get(),
      ).toEqual({ count: 1 });

      expect(() =>
        database.sqlite
          .prepare(
            `update external_mutation_dispatches
             set state = 'succeeded', failure_code = null where id = ?`,
          )
          .run(uncertain.id),
      ).toThrow(/constraint/u);
      expect(journal.read(uncertain.id)).toMatchObject({ state: "uncertain" });

      const failed = reservation("g");
      journal.reserve(failed);
      expect(
        journal.completeFailed({ failureCode: "request_rejected", id: failed.id, now: 1_100 }),
      ).toMatchObject({ dispatchAttemptCount: 0, state: "failed" });
      expect(() =>
        journal.markDispatched({ id: failed.id, leaseOwner: failed.leaseOwner, now: 1_200 }),
      ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(
        journal.replay({
          kind: failed.kind,
          parentOperationId: failed.parentOperationId,
          parentOperationType: failed.parentOperationType,
        }),
      ).toMatchObject({ failureCode: "request_rejected", state: "failed" });
    } finally {
      database.close();
    }
  });

  it("deletes matching terminal parent evidence atomically", () => {
    const { database, journal } = fixture();
    try {
      database.sqlite
        .prepare(
          `insert into users (id, display_name, status, created_at, updated_at)
           values ('cleanup-user', 'Cleanup user', 'active', 1000, 1000)`,
        )
        .run();
      const parentId = "cleanup-request-success";
      database.sqlite
        .prepare(
          `insert into media_request_operations (
             id, user_id, idempotency_key_hash, fingerprint_hash, state,
             response_json, completed_at, created_at, updated_at
           ) values (?, 'cleanup-user', ?, ?, 'succeeded', '{}', 1600, 1000, 1600)`,
        )
        .run(parentId, "i".repeat(43), "j".repeat(43));
      const dispatch = reservation("i", {
        kind: "media_request.submit",
        parentOperationId: parentId,
        parentOperationType: "media_request_operation",
      });
      journal.reserve(dispatch);
      journal.markDispatched({ id: dispatch.id, leaseOwner: dispatch.leaseOwner, now: 1_400 });
      journal.completeSucceeded({ id: dispatch.id, now: 1_600 });
      database.sqlite
        .prepare(
          `insert into external_mutation_target_locks (
             target_scope, target_digest, owner_dispatch_id, acquired_at
           ) values ('media_request', ?, ?, 1600)`,
        )
        .run(dispatch.targetDigest, dispatch.id);
      database.sqlite.exec(`
        create trigger reject_terminal_parent_cleanup
        before delete on media_request_operations
        begin
          select raise(abort, 'simulated cleanup interruption');
        end;
      `);

      expect(() =>
        journal.cleanupTerminalParents({
          completedBefore: 2_000,
          limit: 1,
          parentIds: [parentId],
          parentOperationType: "media_request_operation",
        }),
      ).toThrow(/simulated cleanup interruption/u);
      expect(
        database.sqlite
          .prepare(
            `select
               (select count(*) from media_request_operations) as parents,
               (select count(*) from external_mutation_dispatches) as dispatches,
               (select count(*) from external_mutation_target_locks) as locks`,
          )
          .get(),
      ).toEqual({ dispatches: 1, locks: 1, parents: 1 });

      database.sqlite.exec("drop trigger reject_terminal_parent_cleanup");
      expect(
        journal.cleanupTerminalParents({
          completedBefore: 2_000,
          limit: 1,
          parentIds: [parentId],
          parentOperationType: "media_request_operation",
        }),
      ).toEqual({ dispatches: 1, locks: 1, mismatchedParents: 0, parents: 1 });
    } finally {
      database.close();
    }
  });

  it("bounds terminal cleanup and retains mismatched or unresolved evidence", () => {
    const { database, journal } = fixture();
    try {
      database.sqlite
        .prepare(
          `insert into users (id, display_name, status, created_at, updated_at)
           values ('retention-user', 'Retention user', 'active', 100, 100)`,
        )
        .run();
      const insertParent = (
        token: string,
        state: "failed" | "pending" | "reconcile_required" | "succeeded" | "uncertain",
        completedAt: number | null,
      ) => {
        database.sqlite
          .prepare(
            `insert into media_request_operations (
               id, user_id, idempotency_key_hash, fingerprint_hash, state,
               response_json, failure_code, completed_at, created_at, updated_at
             ) values (?, 'retention-user', ?, ?, ?, ?, ?, ?, 100, ?)`,
          )
          .run(
            `retention-request-${token}`,
            token.repeat(43),
            token.toUpperCase().repeat(43),
            state,
            state === "succeeded" ? "{}" : null,
            state === "failed" || state === "reconcile_required" || state === "uncertain"
              ? "retained_evidence"
              : null,
            completedAt,
            completedAt ?? 100,
          );
      };
      const reserveFor = (token: string) => {
        const input = reservation(token, {
          kind: "media_request.submit",
          parentOperationId: `retention-request-${token}`,
          parentOperationType: "media_request_operation",
        });
        journal.reserve(input);
        return input;
      };

      insertParent("j", "succeeded", 1_200);
      const succeeded = reserveFor("j");
      journal.markDispatched({ id: succeeded.id, leaseOwner: succeeded.leaseOwner, now: 1_100 });
      journal.completeSucceeded({ id: succeeded.id, now: 1_200 });

      insertParent("k", "failed", 1_300);
      const failed = reserveFor("k");
      journal.completeFailed({ failureCode: "retained_evidence", id: failed.id, now: 1_300 });

      insertParent("l", "succeeded", 1_400);
      const mismatched = reserveFor("l");
      journal.completeFailed({ failureCode: "retained_evidence", id: mismatched.id, now: 1_400 });

      insertParent("m", "pending", null);
      const dispatched = reserveFor("m");
      journal.markDispatched({ id: dispatched.id, leaseOwner: dispatched.leaseOwner, now: 1_500 });

      insertParent("n", "reconcile_required", 1_600);
      const reconciling = reserveFor("n");
      journal.markDispatched({
        id: reconciling.id,
        leaseOwner: reconciling.leaseOwner,
        now: 1_550,
      });
      journal.markReconcileRequired({
        failureCode: "retained_evidence",
        id: reconciling.id,
        now: 1_600,
      });

      insertParent("o", "uncertain", 1_700);
      const uncertain = reserveFor("o");
      journal.markDispatched({ id: uncertain.id, leaseOwner: uncertain.leaseOwner, now: 1_650 });
      journal.completeUncertain({
        failureCode: "retained_evidence",
        id: uncertain.id,
        now: 1_700,
      });

      expect(
        journal.cleanupTerminalParents({
          completedBefore: 2_000,
          limit: 1,
          parentOperationType: "media_request_operation",
          userId: "retention-user",
        }),
      ).toEqual({ dispatches: 1, locks: 0, mismatchedParents: 0, parents: 1 });
      expect(
        journal.cleanupTerminalParents({
          completedBefore: 2_000,
          limit: 10,
          parentOperationType: "media_request_operation",
          userId: "retention-user",
        }),
      ).toEqual({ dispatches: 1, locks: 0, mismatchedParents: 1, parents: 1 });
      expect(
        database.sqlite.prepare("select state from media_request_operations order by state").all(),
      ).toEqual([
        { state: "pending" },
        { state: "reconcile_required" },
        { state: "succeeded" },
        { state: "uncertain" },
      ]);
      expect(
        database.sqlite
          .prepare("select state from external_mutation_dispatches order by state")
          .all(),
      ).toEqual([
        { state: "dispatched" },
        { state: "failed" },
        { state: "reconcile_required" },
        { state: "uncertain" },
      ]);
    } finally {
      database.close();
    }
  });

  it("cleans only explicit closed pre-dispatch no-op pairs", () => {
    const { database, journal } = fixture();
    try {
      database.sqlite
        .prepare(
          `insert into users (id, display_name, status, created_at, updated_at)
           values ('no-op-user', 'No-op user', 'active', 100, 100)`,
        )
        .run();
      const cases = [
        ["p", "no_dispatch_required", false],
        ["q", "already_in_desired_state", false],
        ["r", "dispatch_not_required", false],
        ["s", "already_satisfied", false],
        ["t", "unlisted_no_op", false],
        ["u", "no_dispatch_required", true],
      ] as const;
      for (const [token, failureCode, dispatched] of cases) {
        const parentId = `no-op-request-${token}`;
        database.sqlite
          .prepare(
            `insert into media_request_operations (
               id, user_id, idempotency_key_hash, fingerprint_hash, state,
               response_json, completed_at, created_at, updated_at
             ) values (?, 'no-op-user', ?, ?, 'succeeded', '{}', 1600, 1000, 1600)`,
          )
          .run(parentId, token.repeat(43), token.toUpperCase().repeat(43));
        const dispatch = reservation(token, {
          kind: "media_request.submit",
          parentOperationId: parentId,
          parentOperationType: "media_request_operation",
        });
        journal.reserve(dispatch);
        if (dispatched) {
          journal.markDispatched({ id: dispatch.id, leaseOwner: dispatch.leaseOwner, now: 1_400 });
        }
        journal.completeFailed({ failureCode, id: dispatch.id, now: 1_600 });
      }

      expect(
        journal.cleanupTerminalParents({
          completedBefore: 2_000,
          limit: 10,
          parentOperationType: "media_request_operation",
          userId: "no-op-user",
        }),
      ).toEqual({ dispatches: 4, locks: 0, mismatchedParents: 2, parents: 4 });
      expect(
        database.sqlite
          .prepare(
            `select dispatch.failure_code as failureCode,
                    dispatch.dispatch_attempt_count as dispatchAttemptCount,
                    dispatch.dispatched_at as dispatchedAt
             from external_mutation_dispatches dispatch
             order by dispatch.failure_code, dispatch.dispatch_attempt_count`,
          )
          .all(),
      ).toEqual([
        { dispatchAttemptCount: 1, dispatchedAt: 1_400, failureCode: "no_dispatch_required" },
        { dispatchAttemptCount: 0, dispatchedAt: null, failureCode: "unlisted_no_op" },
      ]);
      expect(
        database.sqlite.prepare("select count(*) as count from media_request_operations").get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("rejects a kind under the wrong operation-specific parent policy", () => {
    const { database, journal } = fixture();
    try {
      expect(() =>
        journal.reserve(
          reservation("h", {
            kind: "download_queue.pause",
            parentOperationType: "playback_progress_operation",
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    } finally {
      database.close();
    }
  });

  it("enforces exact and bulk queue parents plus one progress operation per session revision", () => {
    const { database } = fixture();
    try {
      database.sqlite.exec(`
        insert into users (id, display_name, status, created_at, updated_at)
        values ('operation-user', 'Operation user', 'active', 1000, 1000);
        insert into connector_configs (
          id, type, display_name, base_url, encrypted_credentials,
          instance_generation, config_generation, created_at, updated_at
        ) values (
          'operation-connector', 'qbittorrent', 'Downloads', 'https://downloads.example.test',
          'v1.fixture', 3, 10, 1000, 1000
        );
        insert into download_queue_bulk_operations (
          id, user_id, idempotency_key_hash, fingerprint_hash, state,
          request_json, results_json, completed_at, created_at, updated_at
        ) values (
          'download_bulk_${"b".repeat(22)}', 'operation-user', '${"a".repeat(43)}',
          '${"b".repeat(43)}', 'quarantined', '{}', '[]', 1000, 1000, 1000
        );
      `);
      database.sqlite
        .prepare(
          `insert into download_queue_item_operations (
             id, user_id, connector_id, connector_instance_generation,
             connector_config_generation, item_digest, kind,
             idempotency_key_hash, fingerprint_hash, created_at, updated_at
           ) values (?, 'operation-user', 'operation-connector', 3, 10, ?, 'pause', ?, ?, 1000, 1000)`,
        )
        .run(
          `download_item_operation_${"x".repeat(22)}`,
          "x".repeat(22),
          "c".repeat(43),
          "d".repeat(43),
        );
      database.sqlite
        .prepare(
          `insert into download_queue_item_operations (
             id, bulk_operation_id, user_id, connector_id, connector_instance_generation,
             connector_config_generation, item_digest, kind, idempotency_key_hash,
             fingerprint_hash, created_at, updated_at
           ) values (?, ?, 'operation-user', 'operation-connector', 3, 10, ?, 'resume', null, ?, 1000, 1000)`,
        )
        .run(
          `download_item_operation_${"y".repeat(22)}`,
          `download_bulk_${"b".repeat(22)}`,
          "y".repeat(22),
          "e".repeat(43),
        );
      expect(() =>
        database.sqlite
          .prepare(
            `insert into download_queue_item_operations (
               id, user_id, connector_id, connector_instance_generation,
               connector_config_generation, item_digest, kind,
               idempotency_key_hash, fingerprint_hash, created_at, updated_at
             ) values (?, 'operation-user', 'operation-connector', 3, 10, ?,
                       'promote', null, ?, 1000, 1000)`,
          )
          .run(`download_item_operation_${"z".repeat(22)}`, "z".repeat(22), "f".repeat(43)),
      ).toThrow(/constraint/u);

      database.sqlite
        .prepare(
          `insert into playback_progress_operations (
             id, playback_session_id, session_revision, user_id, connector_id,
             connector_instance_generation, connector_config_generation,
             position_seconds, created_at, updated_at
           ) values (?, ?, 4, 'operation-user', 'operation-connector', 3, 10, 42, 1000, 1000)`,
        )
        .run(`playback_progress_operation_${"p".repeat(22)}`, `playback_${"p".repeat(22)}`);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into playback_progress_operations (
               id, playback_session_id, session_revision, user_id, connector_id,
               connector_instance_generation, connector_config_generation,
               position_seconds, created_at, updated_at
             ) values (?, ?, 4, 'operation-user', 'operation-connector', 3, 10, 43, 1000, 1000)`,
          )
          .run(`playback_progress_operation_${"q".repeat(22)}`, `playback_${"p".repeat(22)}`),
      ).toThrow(/unique/iu);
    } finally {
      database.close();
    }
  });
});
