import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { clientNetworkGroup } from "../../security/client-network.js";
import { privacyHash } from "../../security/crypto.js";
import { OIDC_IDENTITY_DENIAL_REASONS, type OidcIdentityDenialReason } from "./identity-service.js";

export const OIDC_FAILURE_AUDIT_EVENT_TYPE = "auth.oidc.failure";
export const OIDC_FAILURE_AUDIT_SCOPE = "auth.oidc.failure:v1";
export const OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW = 128;
export const OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT = 4_096;
export const OIDC_FAILURE_AUDIT_WINDOW_MS = 15 * 60 * 1_000;

const MAX_GENERATION = 9_007_199_254_740_990;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_BUCKETS_PER_GENERATION = OIDC_FAILURE_AUDIT_MAX_ROWS_PER_WINDOW - 1;
const MAX_IP_ADDRESS_CHARACTERS = 256;
const MAX_REQUEST_ID_CHARACTERS = 128;
const MAX_USER_AGENT_CHARACTERS = 2_048;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type OidcFailureAuditReason =
  | "authorization_denied"
  | "callback_validation_failed"
  | "claims_invalid"
  | "identity_rejected"
  | "internal_failure"
  | "invalid_request"
  | "provider_unavailable"
  | "session_limit_reached"
  | "token_exchange_failed";

export interface OidcFailureAuditContext {
  ipAddress?: string | undefined;
  requestId?: string | undefined;
  userAgent?: string | undefined;
}

export type OidcFailureAuditInput = OidcFailureAuditContext &
  (
    | {
        identityReason: OidcIdentityDenialReason;
        outcome: "denied" | "failure";
        reason: "identity_rejected";
      }
    | {
        identityReason?: never;
        outcome: "denied" | "failure";
        reason: Exclude<OidcFailureAuditReason, "identity_rejected">;
      }
  );

export interface OidcFailureAuditDependencies {
  clock?: () => Date;
  createId?: () => string;
}

export interface OidcFailureAuditMetrics {
  bucketCount: number;
  saturated: boolean;
  suppressedCount: number;
  window: number | null;
}

export type OidcFailureAuditDisposition = "coalesced" | "recorded" | "saturated";

interface NormalizedAuditContext {
  clientGroup: string;
  ipHash: string | null;
  requestId: string | null;
  userAgentHash: string | null;
}

interface AuditInputSnapshot {
  identityReason: unknown;
  ipAddress: unknown;
  outcome: unknown;
  reason: unknown;
  requestId: unknown;
  userAgent: unknown;
}

interface AuditBudgetState extends Record<string, unknown> {
  clockWatermarkAt: number;
  generation: number;
  rollbackStartedAt: number | null;
  saturated: 0 | 1;
  scope: typeof OIDC_FAILURE_AUDIT_SCOPE;
  suppressedCount: number;
  windowStartedAt: number;
}

interface AuditBudgetEntry {
  bucketHash: string;
  createdAt: number;
  generation: number;
  scope: typeof OIDC_FAILURE_AUDIT_SCOPE;
  slot: number;
}

interface AuditBudgetSnapshot {
  entries: AuditBudgetEntry[];
  state: AuditBudgetState;
}

interface SaturatedWindowMemory {
  clockWatermarkAt: number;
  generation: number;
  rollbackStartedAt: number | null;
  suppressedCount: number;
  windowStartedAt: number;
}

interface CappedDuplicateWindowMemory extends SaturatedWindowMemory {
  bucketHashes: Set<string>;
}

interface AuditRecordResult {
  cappedDuplicateWindow?: CappedDuplicateWindowMemory;
  disposition: OidcFailureAuditDisposition;
  saturatedWindow?: SaturatedWindowMemory;
}

const allowedReasons = new Set<OidcFailureAuditReason>([
  "authorization_denied",
  "callback_validation_failed",
  "claims_invalid",
  "identity_rejected",
  "internal_failure",
  "invalid_request",
  "provider_unavailable",
  "session_limit_reached",
  "token_exchange_failed",
]);
const allowedIdentityReasons = new Set<OidcIdentityDenialReason>(OIDC_IDENTITY_DENIAL_REASONS);

function boundedPrivateContext(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, maximum);
}

function canonicalRequestId(value: unknown) {
  return typeof value === "string" &&
    value.length <= MAX_REQUEST_ID_CHARACTERS &&
    SAFE_IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

function currentTime(clock: () => Date) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMESTAMP) {
    throw new TypeError("OIDC failure auditing requires a valid clock value.");
  }
  return milliseconds;
}

function failureBucketHash(
  privacyKey: Buffer,
  generation: number,
  reason: OidcFailureAuditReason,
  identityReason: OidcIdentityDenialReason | null,
  clientGroup: string,
) {
  const reasonBucket = identityReason === null ? reason : `${reason}\0${identityReason}`;
  const bucketHash = privacyHash(
    "oidc_failure_audit_bucket",
    `${generation}\0${reasonBucket}\0${clientGroup}`,
    privacyKey,
  );
  if (!HASH_PATTERN.test(bucketHash)) {
    throw new Error("OIDC failure audit bucket is invalid.");
  }
  return bucketHash;
}

function validReason(value: unknown): value is OidcFailureAuditReason {
  return typeof value === "string" && allowedReasons.has(value as OidcFailureAuditReason);
}

function validIdentityReason(value: unknown): value is OidcIdentityDenialReason {
  return typeof value === "string" && allowedIdentityReasons.has(value as OidcIdentityDenialReason);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function stateIsValid(row: Record<string, unknown>): row is AuditBudgetState {
  return (
    row.scope === OIDC_FAILURE_AUDIT_SCOPE &&
    validInteger(row.generation, 1, MAX_GENERATION) &&
    validInteger(row.windowStartedAt, 0, MAX_TIMESTAMP) &&
    validInteger(row.clockWatermarkAt, 0, MAX_TIMESTAMP) &&
    row.windowStartedAt <= row.clockWatermarkAt &&
    (row.rollbackStartedAt === null ||
      (validInteger(row.rollbackStartedAt, 0, MAX_TIMESTAMP) &&
        row.rollbackStartedAt <= row.clockWatermarkAt)) &&
    (row.saturated === 0 || row.saturated === 1) &&
    validInteger(row.suppressedCount, 0, OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT)
  );
}

export class OidcFailureAuditService {
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #privacyKey: Buffer;
  #cappedDuplicateWindow: CappedDuplicateWindowMemory | undefined;
  #saturatedWindow: SaturatedWindowMemory | undefined;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: OidcFailureAuditDependencies = {},
  ) {
    if (config.encryptionKey.length !== 32) {
      throw new TypeError("OIDC failure auditing requires a 32-byte privacy key.");
    }
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#privacyKey = Buffer.from(config.encryptionKey);
  }

  public record(input: OidcFailureAuditInput): OidcFailureAuditDisposition {
    if (!input || typeof input !== "object") {
      throw new TypeError("OIDC failure reason is invalid.");
    }
    let snapshot: AuditInputSnapshot;
    try {
      snapshot = {
        identityReason: input.identityReason,
        ipAddress: input.ipAddress,
        outcome: input.outcome,
        reason: input.reason,
        requestId: input.requestId,
        userAgent: input.userAgent,
      };
    } catch {
      throw new TypeError("OIDC failure audit input is invalid.");
    }
    const { identityReason, outcome, reason } = snapshot;
    if (!validReason(reason)) {
      throw new TypeError("OIDC failure reason is invalid.");
    }
    if (outcome !== "denied" && outcome !== "failure") {
      throw new TypeError("OIDC failure outcome is invalid.");
    }
    if (
      (reason === "identity_rejected" && !validIdentityReason(identityReason)) ||
      (reason !== "identity_rejected" && identityReason !== undefined)
    ) {
      throw new TypeError("OIDC identity denial reason is invalid.");
    }
    const normalizedIdentityReason =
      reason === "identity_rejected" ? (identityReason as OidcIdentityDenialReason) : null;

    const now = currentTime(this.#clock);
    if (this.#suppressFromSaturatedMemory(now)) return "saturated";
    const observedSaturatedWindow = this.#saturatedWindow;
    const context = this.#normalizeContext(snapshot);
    const rememberedDuplicateWindow = this.#cappedDuplicateWindow;
    if (rememberedDuplicateWindow) {
      const rememberedBucketHash = failureBucketHash(
        this.#privacyKey,
        rememberedDuplicateWindow.generation,
        reason,
        normalizedIdentityReason,
        context.clientGroup,
      );
      if (this.#suppressFromCappedDuplicateMemory(now, rememberedBucketHash)) {
        return "coalesced";
      }
    }
    const observedDuplicateWindow = this.#cappedDuplicateWindow;
    const transaction = this.#database.sqlite.transaction((): AuditRecordResult => {
      this.#ensureScope(now);
      let snapshot = this.#readSnapshot();
      snapshot = this.#reconcileObservedSaturatedRollback(snapshot, now, observedSaturatedWindow);
      snapshot = this.#reconcileObservedCappedDuplicateRollback(
        snapshot,
        now,
        observedDuplicateWindow,
      );
      let saturatedWindow = this.#saturatedWindowFromSnapshot(
        snapshot,
        now,
        observedSaturatedWindow,
        true,
      );
      if (saturatedWindow) {
        return { disposition: "saturated", saturatedWindow } satisfies AuditRecordResult;
      }
      let bucketHash = failureBucketHash(
        this.#privacyKey,
        snapshot.state.generation,
        reason,
        normalizedIdentityReason,
        context.clientGroup,
      );
      let cappedDuplicateWindow = this.#cappedDuplicateWindowFromSnapshot(
        snapshot,
        now,
        observedDuplicateWindow,
        bucketHash,
      );
      if (cappedDuplicateWindow) {
        return {
          cappedDuplicateWindow,
          disposition: "coalesced",
        } satisfies AuditRecordResult;
      }
      snapshot = this.#transitionClock(snapshot, now);
      saturatedWindow = this.#saturatedWindowFromSnapshot(
        snapshot,
        now,
        observedSaturatedWindow,
        true,
      );
      if (saturatedWindow) {
        return { disposition: "saturated", saturatedWindow } satisfies AuditRecordResult;
      }
      bucketHash = failureBucketHash(
        this.#privacyKey,
        snapshot.state.generation,
        reason,
        normalizedIdentityReason,
        context.clientGroup,
      );
      cappedDuplicateWindow = this.#cappedDuplicateWindowFromSnapshot(
        snapshot,
        now,
        observedDuplicateWindow,
        bucketHash,
      );
      if (cappedDuplicateWindow) {
        return {
          cappedDuplicateWindow,
          disposition: "coalesced",
        } satisfies AuditRecordResult;
      }

      if (snapshot.entries.some((entry) => entry.bucketHash === bucketHash)) {
        if (snapshot.state.suppressedCount < OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT) {
          this.#incrementSuppressed(snapshot.state.generation);
        }
        const suppressedCount = Math.min(
          snapshot.state.suppressedCount + 1,
          OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
        );
        cappedDuplicateWindow = this.#cappedDuplicateWindowFromSnapshot(
          { entries: snapshot.entries, state: { ...snapshot.state, suppressedCount } },
          now,
          observedDuplicateWindow,
          bucketHash,
        );
        return {
          ...(cappedDuplicateWindow ? { cappedDuplicateWindow } : {}),
          disposition: "coalesced",
        } satisfies AuditRecordResult;
      }
      if (snapshot.entries.length < MAX_BUCKETS_PER_GENERATION) {
        const occupiedSlots = new Set(snapshot.entries.map(({ slot }) => slot));
        const slot = Array.from({ length: MAX_BUCKETS_PER_GENERATION }, (_, index) => index).find(
          (candidate) => !occupiedSlots.has(candidate),
        );
        if (slot === undefined) throw new Error("OIDC failure audit budget state is invalid.");
        this.#insertBudgetEntry(snapshot.state.generation, slot, bucketHash, now);
        this.#insertAudit({
          bucketHash,
          context,
          identityReason: normalizedIdentityReason,
          outcome,
          reason,
          now,
          generation: snapshot.state.generation,
        });
        return { disposition: "recorded" } satisfies AuditRecordResult;
      }

      this.#insertSaturationAudit(now, snapshot.state.generation);
      this.#markSaturated(snapshot.state.generation);
      const saturatedState: AuditBudgetSnapshot = {
        entries: snapshot.entries,
        state: {
          ...snapshot.state,
          saturated: 1,
          suppressedCount: Math.min(
            snapshot.state.suppressedCount + 1,
            OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
          ),
        },
      };
      saturatedWindow = this.#saturatedWindowFromSnapshot(saturatedState, now, undefined, false);
      if (!saturatedWindow) {
        throw new Error("OIDC failure audit saturation state is invalid.");
      }
      return { disposition: "saturated", saturatedWindow } satisfies AuditRecordResult;
    });

    const result = transaction.immediate();
    this.#cappedDuplicateWindow = result.cappedDuplicateWindow;
    this.#saturatedWindow = result.saturatedWindow;
    return result.disposition;
  }

  public get metrics(): Readonly<OidcFailureAuditMetrics> {
    const transaction = this.#database.sqlite.transaction(() => {
      const snapshot = this.#readSnapshot({ allowMissing: true });
      if (!snapshot) {
        return {
          bucketCount: 0,
          saturated: false,
          suppressedCount: 0,
          window: null,
        };
      }
      const suppressedCount =
        snapshot.state.saturated === 1 &&
        this.#saturatedWindow?.generation === snapshot.state.generation
          ? Math.max(snapshot.state.suppressedCount, this.#saturatedWindow.suppressedCount)
          : snapshot.state.suppressedCount;
      return {
        bucketCount: snapshot.entries.length,
        saturated: snapshot.state.saturated === 1,
        suppressedCount,
        window: snapshot.state.generation,
      };
    });
    return Object.freeze(transaction.deferred());
  }

  #suppressFromCappedDuplicateMemory(now: number, bucketHash: string) {
    const remembered = this.#cappedDuplicateWindow;
    if (!remembered?.bucketHashes.has(bucketHash)) return false;

    if (remembered.rollbackStartedAt === null) {
      if (
        now < remembered.clockWatermarkAt ||
        now - remembered.windowStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS
      ) {
        return false;
      }
      remembered.clockWatermarkAt = now;
    } else if (
      now >= remembered.clockWatermarkAt ||
      now < remembered.rollbackStartedAt ||
      now - remembered.rollbackStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS
    ) {
      return false;
    }

    return true;
  }

  #cappedDuplicateWindowFromSnapshot(
    snapshot: AuditBudgetSnapshot,
    now: number,
    observed: CappedDuplicateWindowMemory | undefined,
    bucketHash: string,
  ): CappedDuplicateWindowMemory | undefined {
    const { state } = snapshot;
    if (
      state.saturated !== 0 ||
      state.suppressedCount !== OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT ||
      !snapshot.entries.some((entry) => entry.bucketHash === bucketHash)
    ) {
      return undefined;
    }

    let clockWatermarkAt = state.clockWatermarkAt;
    if (state.rollbackStartedAt === null) {
      if (now < clockWatermarkAt || now - state.windowStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS) {
        return undefined;
      }
      clockWatermarkAt = now;
    } else if (
      now >= clockWatermarkAt ||
      now < state.rollbackStartedAt ||
      now - state.rollbackStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS
    ) {
      return undefined;
    }

    const bucketHashes =
      observed?.generation === state.generation
        ? new Set(observed.bucketHashes)
        : new Set<string>();
    bucketHashes.add(bucketHash);
    return {
      bucketHashes,
      clockWatermarkAt,
      generation: state.generation,
      rollbackStartedAt: state.rollbackStartedAt,
      suppressedCount: OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
      windowStartedAt: state.windowStartedAt,
    };
  }

  #reconcileObservedCappedDuplicateRollback(
    snapshot: AuditBudgetSnapshot,
    now: number,
    observed: CappedDuplicateWindowMemory | undefined,
  ) {
    const { state } = snapshot;
    if (
      !observed ||
      state.saturated !== 0 ||
      state.suppressedCount !== OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT ||
      observed.generation !== state.generation ||
      observed.clockWatermarkAt <= state.clockWatermarkAt ||
      now >= observed.clockWatermarkAt ||
      state.rollbackStartedAt !== null
    ) {
      return snapshot;
    }

    this.#updateScope(
      `update audit_budget_scopes
       set clock_watermark_at = @clockWatermarkAt
       where scope = @scope and generation = @generation`,
      { clockWatermarkAt: observed.clockWatermarkAt, generation: state.generation },
    );
    this.#updateScope(
      `update audit_budget_scopes
       set rollback_started_at = @now
       where scope = @scope and generation = @generation`,
      { generation: state.generation, now },
    );
    return this.#readSnapshot();
  }

  #suppressFromSaturatedMemory(now: number) {
    const remembered = this.#saturatedWindow;
    if (!remembered) return false;

    if (remembered.rollbackStartedAt === null) {
      if (
        now < remembered.clockWatermarkAt ||
        now - remembered.windowStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS
      ) {
        return false;
      }
      remembered.clockWatermarkAt = now;
    } else if (
      now >= remembered.clockWatermarkAt ||
      now < remembered.rollbackStartedAt ||
      now - remembered.rollbackStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS
    ) {
      return false;
    }

    remembered.suppressedCount = Math.min(
      remembered.suppressedCount + 1,
      OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
    );
    return true;
  }

  #saturatedWindowFromSnapshot(
    snapshot: AuditBudgetSnapshot,
    now: number,
    observed: SaturatedWindowMemory | undefined,
    countCurrentAttempt: boolean,
  ): SaturatedWindowMemory | undefined {
    const { state } = snapshot;
    if (state.saturated !== 1) return undefined;

    let clockWatermarkAt = state.clockWatermarkAt;
    if (state.rollbackStartedAt === null) {
      if (now < clockWatermarkAt || now - state.windowStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS) {
        return undefined;
      }
      clockWatermarkAt = now;
    } else if (
      now >= clockWatermarkAt ||
      now < state.rollbackStartedAt ||
      now - state.rollbackStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS
    ) {
      return undefined;
    }

    const observedSuppressedCount =
      observed?.generation === state.generation ? observed.suppressedCount : 0;
    return {
      clockWatermarkAt,
      generation: state.generation,
      rollbackStartedAt: state.rollbackStartedAt,
      suppressedCount: Math.min(
        Math.max(state.suppressedCount, observedSuppressedCount) + (countCurrentAttempt ? 1 : 0),
        OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT,
      ),
      windowStartedAt: state.windowStartedAt,
    };
  }

  #reconcileObservedSaturatedRollback(
    snapshot: AuditBudgetSnapshot,
    now: number,
    observed: SaturatedWindowMemory | undefined,
  ) {
    const { state } = snapshot;
    if (
      !observed ||
      state.saturated !== 1 ||
      observed.generation !== state.generation ||
      observed.clockWatermarkAt <= state.clockWatermarkAt ||
      now >= observed.clockWatermarkAt ||
      state.rollbackStartedAt !== null
    ) {
      return snapshot;
    }

    this.#updateScope(
      `update audit_budget_scopes
       set clock_watermark_at = @clockWatermarkAt
       where scope = @scope and generation = @generation`,
      { clockWatermarkAt: observed.clockWatermarkAt, generation: state.generation },
    );
    this.#updateScope(
      `update audit_budget_scopes
       set rollback_started_at = @now
       where scope = @scope and generation = @generation`,
      { generation: state.generation, now },
    );
    return this.#readSnapshot();
  }

  #ensureScope(now: number) {
    this.#database.sqlite
      .prepare(
        `insert into audit_budget_scopes (
           scope, generation, window_started_at, clock_watermark_at,
           rollback_started_at, saturated, suppressed_count
         ) values (
           @scope, 1, @now, @now, null, 0, 0
         )
         on conflict(scope) do nothing`,
      )
      .run({ now, scope: OIDC_FAILURE_AUDIT_SCOPE });
  }

  #readSnapshot(options: { allowMissing: true }): AuditBudgetSnapshot | null;
  #readSnapshot(options?: { allowMissing?: false }): AuditBudgetSnapshot;
  #readSnapshot(options: { allowMissing?: boolean } = {}): AuditBudgetSnapshot | null {
    const row = this.#database.sqlite
      .prepare(
        `select
           scope,
           generation,
           window_started_at as windowStartedAt,
           clock_watermark_at as clockWatermarkAt,
           rollback_started_at as rollbackStartedAt,
           saturated,
           suppressed_count as suppressedCount
         from audit_budget_scopes
         where scope = @scope`,
      )
      .get({ scope: OIDC_FAILURE_AUDIT_SCOPE }) as Record<string, unknown> | undefined;

    if (!row) {
      const orphan = this.#database.sqlite
        .prepare("select 1 from audit_budget_entries where scope = @scope limit 1")
        .get({ scope: OIDC_FAILURE_AUDIT_SCOPE });
      if (orphan) throw new Error("OIDC failure audit budget state is invalid.");
      if (options.allowMissing) return null;
      throw new Error("OIDC failure audit budget state is missing.");
    }
    if (!stateIsValid(row)) throw new Error("OIDC failure audit budget state is invalid.");

    const rawEntries = this.#database.sqlite
      .prepare(
        `select
           scope,
           generation,
           slot,
           bucket_hash as bucketHash,
           created_at as createdAt
         from audit_budget_entries
         where scope = @scope
         order by generation, slot
         limit 128`,
      )
      .all({ scope: OIDC_FAILURE_AUDIT_SCOPE }) as Record<string, unknown>[];
    if (rawEntries.length > MAX_BUCKETS_PER_GENERATION) {
      throw new Error("OIDC failure audit budget state is invalid.");
    }

    const bucketHashes = new Set<string>();
    let previousSlot = -1;
    const entries = rawEntries.map((entry) => {
      if (
        entry.scope !== OIDC_FAILURE_AUDIT_SCOPE ||
        entry.generation !== row.generation ||
        !validInteger(entry.slot, 0, MAX_BUCKETS_PER_GENERATION - 1) ||
        entry.slot <= previousSlot ||
        typeof entry.bucketHash !== "string" ||
        !HASH_PATTERN.test(entry.bucketHash) ||
        bucketHashes.has(entry.bucketHash) ||
        !validInteger(entry.createdAt, 0, MAX_TIMESTAMP)
      ) {
        throw new Error("OIDC failure audit budget state is invalid.");
      }
      previousSlot = entry.slot;
      bucketHashes.add(entry.bucketHash);
      return entry as unknown as AuditBudgetEntry;
    });
    if (row.saturated === 1 && entries.length !== MAX_BUCKETS_PER_GENERATION) {
      throw new Error("OIDC failure audit budget state is invalid.");
    }
    return { entries, state: row };
  }

  #transitionClock(snapshot: AuditBudgetSnapshot, now: number) {
    const { state } = snapshot;
    if (state.rollbackStartedAt === null) {
      if (now >= state.clockWatermarkAt) {
        if (now - state.windowStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS) {
          return this.#advanceGeneration(snapshot, now, false);
        }
        if (now > state.clockWatermarkAt) {
          this.#updateScope(
            `update audit_budget_scopes
             set clock_watermark_at = @now
             where scope = @scope and generation = @generation`,
            { generation: state.generation, now },
          );
          return this.#readSnapshot();
        }
        return snapshot;
      }

      this.#updateScope(
        `update audit_budget_scopes
         set rollback_started_at = @now
         where scope = @scope and generation = @generation`,
        { generation: state.generation, now },
      );
      return this.#readSnapshot();
    }

    if (now >= state.clockWatermarkAt) {
      this.#updateScope(
        `update audit_budget_scopes
         set window_started_at = @now,
             clock_watermark_at = @now,
             rollback_started_at = null
         where scope = @scope and generation = @generation`,
        { generation: state.generation, now },
      );
      return this.#readSnapshot();
    }
    if (now < state.rollbackStartedAt) {
      this.#updateScope(
        `update audit_budget_scopes
         set rollback_started_at = @now
         where scope = @scope and generation = @generation`,
        { generation: state.generation, now },
      );
      return this.#readSnapshot();
    }
    if (now - state.rollbackStartedAt >= OIDC_FAILURE_AUDIT_WINDOW_MS) {
      return this.#advanceGeneration(snapshot, now, true);
    }
    return snapshot;
  }

  #advanceGeneration(snapshot: AuditBudgetSnapshot, now: number, rollback: boolean) {
    const { state } = snapshot;
    if (state.generation >= MAX_GENERATION) {
      throw new Error("OIDC failure audit generation is exhausted.");
    }
    const generation = state.generation + 1;
    const result = this.#database.sqlite
      .prepare(
        `update audit_budget_scopes
         set generation = @nextGeneration,
             window_started_at = @now,
             clock_watermark_at = @clockWatermarkAt,
             rollback_started_at = @rollbackStartedAt,
             saturated = 0,
             suppressed_count = 0
         where scope = @scope and generation = @generation`,
      )
      .run({
        clockWatermarkAt: rollback ? state.clockWatermarkAt : now,
        generation: state.generation,
        nextGeneration: generation,
        now,
        rollbackStartedAt: rollback ? now : null,
        scope: OIDC_FAILURE_AUDIT_SCOPE,
      });
    if (result.changes !== 1)
      throw new Error("OIDC failure audit budget state changed unexpectedly.");

    const deleted = this.#database.sqlite
      .prepare(
        `delete from audit_budget_entries
         where scope = @scope and generation = @generation`,
      )
      .run({ generation: state.generation, scope: OIDC_FAILURE_AUDIT_SCOPE });
    if (deleted.changes !== snapshot.entries.length) {
      throw new Error("OIDC failure audit budget cleanup was incomplete.");
    }
    return this.#readSnapshot();
  }

  #updateScope(statement: string, values: Record<string, number>) {
    const result = this.#database.sqlite.prepare(statement).run({
      ...values,
      scope: OIDC_FAILURE_AUDIT_SCOPE,
    });
    if (result.changes !== 1)
      throw new Error("OIDC failure audit budget state changed unexpectedly.");
  }

  #incrementSuppressed(generation: number) {
    this.#updateScope(
      `update audit_budget_scopes
       set suppressed_count = min(suppressed_count + 1, ${OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT})
       where scope = @scope and generation = @generation`,
      { generation },
    );
  }

  #markSaturated(generation: number) {
    this.#updateScope(
      `update audit_budget_scopes
       set saturated = 1,
           suppressed_count = min(suppressed_count + 1, ${OIDC_FAILURE_AUDIT_MAX_SUPPRESSED_COUNT})
       where scope = @scope and generation = @generation and saturated = 0`,
      { generation },
    );
  }

  #insertBudgetEntry(generation: number, slot: number, bucketHash: string, now: number) {
    this.#database.sqlite
      .prepare(
        `insert into audit_budget_entries (
           scope, generation, slot, bucket_hash, created_at
         ) values (
           @scope, @generation, @slot, @bucketHash, @now
         )`,
      )
      .run({
        bucketHash,
        generation,
        now,
        scope: OIDC_FAILURE_AUDIT_SCOPE,
        slot,
      });
  }

  #insertAudit(options: {
    bucketHash: string;
    context: NormalizedAuditContext;
    generation: number;
    identityReason: OidcIdentityDenialReason | null;
    now: number;
    outcome: "denied" | "failure";
    reason: OidcFailureAuditReason;
  }) {
    this.#insertAuditRow({
      context: options.context,
      metadataJson: JSON.stringify({
        bucketHash: options.bucketHash,
        budgetGeneration: options.generation,
        ...(options.identityReason === null ? {} : { identityReason: options.identityReason }),
        reason: options.reason,
        userAgentHash: options.context.userAgentHash,
      }),
      now: options.now,
      outcome: options.outcome,
    });
  }

  #insertSaturationAudit(now: number, generation: number) {
    this.#insertAuditRow({
      context: {
        clientGroup: "unattributed-client",
        ipHash: null,
        requestId: null,
        userAgentHash: null,
      },
      metadataJson: JSON.stringify({
        budgetGeneration: generation,
        reason: "audit_saturated",
      }),
      now,
      outcome: "failure",
    });
  }

  #insertAuditRow(options: {
    context: NormalizedAuditContext;
    metadataJson: string;
    now: number;
    outcome: "denied" | "failure";
  }) {
    const id = this.#createId();
    if (typeof id !== "string" || !SAFE_IDENTIFIER_PATTERN.test(id)) {
      throw new TypeError("OIDC failure audit identifier is invalid.");
    }
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, event_type, outcome, target_type, request_id, metadata_json, ip_hash, created_at
         ) values (
           @id, @eventType, @outcome, 'oidc_authentication', @requestId,
           @metadataJson, @ipHash, @createdAt
         )`,
      )
      .run({
        createdAt: options.now,
        eventType: OIDC_FAILURE_AUDIT_EVENT_TYPE,
        id,
        ipHash: options.context.ipHash,
        metadataJson: options.metadataJson,
        outcome: options.outcome,
        requestId: options.context.requestId,
      });
  }

  #normalizeContext(context: AuditInputSnapshot): NormalizedAuditContext {
    const ipAddress = boundedPrivateContext(context.ipAddress, MAX_IP_ADDRESS_CHARACTERS);
    const userAgent = boundedPrivateContext(context.userAgent, MAX_USER_AGENT_CHARACTERS);
    return {
      clientGroup: clientNetworkGroup(ipAddress),
      ipHash: ipAddress
        ? privacyHash("oidc_failure_audit_ip_address", ipAddress, this.#privacyKey)
        : null,
      requestId: canonicalRequestId(context.requestId),
      userAgentHash: userAgent
        ? privacyHash("oidc_failure_audit_user_agent", userAgent, this.#privacyKey)
        : null,
    };
  }
}
