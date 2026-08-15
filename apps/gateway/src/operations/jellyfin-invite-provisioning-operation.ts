import type Database from "better-sqlite3";

export type JellyfinInviteProvisioningState =
  | "reserved"
  | "creating"
  | "created"
  | "policy_pending"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "reconcile_required";

export interface JellyfinInviteProvisioningOperationRecord {
  completedAt: number | null;
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  connectorInstanceIdentityHash: string | null;
  connectorRevision: string;
  createAttemptCount: number;
  createdAt: number;
  creatingAt: number | null;
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  invitationId: string;
  leaseExpiresAt: number | null;
  leaseOwner: string | null;
  policyCompletedAt: number | null;
  policyPendingAt: number | null;
  provisionedAt: number | null;
  provisionedUserId: string | null;
  reconcileRequiredAt: number | null;
  state: JellyfinInviteProvisioningState;
  templateIdentifier: string;
  uncertainAt: number | null;
  updatedAt: number;
}

export interface ReserveJellyfinInviteProvisioningInput {
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  connectorInstanceIdentityHash: string | null;
  connectorRevision: string;
  fingerprintHash: string;
  id: string;
  invitationId: string;
  leaseExpiresAt: number;
  leaseOwner: string;
  now: number;
  templateIdentifier: string;
}

export interface ClaimStaleJellyfinInviteReservationInput {
  expectedLeaseExpiresAt: number;
  expectedLeaseOwner: string;
  id: string;
  leaseExpiresAt: number;
  leaseOwner: string;
  now: number;
}

export interface MarkCreatedInput {
  id: string;
  now: number;
  provisionedUserId: string;
}

export interface JellyfinInviteProvisioningCompletionInput {
  failureCode: string;
  id: string;
  now: number;
}

export type JellyfinInviteProvisioningFinalizationReason =
  "failed" | "incomplete" | "reconcile_required" | "ready" | "uncertain";

export interface JellyfinInviteProvisioningFinalizationEligibility {
  eligible: boolean;
  reason: JellyfinInviteProvisioningFinalizationReason;
}

export type JellyfinInviteProvisioningOperationErrorCode =
  "invalid_input" | "invalid_transition" | "reservation_conflict";

export class JellyfinInviteProvisioningOperationError extends Error {
  public readonly code: JellyfinInviteProvisioningOperationErrorCode;

  public constructor(code: JellyfinInviteProvisioningOperationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "JellyfinInviteProvisioningOperationError";
    this.code = code;
  }
}

const OPERATION_SELECT = `
  select id, invitation_id as invitationId, connector_id as connectorId,
    connector_revision as connectorRevision,
    connector_instance_generation as connectorInstanceGeneration,
    connector_config_generation as connectorConfigGeneration,
    connector_instance_identity_hash as connectorInstanceIdentityHash,
    fingerprint_hash as fingerprintHash,
    template_identifier as templateIdentifier,
    state, lease_owner as leaseOwner, lease_expires_at as leaseExpiresAt,
    create_attempt_count as createAttemptCount, creating_at as creatingAt,
    provisioned_user_id as provisionedUserId, provisioned_at as provisionedAt,
    policy_pending_at as policyPendingAt, policy_completed_at as policyCompletedAt,
    reconcile_required_at as reconcileRequiredAt, uncertain_at as uncertainAt,
    completed_at as completedAt, failure_code as failureCode,
    created_at as createdAt, updated_at as updatedAt
  from jellyfin_invite_provisioning_operations`;

const LIVE_CONNECTOR_BINDING = `exists (
  select 1
  from connector_configs as connector
  inner join jellyfin_provisioning_configs as provisioning
    on provisioning.connector_id = connector.id
  where connector.id = jellyfin_invite_provisioning_operations.connector_id
    and connector.type = 'jellyfin'
    and connector.enabled = 1
    and connector.instance_generation =
      jellyfin_invite_provisioning_operations.connector_instance_generation
    and connector.config_generation =
      jellyfin_invite_provisioning_operations.connector_config_generation
    and connector.instance_identity_hash is
      jellyfin_invite_provisioning_operations.connector_instance_identity_hash
    and provisioning.connector_revision =
      jellyfin_invite_provisioning_operations.connector_revision
    and provisioning.connector_instance_generation =
      jellyfin_invite_provisioning_operations.connector_instance_generation
    and provisioning.connector_instance_identity_hash is
      jellyfin_invite_provisioning_operations.connector_instance_identity_hash
)`;

const SAFE_INTEGER_MAXIMUM = 9_007_199_254_740_991;
const FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;
const REVISION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const IDENTITY_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{22}$|^[A-Za-z0-9_-]{43}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROVISIONED_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const INVITATION_PATTERN = /^invite_[A-Za-z0-9_-]{1,121}$/u;
const OPERATION_ID_PATTERN = /^jellyfin_invite_provision_operation_[A-Za-z0-9_-]{22}$/u;

function safeGeneration(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= SAFE_INTEGER_MAXIMUM;
}

function safeTime(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function assertText(value: string, maximum = 128) {
  if (value.length < 1 || value.length > maximum) {
    throw new JellyfinInviteProvisioningOperationError("invalid_input");
  }
}

function assertOperationId(value: string) {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new JellyfinInviteProvisioningOperationError("invalid_input");
  }
}

function assertFailureCode(value: string) {
  if (!FAILURE_CODE_PATTERN.test(value)) {
    throw new JellyfinInviteProvisioningOperationError("invalid_input");
  }
}

function assertTransition(result: Database.RunResult) {
  if (result.changes !== 1) {
    throw new JellyfinInviteProvisioningOperationError("invalid_transition");
  }
}

/**
 * Durable, invitation-unique journal for Jellyfin user provisioning. This service only
 * records intent, dispatch, and outcome; it never performs an upstream call, never
 * consumes an invitation, and never stores a username, password, credential, policy
 * payload, or upstream error detail. The reservation row itself is the invitation lock:
 * the unique `invitation_id` constraint makes exactly one provisioning operation
 * representable per invitation, and stale lease reclamation is only valid while
 * `reserved`, so no transition can ever issue a second create.
 */
export class JellyfinInviteProvisioningOperationService {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  /**
   * Durable reservation, taken before any external mutation. Fails with
   * `reservation_conflict` when the invitation is already represented.
   */
  public reserve(input: ReserveJellyfinInviteProvisioningInput) {
    if (
      !safeGeneration(input.connectorInstanceGeneration) ||
      !safeGeneration(input.connectorConfigGeneration) ||
      !safeTime(input.now) ||
      !safeTime(input.leaseExpiresAt) ||
      input.leaseExpiresAt <= input.now ||
      !REVISION_PATTERN.test(input.connectorRevision) ||
      !FINGERPRINT_PATTERN.test(input.fingerprintHash) ||
      !IDENTIFIER_PATTERN.test(input.templateIdentifier) ||
      (input.connectorInstanceIdentityHash !== null &&
        !IDENTITY_HASH_PATTERN.test(input.connectorInstanceIdentityHash))
    ) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    if (!INVITATION_PATTERN.test(input.invitationId)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    assertOperationId(input.id);
    for (const value of [input.connectorId, input.leaseOwner]) {
      assertText(value);
    }
    try {
      this.#sqlite
        .prepare(
          `insert into jellyfin_invite_provisioning_operations (
             id, invitation_id, connector_id, connector_revision,
             connector_instance_generation, connector_config_generation,
             connector_instance_identity_hash, fingerprint_hash, template_identifier,
             state, lease_owner, lease_expires_at, create_attempt_count,
             created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, 0, ?, ?)`,
        )
        .run(
          input.id,
          input.invitationId,
          input.connectorId,
          input.connectorRevision,
          input.connectorInstanceGeneration,
          input.connectorConfigGeneration,
          input.connectorInstanceIdentityHash,
          input.fingerprintHash,
          input.templateIdentifier,
          input.leaseOwner,
          input.leaseExpiresAt,
          input.now,
          input.now,
        );
    } catch (error) {
      if ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new JellyfinInviteProvisioningOperationError("reservation_conflict", {
          cause: error,
        });
      }
      throw error;
    }
    return this.read(input.id)!;
  }

  /**
   * Reclaims the reservation only when the exact stale reserved lease is observed.
   * Invalid once creating has begun.
   */
  public claimStaleReserved(input: ClaimStaleJellyfinInviteReservationInput) {
    if (
      !safeTime(input.now) ||
      !safeTime(input.expectedLeaseExpiresAt) ||
      !safeTime(input.leaseExpiresAt) ||
      input.expectedLeaseExpiresAt >= input.now ||
      input.leaseExpiresAt <= input.now
    ) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    assertOperationId(input.id);
    assertText(input.expectedLeaseOwner);
    assertText(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
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

  /**
   * One-way create dispatch. The exact reserved lease and the current connector plus
   * provisioning configuration must match the durable snapshot. A binding change is a
   * known pre-dispatch failure, so it cannot increment the create attempt or be retried.
   */
  public markCreating(input: { id: string; leaseOwner: string; now: number }) {
    if (!safeTime(input.now)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    assertOperationId(input.id);
    assertText(input.leaseOwner);
    const creating = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'creating', lease_owner = null, lease_expires_at = null,
             create_attempt_count = create_attempt_count + 1,
             creating_at = ?, updated_at = max(updated_at, ?)
         where id = ? and state = 'reserved' and lease_owner = ? and lease_expires_at >= ?
           and ${LIVE_CONNECTOR_BINDING}`,
      )
      .run(input.now, input.now, input.id, input.leaseOwner, input.now);
    if (creating.changes === 1) return this.read(input.id)!;

    const mismatchedBinding = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'failed', lease_owner = null, lease_expires_at = null,
             completed_at = ?, failure_code = 'connector_binding_mismatch',
             updated_at = max(updated_at, ?)
         where id = ? and state = 'reserved' and lease_owner = ? and lease_expires_at >= ?
           and not ${LIVE_CONNECTOR_BINDING}`,
      )
      .run(input.now, input.now, input.id, input.leaseOwner, input.now);
    if (mismatchedBinding.changes === 1) return this.read(input.id)!;

    throw new JellyfinInviteProvisioningOperationError("invalid_transition");
  }

  /**
   * Persists the exact validated upstream user id returned by the create call before
   * any policy transition. Rejected once policy work has begun.
   */
  public markCreated(input: MarkCreatedInput) {
    if (!safeTime(input.now)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    assertOperationId(input.id);
    if (!PROVISIONED_USER_PATTERN.test(input.provisionedUserId)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    const result = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'created', provisioned_user_id = ?, provisioned_at = ?,
             updated_at = max(updated_at, ?)
         where id = ? and state = 'creating'`,
      )
      .run(input.provisionedUserId, input.now, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  /** Records that policy application on the provisioned user has begun. */
  public markPolicyPending(input: { id: string; now: number }) {
    if (!safeTime(input.now)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    assertOperationId(input.id);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'policy_pending', policy_pending_at = ?, updated_at = max(updated_at, ?)
         where id = ? and state = 'created'`,
      )
      .run(input.now, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  /** Records confirmed policy completion evidence and finalizes the operation. */
  public markSucceeded(input: { id: string; now: number }) {
    if (!safeTime(input.now)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    assertOperationId(input.id);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'succeeded', policy_completed_at = ?, completed_at = ?,
             failure_code = null, updated_at = max(updated_at, ?)
         where id = ? and state = 'policy_pending'`,
      )
      .run(input.now, input.now, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  /** Known pre-dispatch failure only: the create was never issued. */
  public markFailed(input: JellyfinInviteProvisioningCompletionInput) {
    this.#assertCompletionInput(input);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'failed', lease_owner = null, lease_expires_at = null,
             completed_at = ?, failure_code = ?, updated_at = max(updated_at, ?)
         where id = ? and state = 'reserved'`,
      )
      .run(input.now, input.failureCode, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  /**
   * Post-dispatch ambiguity or policy failure after a returned user id. Never
   * reachable from `reserved`; the row retains its evidence and invitation lock.
   */
  public markReconcileRequired(input: JellyfinInviteProvisioningCompletionInput) {
    this.#assertCompletionInput(input);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'reconcile_required', reconcile_required_at = ?, failure_code = ?,
             updated_at = max(updated_at, ?)
         where id = ? and state in ('creating', 'created', 'policy_pending')`,
      )
      .run(input.now, input.failureCode, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  /** Terminal post-dispatch ambiguity. Only reachable from `reconcile_required`. */
  public completeUncertain(input: JellyfinInviteProvisioningCompletionInput) {
    this.#assertCompletionInput(input);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_invite_provisioning_operations
         set state = 'uncertain', uncertain_at = ?, completed_at = ?, failure_code = ?,
             updated_at = max(updated_at, ?)
         where id = ? and state = 'reconcile_required'`,
      )
      .run(input.now, input.now, input.failureCode, input.now, input.id);
    assertTransition(result);
    return this.read(input.id)!;
  }

  /**
   * Finalization gate for the later atomic invitation consumption step: only a
   * succeeded operation with policy completion evidence is eligible. This service
   * never consumes the invitation itself.
   */
  public finalizationEligibility(
    id: string,
  ): JellyfinInviteProvisioningFinalizationEligibility | undefined {
    assertOperationId(id);
    const record = this.read(id);
    if (!record) return undefined;
    if (record.state === "succeeded" && record.policyCompletedAt !== null) {
      return { eligible: true, reason: "ready" };
    }
    const reason: JellyfinInviteProvisioningFinalizationReason =
      record.state === "failed"
        ? "failed"
        : record.state === "uncertain"
          ? "uncertain"
          : record.state === "reconcile_required"
            ? "reconcile_required"
            : "incomplete";
    return { eligible: false, reason };
  }

  public read(id: string): JellyfinInviteProvisioningOperationRecord | undefined {
    assertOperationId(id);
    return this.#sqlite.prepare(`${OPERATION_SELECT} where id = ?`).get(id) as
      JellyfinInviteProvisioningOperationRecord | undefined;
  }

  /** The single operation represented for an invitation, if any. */
  public replay(input: {
    invitationId: string;
  }): JellyfinInviteProvisioningOperationRecord | undefined {
    if (!INVITATION_PATTERN.test(input.invitationId)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    return this.#sqlite
      .prepare(`${OPERATION_SELECT} where invitation_id = ?`)
      .get(input.invitationId) as JellyfinInviteProvisioningOperationRecord | undefined;
  }

  #assertCompletionInput(input: JellyfinInviteProvisioningCompletionInput) {
    if (!safeTime(input.now)) {
      throw new JellyfinInviteProvisioningOperationError("invalid_input");
    }
    assertOperationId(input.id);
    assertFailureCode(input.failureCode);
  }
}
