import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { verifyRecoverySecret } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { privacyHash } from "../security/crypto.js";
import type { IssuedSession, SessionService } from "./session-service.js";

const MAX_IP_ADDRESS_CHARACTERS = 256;
const MAX_REQUEST_ID_CHARACTERS = 128;
const MAX_USER_AGENT_CHARACTERS = 2_048;
export const RECOVERY_DENIAL_AUDIT_MAX_ROWS = 256;
export const RECOVERY_DENIAL_AUDIT_WINDOW_MS = 15 * 60 * 1_000;
const RECOVERY_DENIAL_AUDIT_REGULAR_ROWS = RECOVERY_DENIAL_AUDIT_MAX_ROWS - 1;
const MAX_SUPPRESSED_AUDIT_COUNT = 0xffff_ffff;

export interface RecoveryAccessRequestContext {
  currentSessionToken?: unknown;
  ipAddress?: string | undefined;
  requestId?: string | undefined;
  userAgent?: string | undefined;
}

export interface RecoveryAccessServiceDependencies {
  clock?: () => Date;
  createId?: () => string;
}

export type RecoveryAccessDenialReason =
  "credential_mismatch" | "invalid_request" | "origin_denied" | "rate_limited";

type RecoveryAccessAuditReason =
  | RecoveryAccessDenialReason
  | "audit_budget_saturated"
  | "credential_verified"
  | "internal_failure";

interface RecoveryAccessAttemptInput extends RecoveryAccessRequestContext {
  denialReason: "credential_mismatch" | "invalid_request";
  secret: unknown;
}

interface NormalizedRecoveryAccessContext {
  ipAddress?: string;
  requestId?: string;
  userAgent?: string;
}

function boundedContext(value: string | undefined, maximum: number) {
  if (!value) return undefined;
  return value.slice(0, maximum);
}

function currentTime(clock: () => Date) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Recovery access requires a valid clock value.");
  }
  return new Date(now.getTime());
}

export class RecoveryAccessService {
  readonly #clock: () => Date;
  readonly #config: Pick<AppConfig, "encryptionKey" | "recoverySecretDigest">;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #denialAuditBuckets = new Set<string>();
  #denialAuditSaturated = false;
  #denialAuditSuppressedCount = 0;
  #denialAuditWindow: number | undefined;
  readonly #sessionService: SessionService;

  public constructor(
    database: DatabaseHandle,
    sessionService: SessionService,
    config: Pick<AppConfig, "encryptionKey" | "recoverySecretDigest">,
    dependencies: RecoveryAccessServiceDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#config = config;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#sessionService = sessionService;
  }

  public authenticate(input: RecoveryAccessAttemptInput): IssuedSession | null {
    const context = this.#normalizeContext(input);
    if (!verifyRecoverySecret(input.secret, this.#config.recoverySecretDigest)) {
      this.#recordBoundedUnauthenticatedAttempt("denied", context, input.denialReason);
      return null;
    }

    return this.#database.sqlite
      .transaction(() => {
        const sessionInput = {
          attribution: { authMethod: "recovery" },
          ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
          ...(context.requestId ? { requestId: context.requestId } : {}),
          ...(context.userAgent ? { userAgent: context.userAgent } : {}),
        } as const;
        const session =
          input.currentSessionToken === undefined
            ? this.#sessionService.createSession(sessionInput)
            : this.#sessionService.replaceSession(input.currentSessionToken, sessionInput);

        this.#recordAttempt("success", context, session.principal.sessionId);
        return session;
      })
      .immediate();
  }

  public recordDeniedAttempt(
    context: RecoveryAccessRequestContext,
    reason: Exclude<RecoveryAccessDenialReason, "rate_limited">,
  ) {
    return this.#recordBoundedUnauthenticatedAttempt(
      "denied",
      this.#normalizeContext(context),
      reason,
    );
  }

  public recordInternalFailure(context: RecoveryAccessRequestContext) {
    return this.#recordBoundedUnauthenticatedAttempt(
      "failure",
      this.#normalizeContext(context),
      "internal_failure",
    );
  }

  public recordRateLimitDeniedAttempt(context: RecoveryAccessRequestContext) {
    return this.#recordBoundedUnauthenticatedAttempt(
      "denied",
      this.#normalizeContext(context),
      "rate_limited",
    );
  }

  public get denialAuditBudgetState() {
    return Object.freeze({
      bucketCount: this.#denialAuditBuckets.size,
      saturated: this.#denialAuditSaturated,
      suppressedCount: this.#denialAuditSuppressedCount,
      window: this.#denialAuditWindow,
    });
  }

  #normalizeContext(context: RecoveryAccessRequestContext): NormalizedRecoveryAccessContext {
    const ipAddress = boundedContext(context.ipAddress, MAX_IP_ADDRESS_CHARACTERS);
    const requestId = boundedContext(context.requestId, MAX_REQUEST_ID_CHARACTERS);
    const userAgent = boundedContext(context.userAgent, MAX_USER_AGENT_CHARACTERS);
    return {
      ...(ipAddress === undefined ? {} : { ipAddress }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(userAgent === undefined ? {} : { userAgent }),
    };
  }

  #recordAttempt(
    outcome: "denied" | "failure" | "success",
    context: NormalizedRecoveryAccessContext,
    sessionId?: string,
    reason: RecoveryAccessAuditReason = "credential_verified",
    occurredAt?: Date,
    includeRequestContext = true,
  ) {
    const now = occurredAt ?? currentTime(this.#clock);
    const userAgentHash =
      includeRequestContext && context.userAgent
        ? privacyHash("user_agent", context.userAgent, this.#config.encryptionKey)
        : null;
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
          id,
          session_id,
          actor_session_id,
          actor_auth_method,
          event_type,
          outcome,
          target_type,
          target_id,
          request_id,
          metadata_json,
          ip_hash,
          created_at
        ) values (
          @id,
          @sessionId,
          @actorSessionId,
          @actorAuthMethod,
          'auth.recovery_access.attempt',
          @outcome,
          'recovery_access',
          @targetId,
          @requestId,
          @metadataJson,
          @ipHash,
          @createdAt
        )`,
      )
      .run({
        actorAuthMethod: sessionId ? "recovery" : null,
        actorSessionId: sessionId ?? null,
        createdAt: now.getTime(),
        id: this.#createId(),
        ipHash:
          includeRequestContext && context.ipAddress
            ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
            : null,
        metadataJson: JSON.stringify({
          reason,
          userAgentHash,
        }),
        outcome,
        requestId: includeRequestContext ? (context.requestId ?? null) : null,
        sessionId: sessionId ?? null,
        targetId: sessionId ?? null,
      });
  }

  #recordBoundedUnauthenticatedAttempt(
    outcome: "denied" | "failure",
    context: NormalizedRecoveryAccessContext,
    reason: RecoveryAccessDenialReason | "internal_failure",
  ) {
    const now = currentTime(this.#clock);
    const window = Math.floor(now.getTime() / RECOVERY_DENIAL_AUDIT_WINDOW_MS);
    if (this.#denialAuditWindow === undefined || window > this.#denialAuditWindow) {
      this.#denialAuditBuckets.clear();
      this.#denialAuditSaturated = false;
      this.#denialAuditSuppressedCount = 0;
      this.#denialAuditWindow = window;
    }
    if (window < this.#denialAuditWindow) {
      this.#incrementSuppressedAuditCount();
      return false;
    }

    const clientHash = privacyHash(
      "rate_limit_client",
      context.ipAddress ?? "unattributed-client",
      this.#config.encryptionKey,
    );
    const bucketKey = `${clientHash}.${reason}`;
    if (this.#denialAuditBuckets.has(bucketKey) || this.#denialAuditSaturated) {
      this.#incrementSuppressedAuditCount();
      return false;
    }

    if (this.#denialAuditBuckets.size < RECOVERY_DENIAL_AUDIT_REGULAR_ROWS) {
      this.#recordAttempt(outcome, context, undefined, reason, now);
      this.#denialAuditBuckets.add(bucketKey);
      return true;
    }

    this.#incrementSuppressedAuditCount();
    this.#recordAttempt("failure", {}, undefined, "audit_budget_saturated", now, false);
    this.#denialAuditSaturated = true;
    return false;
  }

  #incrementSuppressedAuditCount() {
    if (this.#denialAuditSuppressedCount < MAX_SUPPRESSED_AUDIT_COUNT) {
      this.#denialAuditSuppressedCount += 1;
    }
  }
}
