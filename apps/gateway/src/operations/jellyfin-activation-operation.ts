import type Database from "better-sqlite3";
import { EnvelopeCipher } from "../security/crypto.js";

const SAFE_INTEGER_MAXIMUM = 9_007_199_254_740_991;
const MAX_TIME = 8_640_000_000_000_000;
const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const ACTIVATION_ID = /^jellyfin_[A-Za-z0-9_-]{1,118}$/u;
const FAILURE_CODE = /^[a-z0-9_]{1,64}$/u;
const CREATED_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export type JellyfinActivationState =
  "reserved" | "create_dispatched" | "created_id_recorded" | "manual_required" | "tombstoned";

export type JellyfinActivationFailureCode =
  | "binding_mismatch"
  | "create_outcome_uncertain"
  | "invalid_artifact"
  | "restore_sanitized"
  | "restore_timeline_uncertain"
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
  readonly artifactRevision: number;
  readonly connectorConfigGeneration: number;
  readonly connectorId: string;
  readonly connectorInstanceGeneration: number;
  readonly connectorInstanceIdentityHash: string | null;
  readonly createAttemptCount: number;
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
}

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
  artifactRevision: number;
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  connectorInstanceIdentityHash: string | null;
  createAttemptCount: number;
  createDispatchedAt: number | null;
  createdAt: number;
  createdIdRecordedAt: number | null;
  encryptedStageArtifact: string | null;
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
  userId: string;
}

const SELECT = `select id, invitation_id as invitationId, user_id as userId,
 external_identity_id as externalIdentityId, connector_id as connectorId,
 connector_config_generation as connectorConfigGeneration,
 connector_instance_generation as connectorInstanceGeneration,
 connector_instance_identity_hash as connectorInstanceIdentityHash,
 provisioning_revision as provisioningRevision, state, revision,
 encrypted_stage_artifact as encryptedStageArtifact, artifact_revision as artifactRevision,
 lease_owner as leaseOwner, lease_expires_at as leaseExpiresAt,
 create_attempt_count as createAttemptCount, retry_count as retryCount,
 failure_code as failureCode, reserved_at as reservedAt,
 create_dispatched_at as createDispatchedAt, created_id_recorded_at as createdIdRecordedAt,
 manual_required_at as manualRequiredAt, tombstoned_at as tombstonedAt,
 created_at as createdAt, updated_at as updatedAt
 from jellyfin_activation_operations`;

function validTime(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
}

function validGeneration(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= SAFE_INTEGER_MAXIMUM;
}

function text(value: string, pattern = ID) {
  if (!pattern.test(value)) throw new JellyfinActivationOperationError("invalid_input");
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
        `update jellyfin_activation_operations set lease_owner = ?, lease_expires_at = ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and lease_owner = ? and lease_expires_at = ? and lease_expires_at < ? and state in ('reserved','create_dispatched','created_id_recorded')`,
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

  public dispatchCreate(input: { id: string; leaseOwner: string; now: number }) {
    if (!validTime(input.now)) throw new JellyfinActivationOperationError("invalid_input");
    text(input.id, ACTIVATION_ID);
    text(input.leaseOwner);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set state = 'create_dispatched', create_attempt_count = 1, create_dispatched_at = ?, lease_owner = null, lease_expires_at = null, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state = 'reserved' and create_attempt_count = 0 and lease_owner = ? and lease_expires_at >= ?`,
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
        JSON.stringify({ kind: "created_id", createdId: input.createdId }),
        jellyfinActivationArtifactEncryptionContext(input.id, artifactRevision),
      );
      const result = this.#sqlite
        .prepare(
          `update jellyfin_activation_operations set state = 'created_id_recorded', encrypted_stage_artifact = ?, artifact_revision = ?, created_id_recorded_at = ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state = 'create_dispatched' and revision = ?`,
        )
        .run(encrypted, artifactRevision, input.now, input.now, input.id, row.revision);
      transition(result);
      return this.read(input.id)!;
    })();
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
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set state = 'manual_required', encrypted_stage_artifact = null, artifact_revision = artifact_revision + 1, failure_code = ?, manual_required_at = ?, lease_owner = null, lease_expires_at = null, retry_count = retry_count + ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state not in ('manual_required','tombstoned') and retry_count + ? <= 8`,
      )
      .run(
        input.failureCode,
        input.now,
        input.incrementRetry === false ? 0 : 1,
        input.now,
        input.id,
        input.incrementRetry === false ? 0 : 1,
      );
    transition(result);
    return this.read(input.id)!;
  }

  public tombstone(id: string, now: number) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    text(id, ACTIVATION_ID);
    const result = this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set state = 'tombstoned', encrypted_stage_artifact = null, artifact_revision = artifact_revision + 1, lease_owner = null, lease_expires_at = null, tombstoned_at = ?, revision = revision + 1, updated_at = max(updated_at, ?) where id = ? and state in ('manual_required','created_id_recorded')`,
      )
      .run(now, now, id);
    transition(result);
    return this.read(id)!;
  }

  public scrubForRestore(now: number) {
    if (!validTime(now)) throw new JellyfinActivationOperationError("invalid_input");
    this.#sqlite
      .prepare(
        `update jellyfin_activation_operations set state = 'manual_required', encrypted_stage_artifact = null, artifact_revision = artifact_revision + 1, failure_code = 'restore_sanitized', lease_owner = null, lease_expires_at = null, manual_required_at = max(created_at, ?), revision = revision + 1, updated_at = max(updated_at, created_at, ?) where state not in ('manual_required','tombstoned')`,
      )
      .run(now, now);
  }

  public readCreatedIdArtifact(id: string) {
    text(id, ACTIVATION_ID);
    const row = this.#row(id);
    if (!row?.encryptedStageArtifact)
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
        (value as Record<string, unknown>).kind !== "created_id" ||
        typeof createdId !== "string" ||
        !CREATED_ID.test(createdId)
      )
        throw new Error("invalid artifact");
      return (value as { createdId: string }).createdId;
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
        "created_id_recorded",
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
      ...row,
      failureCode: parseFailureCode(row.failureCode),
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
