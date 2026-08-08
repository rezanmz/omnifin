import type Database from "better-sqlite3";
import { EnvelopeCipher } from "../security/crypto.js";

export const EXTERNAL_MUTATION_POLICIES = {
  "media_request.submit": {
    parentOperationType: "media_request_operation",
    targetScope: "media_request",
  },
  "media_issue.update": {
    parentOperationType: "media_issue_operation",
    targetScope: "media_issue",
  },
  "subtitle.download": {
    parentOperationType: "subtitle_download_operation",
    targetScope: "subtitle",
  },
  "library.scan": {
    parentOperationType: "library_mutation_operation",
    targetScope: "library",
  },
  "library.item_refresh": {
    parentOperationType: "library_mutation_operation",
    targetScope: "library",
  },
  "library.metadata_update": {
    parentOperationType: "library_mutation_operation",
    targetScope: "library",
  },
  "library.artwork_apply": {
    parentOperationType: "library_mutation_operation",
    targetScope: "library",
  },
  "library.remove_files": {
    parentOperationType: "library_removal_operation",
    targetScope: "library",
  },
  "library.unmonitor": {
    parentOperationType: "library_removal_operation",
    targetScope: "library",
  },
  "library.remove_manager_record": {
    parentOperationType: "library_removal_operation",
    targetScope: "library",
  },
  "user_media_state.update": {
    parentOperationType: "user_media_state_operation",
    targetScope: "user_media_state",
  },
  "download_queue.remove": {
    parentOperationType: "download_queue_removal_operation",
    targetScope: "download_queue",
  },
  "download_queue.pause": {
    parentOperationType: "download_queue_item_operation",
    targetScope: "download_queue",
  },
  "download_queue.resume": {
    parentOperationType: "download_queue_item_operation",
    targetScope: "download_queue",
  },
  "download_queue.promote": {
    parentOperationType: "download_queue_item_operation",
    targetScope: "download_queue",
  },
  "acquisition.queue_recover": {
    parentOperationType: "acquisition_queue_recovery_operation",
    targetScope: "acquisition",
  },
  "acquisition.grab": {
    parentOperationType: "acquisition_grab_operation",
    targetScope: "acquisition",
  },
  "acquisition.search": {
    parentOperationType: "acquisition_search_operation",
    targetScope: "acquisition",
  },
  "saved.favorite": {
    parentOperationType: "saved_list_operation",
    targetScope: "saved_favorite",
  },
  "playback.progress": {
    parentOperationType: "playback_progress_operation",
    targetScope: "playback_progress",
  },
} as const;

export type ExternalMutationKind = keyof typeof EXTERNAL_MUTATION_POLICIES;
export type ExternalMutationParentOperationType =
  (typeof EXTERNAL_MUTATION_POLICIES)[ExternalMutationKind]["parentOperationType"];
export type ExternalMutationTargetScope =
  (typeof EXTERNAL_MUTATION_POLICIES)[ExternalMutationKind]["targetScope"];
export type ExternalMutationState =
  "reserved" | "dispatched" | "reconcile_required" | "uncertain" | "succeeded" | "failed";
export const EXTERNAL_MUTATION_TARGET_LOCK_RELEASE_POLICY: Record<
  ExternalMutationKind,
  readonly ExternalMutationState[]
> = Object.fromEntries(
  Object.keys(EXTERNAL_MUTATION_POLICIES).map((kind) => [kind, ["succeeded", "failed"]]),
) as unknown as Record<ExternalMutationKind, readonly ExternalMutationState[]>;
export type ExternalMutationRequestEncryptionContext =
  `omnifin:v1:external-mutation:${ExternalMutationKind}:${string}:normalized-request`;

export interface ExternalMutationRecord {
  completedAt: number | null;
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  createdAt: number;
  dispatchAttemptCount: number;
  dispatchedAt: number | null;
  failureCode: string | null;
  id: string;
  kind: ExternalMutationKind;
  leaseExpiresAt: number | null;
  leaseOwner: string | null;
  normalizedRequest: JsonValue;
  parentOperationId: string;
  parentOperationType: ExternalMutationParentOperationType;
  reconcileRequiredAt: number | null;
  state: ExternalMutationState;
  uncertainAt: number | null;
  updatedAt: number;
  userId: string;
}

export interface ReserveExternalMutationInput {
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  id: string;
  kind: ExternalMutationKind;
  leaseExpiresAt: number;
  leaseOwner: string;
  normalizedRequest: JsonValue;
  now: number;
  parentOperationId: string;
  parentOperationType: ExternalMutationParentOperationType;
  targetDigest: string;
  userId: string;
}

export interface ClaimStaleReservedInput {
  expectedLeaseExpiresAt: number;
  expectedLeaseOwner: string;
  id: string;
  leaseExpiresAt: number;
  leaseOwner: string;
  now: number;
}

export interface CleanupTerminalExternalMutationsInput {
  completedBefore: number;
  limit: number;
  parentIds?: readonly string[];
  parentOperationType: ExternalMutationParentOperationType;
  parentStates?: readonly ("failed" | "succeeded")[];
  userId?: string;
}

export interface CleanupTerminalExternalMutationsResult {
  dispatches: number;
  locks: number;
  mismatchedParents: number;
  parents: number;
}

interface DispatchRow {
  completedAt: number | null;
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  createdAt: number;
  dispatchAttemptCount: number;
  dispatchedAt: number | null;
  encryptedNormalizedRequest: string;
  failureCode: string | null;
  id: string;
  kind: ExternalMutationKind;
  leaseExpiresAt: number | null;
  leaseOwner: string | null;
  parentOperationId: string;
  parentOperationType: ExternalMutationParentOperationType;
  reconcileRequiredAt: number | null;
  state: ExternalMutationState;
  uncertainAt: number | null;
  updatedAt: number;
  userId: string;
}

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ExternalMutationJournalErrorCode =
  | "dispatch_not_found"
  | "invalid_input"
  | "invalid_transition"
  | "reservation_conflict"
  | "target_locked";

export class ExternalMutationJournalError extends Error {
  public readonly code: ExternalMutationJournalErrorCode;

  public constructor(code: ExternalMutationJournalErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ExternalMutationJournalError";
    this.code = code;
  }
}

const DISPATCH_SELECT = `
  select id, kind, parent_operation_type as parentOperationType,
    parent_operation_id as parentOperationId, user_id as userId,
    connector_id as connectorId,
    connector_instance_generation as connectorInstanceGeneration,
    connector_config_generation as connectorConfigGeneration,
    state, encrypted_normalized_request as encryptedNormalizedRequest,
    lease_owner as leaseOwner, lease_expires_at as leaseExpiresAt,
    dispatch_attempt_count as dispatchAttemptCount, dispatched_at as dispatchedAt,
    reconcile_required_at as reconcileRequiredAt, uncertain_at as uncertainAt,
    completed_at as completedAt, failure_code as failureCode,
    created_at as createdAt, updated_at as updatedAt
  from external_mutation_dispatches`;

const SAFE_INTEGER_MAXIMUM = 9_007_199_254_740_991;
const FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;
const CLOSED_PRE_DISPATCH_NO_OP_FAILURE_CODES = new Set([
  "already_in_desired_state",
  "already_satisfied",
  "dispatch_not_required",
  "no_dispatch_required",
]);
const PARENT_TABLES: Record<ExternalMutationParentOperationType, string> = {
  acquisition_grab_operation: "acquisition_grab_operations",
  acquisition_queue_recovery_operation: "acquisition_queue_recovery_operations",
  acquisition_search_operation: "acquisition_search_operations",
  download_queue_item_operation: "download_queue_item_operations",
  download_queue_removal_operation: "download_queue_removal_operations",
  library_mutation_operation: "library_mutation_operations",
  library_removal_operation: "library_removal_operations",
  media_issue_operation: "media_issue_operations",
  media_request_operation: "media_request_operations",
  playback_progress_operation: "playback_progress_operations",
  saved_list_operation: "saved_list_operations",
  subtitle_download_operation: "subtitle_download_operations",
  user_media_state_operation: "user_media_state_operations",
};

function safeGeneration(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= SAFE_INTEGER_MAXIMUM;
}

function safeTime(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function plainObject(value: object) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ExternalMutationJournalError("invalid_input");
    return value;
  }
  if (typeof value !== "object" || (!plainObject(value) && !Array.isArray(value))) {
    throw new ExternalMutationJournalError("invalid_input");
  }
  if (seen.has(value)) throw new ExternalMutationJournalError("invalid_input");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry, seen));
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJson((value as Record<string, unknown>)[key], seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

function assertText(value: string, maximum = 128) {
  if (value.length < 1 || value.length > maximum) {
    throw new ExternalMutationJournalError("invalid_input");
  }
}

function assertFailureCode(value: string) {
  if (!FAILURE_CODE_PATTERN.test(value)) {
    throw new ExternalMutationJournalError("invalid_input");
  }
}

function assertTransition(result: Database.RunResult) {
  if (result.changes !== 1) throw new ExternalMutationJournalError("invalid_transition");
}

export function externalMutationRequestEncryptionContext(
  id: string,
  kind: ExternalMutationKind,
): ExternalMutationRequestEncryptionContext {
  return `omnifin:v1:external-mutation:${kind}:${id}:normalized-request`;
}

/**
 * Mechanical journal primitives only. Callers own upstream dispatch and reconciliation policy.
 * In particular, this class never invokes an adapter and never retries a dispatched mutation.
 */
export class ExternalMutationJournal {
  readonly #cipher: EnvelopeCipher;
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database, encryptionKey: Buffer) {
    this.#sqlite = sqlite;
    this.#cipher = new EnvelopeCipher(encryptionKey);
  }

  public reserve(input: ReserveExternalMutationInput) {
    const policy = EXTERNAL_MUTATION_POLICIES[input.kind];
    if (
      policy.parentOperationType !== input.parentOperationType ||
      !safeGeneration(input.connectorInstanceGeneration) ||
      !safeGeneration(input.connectorConfigGeneration) ||
      !safeTime(input.now) ||
      !safeTime(input.leaseExpiresAt) ||
      input.leaseExpiresAt <= input.now ||
      !/^[A-Za-z0-9_-]{22}$|^[A-Za-z0-9_-]{43}$/u.test(input.targetDigest)
    ) {
      throw new ExternalMutationJournalError("invalid_input");
    }
    for (const value of [
      input.id,
      input.parentOperationId,
      input.userId,
      input.connectorId,
      input.leaseOwner,
    ]) {
      assertText(value);
    }
    const normalizedRequest = normalizeJson(input.normalizedRequest);
    const encryptedNormalizedRequest = this.#cipher.encrypt(
      JSON.stringify(normalizedRequest),
      externalMutationRequestEncryptionContext(input.id, input.kind),
    );
    try {
      this.#sqlite
        .transaction(() => {
          const lock = this.#sqlite
            .prepare(
              `select owner_dispatch_id as ownerDispatchId
               from external_mutation_target_locks
               where target_scope = ? and target_digest = ?`,
            )
            .get(policy.targetScope, input.targetDigest) as { ownerDispatchId: string } | undefined;
          if (lock) throw new ExternalMutationJournalError("target_locked");
          this.#sqlite
            .prepare(
              `insert into external_mutation_dispatches (
                 id, kind, parent_operation_type, parent_operation_id, user_id, connector_id,
                 connector_instance_generation, connector_config_generation, state,
                 encrypted_normalized_request, lease_owner, lease_expires_at,
                 dispatch_attempt_count, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, 0, ?, ?)`,
            )
            .run(
              input.id,
              input.kind,
              input.parentOperationType,
              input.parentOperationId,
              input.userId,
              input.connectorId,
              input.connectorInstanceGeneration,
              input.connectorConfigGeneration,
              encryptedNormalizedRequest,
              input.leaseOwner,
              input.leaseExpiresAt,
              input.now,
              input.now,
            );
          this.#sqlite
            .prepare(
              `insert into external_mutation_target_locks (
                 target_scope, target_digest, owner_dispatch_id, acquired_at
               ) values (?, ?, ?, ?)`,
            )
            .run(policy.targetScope, input.targetDigest, input.id, input.now);
        })
        .immediate();
    } catch (error) {
      if (error instanceof ExternalMutationJournalError) throw error;
      if ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new ExternalMutationJournalError("reservation_conflict", { cause: error });
      }
      throw error;
    }
    return this.read(input.id)!;
  }

  public claimStaleReserved(input: ClaimStaleReservedInput) {
    if (
      !safeTime(input.now) ||
      !safeTime(input.expectedLeaseExpiresAt) ||
      !safeTime(input.leaseExpiresAt) ||
      input.expectedLeaseExpiresAt >= input.now ||
      input.leaseExpiresAt <= input.now
    ) {
      throw new ExternalMutationJournalError("invalid_input");
    }
    assertText(input.id);
    assertText(input.expectedLeaseOwner);
    assertText(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update external_mutation_dispatches
         set lease_owner = ?, lease_expires_at = ?, updated_at = max(updated_at, ?)
         where id = ? and state = 'reserved' and lease_owner = ? and lease_expires_at = ?
           and lease_expires_at < ?`,
      )
      .run(
        input.leaseOwner,
        input.leaseExpiresAt,
        input.now,
        input.id,
        input.expectedLeaseOwner,
        input.expectedLeaseExpiresAt,
        input.now,
      );
    assertTransition(result);
    return this.read(input.id)!;
  }

  public markDispatched(input: { id: string; leaseOwner: string; now: number }) {
    if (!safeTime(input.now)) throw new ExternalMutationJournalError("invalid_input");
    assertText(input.id);
    assertText(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update external_mutation_dispatches
         set state = 'dispatched', lease_owner = null, lease_expires_at = null,
             dispatch_attempt_count = dispatch_attempt_count + 1,
             dispatched_at = ?, updated_at = max(updated_at, ?)
         where id = ? and state = 'reserved' and lease_owner = ? and lease_expires_at >= ?`,
      )
      .run(input.now, input.now, input.id, input.leaseOwner, input.now);
    assertTransition(result);
    return this.read(input.id)!;
  }

  public markReconcileRequired(input: { failureCode: string; id: string; now: number }) {
    this.#assertCompletionInput(input);
    const result = this.#sqlite
      .prepare(
        `update external_mutation_dispatches
         set state = 'reconcile_required', reconcile_required_at = ?, failure_code = ?,
             updated_at = max(updated_at, ?)
         where id = ? and state = 'dispatched'`,
      )
      .run(input.now, input.failureCode, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  public completeUncertain(input: { failureCode: string; id: string; now: number }) {
    this.#assertCompletionInput(input);
    const result = this.#sqlite
      .prepare(
        `update external_mutation_dispatches
         set state = 'uncertain', uncertain_at = ?, completed_at = ?, failure_code = ?,
             updated_at = max(updated_at, ?)
         where id = ? and state in ('dispatched', 'reconcile_required')`,
      )
      .run(input.now, input.now, input.failureCode, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  public completeSucceeded(input: { id: string; now: number }) {
    if (!safeTime(input.now)) throw new ExternalMutationJournalError("invalid_input");
    assertText(input.id);
    return this.#sqlite.transaction(() => {
      const result = this.#sqlite
        .prepare(
          `update external_mutation_dispatches
           set state = 'succeeded', completed_at = ?, failure_code = null,
               updated_at = max(updated_at, ?)
           where id = ? and state in ('dispatched', 'reconcile_required')`,
        )
        .run(input.now, input.now, input.id);
      assertTransition(result);
      this.#releaseTargetLockForTerminal(input.id, "succeeded");
      return this.read(input.id)!;
    })();
  }

  public completeFailed(input: { failureCode: string; id: string; now: number }) {
    this.#assertCompletionInput(input);
    return this.#sqlite.transaction(() => {
      const result = this.#sqlite
        .prepare(
          `update external_mutation_dispatches
           set state = 'failed', lease_owner = null, lease_expires_at = null,
               reconcile_required_at = null, completed_at = ?, failure_code = ?,
               updated_at = max(updated_at, ?)
           where id = ? and state in ('reserved', 'dispatched', 'reconcile_required')`,
        )
        .run(input.now, input.failureCode, input.now, input.id);
      assertTransition(result);
      this.#releaseTargetLockForTerminal(input.id, "failed");
      return this.read(input.id)!;
    })();
  }

  public releaseTargetLock(input: { id: string }) {
    const row = this.#row(input.id);
    if (!row) throw new ExternalMutationJournalError("dispatch_not_found");
    if (row.state !== "succeeded" && row.state !== "failed") {
      throw new ExternalMutationJournalError("invalid_transition");
    }
    return this.#releaseTargetLockForTerminal(row.id, row.state);
  }

  public read(id: string): ExternalMutationRecord | undefined {
    const row = this.#row(id);
    return row ? this.#record(row) : undefined;
  }

  public replay(input: {
    kind: ExternalMutationKind;
    parentOperationId: string;
    parentOperationType: ExternalMutationParentOperationType;
  }): ExternalMutationRecord | undefined {
    if (EXTERNAL_MUTATION_POLICIES[input.kind].parentOperationType !== input.parentOperationType) {
      throw new ExternalMutationJournalError("invalid_input");
    }
    const row = this.#sqlite
      .prepare(
        `${DISPATCH_SELECT}
         where parent_operation_type = ? and parent_operation_id = ? and kind = ?`,
      )
      .get(input.parentOperationType, input.parentOperationId, input.kind) as
      DispatchRow | undefined;
    return row ? this.#record(row) : undefined;
  }

  /**
   * Atomically removes bounded, lifecycle-matching terminal parents and their journal evidence.
   * Any parent with a nonterminal or contradictory dispatch is retained and counted.
   */
  public cleanupTerminalParents(
    input: CleanupTerminalExternalMutationsInput,
  ): CleanupTerminalExternalMutationsResult {
    return cleanupTerminalExternalMutations(this.#sqlite, input);
  }

  #assertCompletionInput(input: { failureCode: string; id: string; now: number }) {
    if (!safeTime(input.now)) throw new ExternalMutationJournalError("invalid_input");
    assertText(input.id);
    assertFailureCode(input.failureCode);
  }

  #record(row: DispatchRow): ExternalMutationRecord {
    const normalizedRequest = JSON.parse(
      this.#cipher.decrypt(
        row.encryptedNormalizedRequest,
        externalMutationRequestEncryptionContext(row.id, row.kind),
      ),
    ) as JsonValue;
    const record: Omit<DispatchRow, "encryptedNormalizedRequest"> & {
      encryptedNormalizedRequest?: string;
    } = { ...row };
    delete record.encryptedNormalizedRequest;
    return { ...record, normalizedRequest };
  }

  #releaseTargetLockForTerminal(id: string, state: "failed" | "succeeded") {
    const row = this.#row(id);
    if (!row) throw new ExternalMutationJournalError("dispatch_not_found");
    if (
      row.state !== state ||
      !EXTERNAL_MUTATION_TARGET_LOCK_RELEASE_POLICY[row.kind].includes(state)
    ) {
      throw new ExternalMutationJournalError("invalid_transition");
    }
    return this.#sqlite
      .prepare("delete from external_mutation_target_locks where owner_dispatch_id = ?")
      .run(id).changes;
  }

  #row(id: string) {
    return this.#sqlite.prepare(`${DISPATCH_SELECT} where id = ?`).get(id) as
      DispatchRow | undefined;
  }
}

export function cleanupTerminalExternalMutations(
  sqlite: Database.Database,
  input: CleanupTerminalExternalMutationsInput,
): CleanupTerminalExternalMutationsResult {
  if (
    !safeTime(input.completedBefore) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1_000
  ) {
    throw new ExternalMutationJournalError("invalid_input");
  }
  if (input.userId !== undefined) assertText(input.userId);
  if (input.parentIds !== undefined) {
    if (input.parentIds.length < 1 || input.parentIds.length > input.limit) {
      throw new ExternalMutationJournalError("invalid_input");
    }
    for (const id of input.parentIds) assertText(id);
  }
  const states = [...new Set(input.parentStates ?? ["succeeded", "failed"])] as Array<
    "failed" | "succeeded"
  >;
  if (states.length < 1 || states.some((state) => state !== "succeeded" && state !== "failed")) {
    throw new ExternalMutationJournalError("invalid_input");
  }
  const table = PARENT_TABLES[input.parentOperationType];
  const statePlaceholders = states.map(() => "?").join(", ");
  const parentPlaceholders = input.parentIds?.map(() => "?").join(", ");
  return sqlite.transaction(() => {
    const parents = sqlite
      .prepare(
        `select id, state from ${table}
         where state in (${statePlaceholders}) and completed_at <= ?
           ${input.userId === undefined ? "" : "and user_id = ?"}
           ${parentPlaceholders === undefined ? "" : `and id in (${parentPlaceholders})`}
         order by completed_at asc, id asc
         limit ?`,
      )
      .all(
        ...states,
        input.completedBefore,
        ...(input.userId === undefined ? [] : [input.userId]),
        ...(input.parentIds ?? []),
        input.limit,
      ) as Array<{ id: string; state: "failed" | "succeeded" }>;
    const result: CleanupTerminalExternalMutationsResult = {
      dispatches: 0,
      locks: 0,
      mismatchedParents: 0,
      parents: 0,
    };
    for (const parent of parents) {
      const dispatches = sqlite
        .prepare(
          `select id, state, dispatch_attempt_count as dispatchAttemptCount,
                  dispatched_at as dispatchedAt, failure_code as failureCode
           from external_mutation_dispatches
           where parent_operation_type = ? and parent_operation_id = ?
           order by id asc`,
        )
        .all(input.parentOperationType, parent.id) as Array<{
        dispatchAttemptCount: number;
        dispatchedAt: number | null;
        failureCode: string | null;
        id: string;
        state: ExternalMutationState;
      }>;
      if (
        dispatches.some(
          (dispatch) =>
            dispatch.state !== parent.state &&
            !(
              parent.state === "succeeded" &&
              dispatch.state === "failed" &&
              dispatch.failureCode !== null &&
              CLOSED_PRE_DISPATCH_NO_OP_FAILURE_CODES.has(dispatch.failureCode) &&
              dispatch.dispatchAttemptCount === 0 &&
              dispatch.dispatchedAt === null
            ),
        )
      ) {
        result.mismatchedParents += 1;
        continue;
      }
      const lockDeletion = sqlite
        .prepare(
          `delete from external_mutation_target_locks
           where owner_dispatch_id in (
             select id from external_mutation_dispatches
             where parent_operation_type = ? and parent_operation_id = ?
           )`,
        )
        .run(input.parentOperationType, parent.id);
      const dispatchDeletion = sqlite
        .prepare(
          `delete from external_mutation_dispatches
           where parent_operation_type = ? and parent_operation_id = ?`,
        )
        .run(input.parentOperationType, parent.id);
      const parentDeletion = sqlite
        .prepare(
          `delete from ${table}
           where id = ? and state = ? and completed_at <= ?`,
        )
        .run(parent.id, parent.state, input.completedBefore);
      if (parentDeletion.changes !== 1) {
        throw new ExternalMutationJournalError("invalid_transition");
      }
      result.locks += lockDeletion.changes;
      result.dispatches += dispatchDeletion.changes;
      result.parents += 1;
    }
    return result;
  })();
}
