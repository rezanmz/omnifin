import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { privacyHash } from "../../security/crypto.js";

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
  | "token_exchange_failed";

export interface OidcFailureAuditContext {
  ipAddress?: string | undefined;
  requestId?: string | undefined;
  userAgent?: string | undefined;
}

export interface OidcFailureAuditInput extends OidcFailureAuditContext {
  outcome: "denied" | "failure";
  reason: OidcFailureAuditReason;
}

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

const allowedReasons = new Set<OidcFailureAuditReason>([
  "authorization_denied",
  "callback_validation_failed",
  "claims_invalid",
  "identity_rejected",
  "internal_failure",
  "invalid_request",
  "provider_unavailable",
  "token_exchange_failed",
]);

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

function ipv4TailHextets(token: string) {
  const octets = token.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return [];
  }
  return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
}

function ipv6Hextets(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  const halves = normalized.split("::");
  if (halves.length > 2) return [];
  const parseHalf = (half: string) => {
    if (!half) return [];
    const values: number[] = [];
    for (const token of half.split(":")) {
      if (token.includes(".")) values.push(...ipv4TailHextets(token));
      else values.push(Number.parseInt(token, 16));
    }
    return values;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0) return [];
  const values = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  return values.length === 8 && values.every((value) => value >= 0 && value <= 0xffff)
    ? values
    : [];
}

function clientGroup(ipAddress: string | undefined) {
  if (!ipAddress) return "unattributed-client";
  const version = isIP(ipAddress);
  if (version === 4) return ipAddress.split(".").map(Number).join(".");
  if (version !== 6) return "unattributed-client";
  const values = ipv6Hextets(ipAddress);
  if (values.length !== 8) return "unattributed-client";
  if (values.slice(0, 5).every((value) => value === 0) && values[5] === 0xffff) {
    return [values[6]! >> 8, values[6]! & 0xff, values[7]! >> 8, values[7]! & 0xff].join(".");
  }
  return `${values
    .slice(0, 4)
    .map((value) => value.toString(16).padStart(4, "0"))
    .join(":")}::/64`;
}

function validReason(value: unknown): value is OidcFailureAuditReason {
  return typeof value === "string" && allowedReasons.has(value as OidcFailureAuditReason);
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
        ipAddress: input.ipAddress,
        outcome: input.outcome,
        reason: input.reason,
        requestId: input.requestId,
        userAgent: input.userAgent,
      };
    } catch {
      throw new TypeError("OIDC failure audit input is invalid.");
    }
    const { outcome, reason } = snapshot;
    if (!validReason(reason)) {
      throw new TypeError("OIDC failure reason is invalid.");
    }
    if (outcome !== "denied" && outcome !== "failure") {
      throw new TypeError("OIDC failure outcome is invalid.");
    }

    const now = currentTime(this.#clock);
    const context = this.#normalizeContext(snapshot);
    const transaction = this.#database.sqlite.transaction(() => {
      this.#ensureScope(now);
      let snapshot = this.#readSnapshot();
      snapshot = this.#transitionClock(snapshot, now);

      const bucketHash = privacyHash(
        "oidc_failure_audit_bucket",
        `${snapshot.state.generation}\0${reason}\0${context.clientGroup}`,
        this.#privacyKey,
      );
      if (!HASH_PATTERN.test(bucketHash)) {
        throw new Error("OIDC failure audit bucket is invalid.");
      }

      if (snapshot.entries.some((entry) => entry.bucketHash === bucketHash)) {
        this.#incrementSuppressed(snapshot.state.generation);
        return "coalesced" as const;
      }
      if (snapshot.state.saturated === 1) {
        this.#incrementSuppressed(snapshot.state.generation);
        return "saturated" as const;
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
          outcome,
          reason,
          now,
          generation: snapshot.state.generation,
        });
        return "recorded" as const;
      }

      this.#insertSaturationAudit(now, snapshot.state.generation);
      this.#markSaturated(snapshot.state.generation);
      return "saturated" as const;
    });

    return transaction.immediate();
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
      return {
        bucketCount: snapshot.entries.length,
        saturated: snapshot.state.saturated === 1,
        suppressedCount: snapshot.state.suppressedCount,
        window: snapshot.state.generation,
      };
    });
    return Object.freeze(transaction.deferred());
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
    now: number;
    outcome: "denied" | "failure";
    reason: OidcFailureAuditReason;
  }) {
    this.#insertAuditRow({
      context: options.context,
      metadataJson: JSON.stringify({
        bucketHash: options.bucketHash,
        budgetGeneration: options.generation,
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
      clientGroup: clientGroup(ipAddress),
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
