import type Database from "better-sqlite3";
import { EnvelopeCipher } from "../security/crypto.js";

const SAFE_INTEGER_MAXIMUM = 9_007_199_254_740_991;
const MAX_TIME = 8_640_000_000_000_000;
const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const ACTIVATION_ID = /^jellyfin_[A-Za-z0-9_-]{1,118}$/u;
const FAILURE_CODE = /^[a-z0-9_]{1,64}$/u;
const CREATED_ID = /^[A-Za-z0-9_-]{1,256}$/u;

export type JellyfinActivationState =
  | "reserved"
  | "create_dispatched"
  | "created"
  | "policy_pending"
  | "auth_pending"
  | "manual_required"
  | "tombstoned";

export type JellyfinActivationFailureCode =
  | "binding_mismatch"
  | "create_outcome_uncertain"
  | "invalid_artifact"
  | "restore_sanitized"
  | "restore_timeline_uncertain"
  | "cleanup_uncertain"
  | "manual_required";

export interface JellyfinActivationBindingSnapshot {
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  connectorInstanceIdentityHash: string | null;
  provisioningRevision: number;
}

export interface ReserveJellyfinActivationInput extends JellyfinActivationBindingSnapshot {
  externalIdentityId: string;
  id: string;
  invitationId: string;
  leaseExpiresAt: number;
  leaseOwner: string;
  now: number;
  userId: string;
}

export interface JellyfinActivationOperation {
  readonly activationStatus: "pending" | "completed";
  readonly activationCompletedLinkId: string | null;
  readonly artifactRevision: number;
  readonly connectorConfigGeneration: number;
  readonly connectorId: string;
  readonly connectorInstanceGeneration: number;
  readonly connectorInstanceIdentityHash: string | null;
  readonly createAttemptCount: number;
  readonly cleanupAttemptCount: number;
  readonly createDispatchedAt: number | null;
  readonly createdIdRecordedAt: number | null;
  readonly externalIdentityId: string;
  readonly failureCode: JellyfinActivationFailureCode | null;
  readonly id: string;
  readonly invitationId: string;
  readonly leaseExpiresAt: number | null;
  readonly leaseOwner: string | null;
  readonly manualRequiredAt: number | null;
  readonly provisioningRevision: number;
  readonly reservedAt: number;
  readonly retryCount: number;
  readonly revision: number;
  readonly state: JellyfinActivationState;
  readonly tombstonedAt: number | null;
  readonly userId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface JellyfinActivationStageArtifact {
  readonly createdId: string;
  readonly serverId?: string;
  readonly username?: string;
  readonly password?: string;
  readonly accessToken?: string;
  readonly policy?: Record<string, unknown>;
}

export type JellyfinActivationStoredArtifact = JellyfinActivationStageArtifact;

export type JellyfinActivationOperationErrorCode =
  | "invalid_input"
  | "invalid_transition"
  | "reservation_conflict"
  | "operation_not_found"
  | "artifact_not_found";

export class JellyfinActivationOperationError extends Error {
  public readonly code: JellyfinActivationOperationErrorCode;

  public constructor(code: JellyfinActivationOperationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "JellyfinActivationOperationError";
    this.code = code;
  }
}

interface ActivationRow {
  activationStatus: "pending" | "completed";
  activationCompletedLinkId: string | null;
  artifactRevision: number;
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  connectorInstanceIdentityHash: string | null;
  createAttemptCount: number;
  cleanupAttemptCount: number;
  createDispatchedAt: number | null;
  createdAt: number;
  createdIdRecordedAt: number | null;
  encryptedStageArtifact: string | null;
  cleanupEligible: number;
  externalIdentityId: string;
  failureCode: string | null;
  id: string;
  invitationId: string;
  leaseExpiresAt: number | null;
  leaseOwner: string | null;
  manualRequiredAt: number | null;
  provisioningRevision: number;
  reservedAt: number;
  retryCount: number;
  revision: number;
  state: JellyfinActivationState;
  tombstonedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  userId: string;
}

const SELECT = `select id, invitation_id as invitationId, user_id as userId,
 external_identity_id as externalIdentityId, connector_id as connectorId,
 connector_config_generation as connectorConfigGeneration,
 connector_instance_generation as connectorInstanceGeneration,
 connector_instance_identity_hash as connectorInstanceIdentityHash,
 provisioning_revision as provisioningRevision, state, revision,
 encrypted_stage_artifact as encryptedStageArtifact, artifact_revision as artifactRevision,
 cleanup_eligible as cleanupEligible, cleanup_attempt_count as cleanupAttemptCount,
 lease_owner as leaseOwner, lease_expires_at as leaseExpiresAt,
 create_attempt_count as createAttemptCount, retry_count as retryCount,
 failure_code as failureCode, reserved_at as reservedAt,
 create_dispatched_at as createDispatchedAt, created_id_recorded_at as createdIdRecordedAt,
 manual_required_at as manualRequiredAt, tombstoned_at as tombstonedAt,
 created_at as createdAt, updated_at as updatedAt,
 activation_status as activationStatus, activation_completed_link_id as activationCompletedLinkId,
 completed_at as completedAt
 from jellyfin_activation_operations`;

function validTime(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
}

function validGeneration(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= SAFE_INTEGER_MAXIMUM;
}

function text(value: string, pattern = ID) {
  if (value.length < 1 || value.length > 128 || !pattern.test(value))
    throw new JellyfinActivationOperationError("invalid_input");
}

function transition(result: Database.RunResult) {
  if (result.changes !== 1) throw new JellyfinActivationOperationError("invalid_transition");
}

function assertReservation(input: ReserveJellyfinActivationInput) {
  if (
    !ACTIVATION_ID.test(input.id) ||
    !validTime(input.now) ||
    !validTime(input.leaseExpiresAt) ||
    input.leaseExpiresAt <= input.now ||
    !validGeneration(input.connectorConfigGeneration) ||
    !validGeneration(input.connectorInstanceGeneration) ||
    !Number.isSafeInteger(input.provisioningRevision) ||
    input.provisioningRevision < 0 ||
    input.provisioningRevision > 2_147_483_647 ||
    (input.connectorInstanceIdentityHash !== null &&
      !/^[A-Za-z0-9_-]{16,128}$/u.test(input.connectorInstanceIdentityHash))
  )
    throw new JellyfinActivationOperationError("invalid_input");
  text(input.invitationId);
  text(input.userId);
  text(input.externalIdentityId);
  text(input.connectorId);
  text(input.leaseOwner);
}

function parseFailureCode(value: string | null): JellyfinActivationFailureCode | null {
  if (value === null) return null;
  if (!FAILURE_CODE.test(value)) throw new JellyfinActivationOperationError("invalid_input");
  return value as JellyfinActivationFailureCode;
}

export function jellyfinActivationArtifactEncryptionContext(id: string, artifactRevision: number) {
  if (!ACTIVATION_ID.test(id) || !Number.isSafeInteger(artifactRevision) || artifactRevision < 1) {
    throw new JellyfinActivationOperationError("invalid_input");
  }
  return `omnifin:v1:jellyfin-activation:${id}:artifact:${artifactRevision}`;
}

export class JellyfinActivationOperationRepository {
  readonly #cipher: EnvelopeCipher;
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database, encryptionKey: Buffer) {
    this.#sqlite = sqlite;
    this.#cipher = new EnvelopeCipher(encryptionKey);
  }

  public reserve(input: ReserveJellyfinActivationInput) {
    assertReservation(input);
    try {
      this.#sqlite
        .transaction(() => {
          this.#sqlite
            .prepare(
              `insert into jellyfin_activation_operations (
          id, invitation_id, user_id, external_identity_id, connector_id,
          connector_config_generation, connector_instance_generation,
          connector_instance_identity_hash, provisioning_revision, state, revision,
          artifact_revision, lease_owner, lease_expires_at, create_attempt_count,
          retry_count, cleanup_attempt_count, reserved_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 0, 0, ?, ?, 0, 0, 0, ?, ?, ?)`,
            )
            .run(
              input.id,
              input.invitationId,
              input.userId,
              input.externalIdentityId,
              input.connectorId,
              input.connectorConfigGeneration,
              input.connectorInstanceGeneration,
              input.connectorInstanceIdentityHash,
              input.provisioningRevision,
              input.leaseOwner,
              input.leaseExpiresAt,
              input.now,
              input.now,
              input.now,
            );
        })
        .immediate();
    } catch (error) {
      if ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new JellyfinActivationOperationError("reservation_conflict", { cause: error });
      }
      throw error;
    }
    return this.read(input.id)!;
  }

  public reserveInExistingTransaction(input: ReserveJellyfinActivationInput) {
    assertReservation(input);
    if (!this.#sqlite.inTransaction)
      throw new JellyfinActivationOperationError("invalid_transition");
    try {
      this.#sqlite
        .prepare(
          `insert into jellyfin_activation_operations (
            id, invitation_id, user_id, external_identity_id, connector_id,
            connector_config_generation, connector_instance_generation,
            connector_instance_identity_hash, provisioning_revision, state, revision,
            artifact_revision, lease_owner, lease_expires_at, create_attempt_count,
            retry_count, cleanup_attempt_count, reserved_at, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 0, 0, ?, ?, 0, 0, 0, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.invitationId,
          input.userId,
          input.externalIdentityId,
          input.connectorId,
          input.connectorConfigGeneration,
          input.connectorInstanceGeneration,
          input.connectorInstanceIdentityHash,
          input.provisioningRevision,
          input.leaseOwner,
          input.leaseExpiresAt,
          input.now,
          input.now,
          input.now,
        );
      const marker = this.#sqlite
        .prepare(
          `update invitations set activation_operation_id = ?, activation_claimed_at = consumed_at
           where id = ? and activation_operation_id is null and consumed_at is not null
             and activation_claimed_at is null`,
        )
        .run(input.id, input.invitationId);
      if (marker.changes !== 1) throw new JellyfinActivationOperationError("reservation_conflict");
    } catch (error) {
      if ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new JellyfinActivationOperationError("reservation_conflict", { cause: error });
      }
      throw error;
    }
    return this.read(input.id)!;
  }

  public read(id: string): JellyfinActivationOperation | undefined {
    text(id, ACTIVATION_ID);
    const row = this.#sqlite.prepare(`${SELECT} where id = ?`).get(id) as ActivationRow | undefined;
    return row ? this.#record(row) : undefined;
  }

  public claimLease(input: {
    id: string;
    expectedOwner: string;
    expectedExpiresAt: number;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
  }) {
    if (
      !validTime(input.now) ||
      !validTime(input.expectedExpiresAt) ||
      !validTime(input.leaseExpiresAt) ||
      input.expectedExpiresAt >= input.now ||
      input.leaseExpiresAt <= input.now
    )
      throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    text(input.expectedOwner);
    text(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set lease_owner = ?, lease_expires_at = ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and lease_owner = ? and lease_expires_at = ? and lease_expires_at < ? and state in ('reserved','create_dispatched','created','policy_pending','auth_pending')`,
      )
      .run(
        input.leaseOwner,
        input.leaseExpiresAt,
        input.now,
        input.id,
        input.expectedOwner,
        input.expectedExpiresAt,
        input.now,
      );
    transition(result);
    return this.read(input.id)!;
  }

  public acquireStageLease(input: {
    id: string;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
  }) {
    if (
      !validTime(input.now) ||
      !validTime(input.leaseExpiresAt) ||
      input.leaseExpiresAt <= input.now
    )
      throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    text(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations
         set lease_owner = ?, lease_expires_at = ?, revision = revision + 1,
             updated_at = max(updated_at, ?)
         where id = ?
           and state in ('created', 'policy_pending')
           and (lease_owner is null or lease_expires_at < ?)`,
      )
      .run(input.leaseOwner, input.leaseExpiresAt, input.now, input.id, input.now);
    if (result.changes !== 1) throw new JellyfinActivationOperationError("invalid_transition");
    return this.read(input.id)!;
  }

  public releaseStageLease(input: { id: string; leaseOwner: string; now: number }) {
    if (!validTime(input.now)) throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    text(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations
         set lease_owner = null, lease_expires_at = null,
             updated_at = max(updated_at, ?)
         where id = ? and lease_owner = ?`,
      )
      .run(input.now, input.id, input.leaseOwner);
    transition(result);
  }

  public dispatchCreate(input: { id: string; leaseOwner: string; now: number }) {
    if (!validTime(input.now)) throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    text(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set state = 'create_dispatched', create_attempt_count = 1, create_dispatched_at = ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state = 'reserved' and create_attempt_count = 0 and lease_owner = ? and lease_expires_at >= ?`,
      )
      .run(input.now, input.now, input.id, input.leaseOwner, input.now);
    transition(result);
    return this.read(input.id)!;
  }

  public recordCreatedIdArtifact(input: { id: string; createdId: string; now: number }) {
    if (!validTime(input.now) || !CREATED_ID.test(input.createdId))
      throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    return this.#sqlite.transaction(() => {
      const row = this.#row(input.id);
      if (!row) throw new JellyfinActivationOperationError("operation_not_found");
      if (
        row.state !== "create_dispatched" ||
        row.createAttemptCount !== 1 ||
        row.encryptedStageArtifact !== null
      )
        throw new JellyfinActivationOperationError("invalid_transition");
      const artifactRevision = row.artifactRevision + 1;
      const encrypted = this.#cipher.encrypt(
        JSON.stringify({ createdId: input.createdId }),
        jellyfinActivationArtifactEncryptionContext(input.id, artifactRevision),
      );
      const result = this.#sqlite
        .prepare(
          `update jellyfin_activation_operations set state = 'created', encrypted_stage_artifact = ?, artifact_revision = ?, cleanup_eligible = 1, created_id_recorded_at = ?, lease_owner = null, lease_expires_at = null, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state = 'create_dispatched' and revision = ?`,
        )
        .run(encrypted, artifactRevision, input.now, input.now, input.id, row.revision);
      transition(result);
      return this.read(input.id)!;
    })();
  }

  public recordStageArtifact(input: {
    id: string;
    artifact: JellyfinActivationStageArtifact;
    state: "created" | "policy_pending" | "auth_pending";
    now: number;
  }) {
    if (!validTime(input.now) || !CREATED_ID.test(input.artifact.createdId))
      throw new JellyfinActivationOperationError("invalid_input");
    for (const value of [
      input.artifact.username,
      input.artifact.password,
      input.artifact.accessToken,
    ]) {
      if (value !== undefined && (value.length < 1 || value.length > 4096))
        throw new JellyfinActivationOperationError("invalid_input");
    }
    text(input.id, ACTIVATION_ID);
    return this.#sqlite.transaction(() => {
      const row = this.#row(input.id);
      if (!row || !["created", "policy_pending", "auth_pending"].includes(row.state))
        throw new JellyfinActivationOperationError("invalid_transition");
      const artifactRevision = row.artifactRevision + 1;
      const encrypted = this.#cipher.encrypt(
        JSON.stringify(input.artifact),
        jellyfinActivationArtifactEncryptionContext(input.id, artifactRevision),
      );
      const result = this.#sqlite
        .prepare(
          `update jellyfin_activation_operations set state = ?, encrypted_stage_artifact = ?, artifact_revision = ?, cleanup_eligible = 1, lease_owner = null, lease_expires_at = null, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and revision = ? and state in ('created','policy_pending','auth_pending')`,
        )
        .run(input.state, encrypted, artifactRevision, input.now, input.id, row.revision);
      transition(result);
      return this.read(input.id)!;
    })();
  }

  public completeActivation(input: {
    id: string;
    linkId: string;
    now: number;
    expectedRevision?: number;
  }) {
    if (!validTime(input.now)) throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    text(input.linkId);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations
         set state = 'tombstoned', activation_status = 'completed',
             activation_completed_link_id = ?, encrypted_stage_artifact = null,
             cleanup_eligible = 0, artifact_revision = artifact_revision + 1,
             lease_owner = null, lease_expires_at = null, completed_at = ?,
             tombstoned_at = ?, revision = revision + 1, updated_at = max(updated_at, ?)
         where id = ? and state = 'auth_pending' and activation_status = 'pending'
           and revision = coalesce(?, revision)`,
      )
      .run(input.linkId, input.now, input.now, input.now, input.id, input.expectedRevision ?? null);
    transition(result);
    return this.read(input.id)!;
  }

  public markManualRequired(input: {
    id: string;
    failureCode: string;
    now: number;
    incrementRetry?: boolean;
  }) {
    if (!validTime(input.now) || !FAILURE_CODE.test(input.failureCode))
      throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    return this.#sqlite.transaction(() => {
      const row = this.#row(input.id);
      if (!row || row.state === "manual_required" || row.state === "tombstoned") {
        throw new JellyfinActivationOperationError("invalid_transition");
      }
      const retryIncrement = input.incrementRetry === false ? 0 : 1;
      let artifact: string | null = null;
      let artifactRevision = row.artifactRevision;
      let cleanupEligible = 0;
      if (row.cleanupEligible === 1 && row.encryptedStageArtifact !== null) {
        try {
          const parsed = JSON.parse(
            this.#cipher.decrypt(
              row.encryptedStageArtifact,
              jellyfinActivationArtifactEncryptionContext(row.id, row.artifactRevision),
            ),
          ) as { createdId?: unknown };
          if (typeof parsed.createdId !== "string" || !CREATED_ID.test(parsed.createdId)) {
            throw new Error("created ID artifact is invalid");
          }
          artifact = row.encryptedStageArtifact;
          cleanupEligible = 1;
        } catch (error) {
          throw new JellyfinActivationOperationError("artifact_not_found", { cause: error });
        }
      } else {
        artifactRevision += 1;
      }
      const result = this.#sqlite
        .prepare(
          `update jellyfin_activation_operations set state = 'manual_required', encrypted_stage_artifact = ?, cleanup_eligible = ?, artifact_revision = ?, failure_code = ?, manual_required_at = ?, lease_owner = null, lease_expires_at = null, retry_count = retry_count + ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and revision = ? and state not in ('manual_required','tombstoned') and retry_count + ? <= 8`,
        )
        .run(
          artifact,
          cleanupEligible,
          artifactRevision,
          input.failureCode,
          input.now,
          retryIncrement,
          input.now,
          input.id,
          row.revision,
          retryIncrement,
        );
      transition(result);
      return this.read(input.id)!;
    })();
  }

  public completeConfirmedCleanup(
    id: string,
    now: number,
    leaseOwner: string,
    operationRevision: number,
  ) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    text(id, ACTIVATION_ID);
    const result = this.#sqlite
      .transaction(() => {
        const updated = this.#sqlite
          .prepare(
            `update jellyfin_activation_operations set state = 'tombstoned', encrypted_stage_artifact = null, cleanup_eligible = 0, artifact_revision = artifact_revision + 1, lease_owner = null, lease_expires_at = null, tombstoned_at = ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state = 'manual_required' and cleanup_eligible = 1 and lease_owner = ? and revision = ?`,
          )
          .run(now, now, id, leaseOwner, operationRevision);
        if (updated.changes !== 1) throw new JellyfinActivationOperationError("invalid_transition");
        const reservation = this.#sqlite
          .prepare(
            `update jellyfin_activation_cleanup_reservations
             set state = 'confirmed', updated_at = ?
             where operation_id = ? and state = 'dispatched'
               and lease_owner = ? and operation_revision = ?`,
          )
          .run(now, id, leaseOwner, operationRevision);
        if (reservation.changes !== 1)
          throw new JellyfinActivationOperationError("invalid_transition");
        return updated;
      })
      .immediate();
    transition(result);
    return this.read(id)!;
  }

  public markCreateOutcomeUncertain(id: string, now: number) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    text(id, ACTIVATION_ID);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations
         set state = 'manual_required', failure_code = 'create_outcome_uncertain',
             manual_required_at = max(created_at, ?), lease_owner = null,
             lease_expires_at = null, retry_count = retry_count + 1,
             revision = revision + 1, updated_at = max(updated_at, ?)
         where id = ? and state = 'create_dispatched'
           and created_id_recorded_at is null and retry_count < 8`,
      )
      .run(now, now, id);
    transition(result);
    return this.read(id)!;
  }

  public beginStageAttempt(input: {
    id: string;
    leaseOwner: string;
    now: number;
    state: "created" | "policy_pending";
  }) {
    if (!validTime(input.now)) throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    text(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations
         set retry_count = retry_count + 1, revision = revision + 1,
             updated_at = max(updated_at, ?)
         where id = ? and state = ? and lease_owner = ?
           and lease_expires_at >= ? and retry_count < 8`,
      )
      .run(input.now, input.id, input.state, input.leaseOwner, input.now);
    transition(result);
    return this.read(input.id)!;
  }

  public markCleanupUncertain(
    id: string,
    now: number,
    leaseOwner: string,
    operationRevision: number,
  ) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    text(id, ACTIVATION_ID);
    const result = this.#sqlite
      .transaction(() => {
        const reservationLease = this.#sqlite
          .prepare(
            `select operation_revision as operationRevision
             from jellyfin_activation_cleanup_reservations
             where operation_id = ? and state = 'dispatched'
               and lease_owner = ? and operation_revision = ?`,
          )
          .get(id, leaseOwner, operationRevision) as { operationRevision: number } | undefined;
        if (!reservationLease) throw new JellyfinActivationOperationError("invalid_transition");
        const current = this.#row(id);
        if (!current) throw new JellyfinActivationOperationError("operation_not_found");
        const updated = this.#sqlite
          .prepare(
            `update jellyfin_activation_operations
           set failure_code = 'cleanup_uncertain', lease_owner = null, lease_expires_at = null,
               updated_at = max(updated_at, ?), revision = revision + 1
           where id = ? and state = 'manual_required' and cleanup_eligible = 1
             and lease_owner = ? and revision = ?`,
          )
          .run(now, id, leaseOwner, current.revision);
        if (updated.changes !== 1) throw new JellyfinActivationOperationError("invalid_transition");
        const reservationUpdate = this.#sqlite
          .prepare(
            `update jellyfin_activation_cleanup_reservations
           set state = 'uncertain', updated_at = ?
           where operation_id = ? and state = 'dispatched'
             and lease_owner = ? and operation_revision = ?`,
          )
          .run(now, id, leaseOwner, operationRevision);
        if (reservationUpdate.changes !== 1)
          throw new JellyfinActivationOperationError("invalid_transition");
        return updated;
      })
      .immediate();
    transition(result);
    return this.read(id)!;
  }

  public reserveCleanup(input: {
    id: string;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
  }) {
    if (
      !validTime(input.now) ||
      !validTime(input.leaseExpiresAt) ||
      input.leaseExpiresAt <= input.now
    ) {
      throw new JellyfinActivationOperationError("invalid_input");
    }
    text(input.id, ACTIVATION_ID);
    text(input.leaseOwner);
    const result = this.#sqlite
      .transaction(() => {
        const current = this.#row(input.id);
        if (
          !current ||
          current.state !== "manual_required" ||
          current.cleanupEligible !== 1 ||
          current.encryptedStageArtifact === null ||
          current.leaseOwner !== null ||
          current.failureCode === "cleanup_uncertain"
        ) {
          throw new JellyfinActivationOperationError("invalid_transition");
        }
        const existing = this.#sqlite
          .prepare(
            "select state from jellyfin_activation_cleanup_reservations where operation_id = ?",
          )
          .get(input.id);
        if (existing) throw new JellyfinActivationOperationError("invalid_transition");
        const link = this.#sqlite
          .prepare(
            `select 1 from service_identity_links where user_id = ? and service = 'jellyfin'
         and connector_id = ? limit 1`,
          )
          .get(current.userId, current.connectorId);
        if (link) throw new JellyfinActivationOperationError("invalid_transition");
        const updated = this.#sqlite
          .prepare(
            `update jellyfin_activation_operations
         set lease_owner = ?, lease_expires_at = ?, cleanup_attempt_count = cleanup_attempt_count + 1,
             revision = revision + 1, updated_at = max(updated_at, ?)
         where id = ? and revision = ? and state = 'manual_required' and cleanup_eligible = 1
           and cleanup_attempt_count < 8`,
          )
          .run(input.leaseOwner, input.leaseExpiresAt, input.now, input.id, current.revision);
        if (updated.changes !== 1) throw new JellyfinActivationOperationError("invalid_transition");
        this.#sqlite
          .prepare(
            `insert into jellyfin_activation_cleanup_reservations
         (operation_id, operation_revision, lease_owner, lease_expires_at, attempt_count, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'dispatched', ?, ?)`,
          )
          .run(
            input.id,
            current.revision + 1,
            input.leaseOwner,
            input.leaseExpiresAt,
            current.cleanupAttemptCount + 1,
            input.now,
            input.now,
          );
        return updated;
      })
      .immediate();
    transition(result);
    return this.read(input.id)!;
  }

  public readCleanupReservation(operationId: string) {
    return this.#sqlite
      .prepare(
        `select operation_id as operationId, operation_revision as operationRevision,
              lease_owner as leaseOwner, lease_expires_at as leaseExpiresAt,
              attempt_count as attemptCount, state, created_at as createdAt, updated_at as updatedAt
       from jellyfin_activation_cleanup_reservations where operation_id = ?`,
      )
      .get(operationId) as
      | {
          attemptCount: number;
          leaseExpiresAt: number;
          leaseOwner: string;
          operationId: string;
          operationRevision: number;
          state: "confirmed" | "dispatched" | "uncertain";
        }
      | undefined;
  }

  public expireCleanupReservation(operationId: string, now: number) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    text(operationId, ACTIVATION_ID);
    this.#sqlite.transaction(() => {
      const reservation = this.#sqlite
        .prepare(
          `select lease_owner as leaseOwner, operation_revision as operationRevision
           from jellyfin_activation_cleanup_reservations
           where operation_id = ? and state = 'dispatched' and lease_expires_at < ?`,
        )
        .get(operationId, now) as { leaseOwner: string; operationRevision: number } | undefined;
      if (!reservation) return;
      const result = this.#sqlite
        .prepare(
          `update jellyfin_activation_cleanup_reservations set state = 'uncertain', updated_at = ?
           where operation_id = ? and state = 'dispatched' and lease_expires_at < ?
             and lease_owner = ? and operation_revision = ?`,
        )
        .run(now, operationId, now, reservation.leaseOwner, reservation.operationRevision);
      if (result.changes === 1) {
        const operation = this.#sqlite
          .prepare(
            `update jellyfin_activation_operations set failure_code = 'cleanup_uncertain', lease_owner = null,
             lease_expires_at = null, revision = revision + 1, updated_at = max(updated_at, ?)
             where id = ? and state = 'manual_required' and cleanup_eligible = 1
               and lease_owner = ? and revision = ?`,
          )
          .run(now, operationId, reservation.leaseOwner, reservation.operationRevision);
        if (operation.changes !== 1)
          throw new JellyfinActivationOperationError("invalid_transition");
      }
      return result;
    })();
  }

  public tombstone(id: string, now: number) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    text(id, ACTIVATION_ID);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set state = 'tombstoned', encrypted_stage_artifact = null, cleanup_eligible = 0, artifact_revision = artifact_revision + 1, lease_owner = null, lease_expires_at = null, tombstoned_at = ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state = 'manual_required' and cleanup_eligible = 0`,
      )
      .run(now, now, id);
    transition(result);
    return this.read(id)!;
  }

  public scrubForRestore(now: number) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set state = 'manual_required', encrypted_stage_artifact = null, cleanup_eligible = 0, artifact_revision = artifact_revision + 1, failure_code = 'restore_sanitized', lease_owner = null, lease_expires_at = null, manual_required_at = max(created_at, ?), revision = revision + 1, updated_at = max(updated_at, created_at, ?) where state not in ('manual_required','tombstoned')`,
      )
      .run(now, now);
  }

  public readCreatedIdArtifact(id: string) {
    text(id, ACTIVATION_ID);
    const row = this.#row(id);
    if (!row?.encryptedStageArtifact || row.cleanupEligible !== 1)
      throw new JellyfinActivationOperationError("artifact_not_found");
    try {
      const value = JSON.parse(
        this.#cipher.decrypt(
          row.encryptedStageArtifact,
          jellyfinActivationArtifactEncryptionContext(id, row.artifactRevision),
        ),
      ) as unknown;
      const createdId =
        value && typeof value === "object"
          ? (value as Record<string, unknown>).createdId
          : undefined;
      if (
        !value ||
        typeof value !== "object" ||
        typeof createdId !== "string" ||
        !CREATED_ID.test(createdId)
      )
        throw new Error("invalid artifact");
      return (value as { createdId: string }).createdId;
    } catch (error) {
      throw new JellyfinActivationOperationError("artifact_not_found", { cause: error });
    }
  }

  public readStageArtifact(id: string): JellyfinActivationStoredArtifact {
    text(id, ACTIVATION_ID);
    const row = this.#row(id);
    if (!row?.encryptedStageArtifact || row.cleanupEligible !== 1) {
      throw new JellyfinActivationOperationError("artifact_not_found");
    }
    try {
      const value = JSON.parse(
        this.#cipher.decrypt(
          row.encryptedStageArtifact,
          jellyfinActivationArtifactEncryptionContext(id, row.artifactRevision),
        ),
      ) as unknown;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).createdId !== "string" ||
        !CREATED_ID.test((value as Record<string, unknown>).createdId as string)
      ) {
        throw new Error("invalid artifact");
      }
      return Object.freeze(value as JellyfinActivationStoredArtifact);
    } catch (error) {
      throw new JellyfinActivationOperationError("artifact_not_found", { cause: error });
    }
  }

  #row(id: string) {
    return this.#sqlite.prepare(`${SELECT} where id = ?`).get(id) as ActivationRow | undefined;
  }

  #record(row: ActivationRow): JellyfinActivationOperation {
    if (
      !ACTIVATION_ID.test(row.id) ||
      ![
        "reserved",
        "create_dispatched",
        "created",
        "policy_pending",
        "auth_pending",
        "manual_required",
        "tombstoned",
      ].includes(row.state) ||
      row.createAttemptCount > 1 ||
      row.retryCount > 8 ||
      row.artifactRevision < 0 ||
      row.revision < 0
    )
      throw new JellyfinActivationOperationError("invalid_input");
    const record: JellyfinActivationOperation = {
      activationStatus: row.activationStatus,
      activationCompletedLinkId: row.activationCompletedLinkId,
      artifactRevision: row.artifactRevision,
      connectorConfigGeneration: row.connectorConfigGeneration,
      connectorId: row.connectorId,
      connectorInstanceGeneration: row.connectorInstanceGeneration,
      connectorInstanceIdentityHash: row.connectorInstanceIdentityHash,
      createAttemptCount: row.createAttemptCount,
      cleanupAttemptCount: row.cleanupAttemptCount,
      createDispatchedAt: row.createDispatchedAt,
      createdIdRecordedAt: row.createdIdRecordedAt,
      externalIdentityId: row.externalIdentityId,
      failureCode: parseFailureCode(row.failureCode),
      id: row.id,
      invitationId: row.invitationId,
      leaseExpiresAt: row.leaseExpiresAt,
      leaseOwner: row.leaseOwner,
      manualRequiredAt: row.manualRequiredAt,
      provisioningRevision: row.provisioningRevision,
      reservedAt: row.reservedAt,
      retryCount: row.retryCount,
      revision: row.revision,
      state: row.state,
      tombstonedAt: row.tombstonedAt,
      userId: row.userId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
    };
    Object.defineProperty(record, "toJSON", {
      value: () => {
        throw new TypeError("Jellyfin activation operations are internal-only");
      },
      enumerable: false,
    });
    return Object.freeze(record);
  }
}
