import { csrfTokenSchema, type SessionPrincipal } from "@omnifin/contracts/auth";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { sessions } from "../db/schema.js";
import {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  privacyHash,
  randomToken,
} from "../security/crypto.js";
import { buildSessionPrincipal, type SessionPrincipalRecord } from "./principal.js";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECOVERY_SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_TOKEN_GENERATION_ATTEMPTS = 8;
const SECRET_RESERVATION_COLLISION = "session_secret_reservation_collision";
const VALIDATED_SESSION_BRAND = Symbol("validated-session");
const SESSION_REPLACEMENT_CAPABILITY_BRAND = Symbol("session-replacement-capability");

export const MAX_ACTIVE_SESSIONS_PER_USER = 16;
export const MAX_RECOVERY_SESSION_ISSUANCES_PER_WINDOW = 8;
export const MAX_SESSION_ISSUANCES_PER_USER_WINDOW = 32;
export const SESSION_ISSUANCE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type SessionIssuanceLimitReason = "active_session_limit" | "issuance_rate_limit";

export class SessionIssuanceLimitError extends Error {
  public readonly code = "session_issuance_limited";
  public readonly reason: SessionIssuanceLimitReason;

  public constructor(reason: SessionIssuanceLimitReason) {
    super("Session issuance is temporarily unavailable.");
    this.name = "SessionIssuanceLimitError";
    this.reason = reason;
  }
}

type SessionAuthMethod = "jellyfin" | "oidc" | "recovery";

export type SessionAttribution =
  | {
      authMethod: "jellyfin";
      serviceIdentityLinkId: string;
      userId: string;
    }
  | {
      authMethod: "oidc";
      externalIdentityId: string;
      idTokenHint?: string;
      oidcProviderId: string;
      oidcSessionId?: string;
      serviceIdentityLinkId?: string;
      userId: string;
    }
  | {
      authMethod: "recovery";
    };

export interface CreateSessionInput {
  attribution: SessionAttribution;
  ipAddress?: string;
  requestId?: string;
  userAgent?: string;
}

export interface IssuedSession {
  absoluteExpiresAt: Date;
  csrfToken: string;
  inactivityExpiresAt: Date;
  principal: SessionPrincipal;
  sessionToken: string;
}

export interface ResolvedSession {
  absoluteExpiresAt: Date;
  csrfToken: string;
  inactivityExpiresAt: Date;
  principal: SessionPrincipal;
  rotatedSessionToken?: string;
}

export interface SessionRequestContext {
  ipAddress?: string;
  requestId?: string;
}

export interface SessionServiceDependencies {
  clock?: () => Date;
  createId?: () => string;
  createToken?: () => string;
}

export interface ValidatedSession {
  readonly sessionId: string;
  readonly [VALIDATED_SESSION_BRAND]: true;
}

/** @internal An opaque, transaction-scoped proof of a replaceable session token. */
export interface SessionReplacementCapability {
  readonly [SESSION_REPLACEMENT_CAPABILITY_BRAND]: true;
  toJSON(): never;
}

interface SessionJoinedRow {
  absoluteExpiresAt: number;
  authMethod: SessionAuthMethod;
  createdAt: number;
  csrfTokenHash: string;
  encryptedCsrfToken: string;
  expiresAt: number;
  externalIdentityId: string | null;
  joinedConnectorEnabled: number | null;
  joinedConnectorId: string | null;
  joinedConnectorType: string | null;
  joinedExternalDisplayClaimsJson: string | null;
  joinedExternalId: string | null;
  joinedExternalIssuer: string | null;
  joinedExternalProviderId: string | null;
  joinedExternalSubject: string | null;
  joinedExternalUserId: string | null;
  joinedLinkConnectorId: string | null;
  joinedLinkCreatedAt: number | null;
  joinedLinkExternalDisplayName: string | null;
  joinedLinkExternalUserId: string | null;
  joinedLinkExternalUsername: string | null;
  joinedLinkHealthState: string | null;
  joinedLinkId: string | null;
  joinedLinkLastVerifiedAt: number | null;
  joinedLinkUserId: string | null;
  joinedProviderEnabled: number | null;
  joinedProviderId: string | null;
  joinedUserDisplayName: string | null;
  joinedUserId: string | null;
  joinedUserRole: string | null;
  joinedUserStatus: string | null;
  lastRotatedAt: number;
  lastSeenAt: number;
  oidcProviderId: string | null;
  revokedAt: number | null;
  serviceIdentityLinkId: string | null;
  sessionId: string;
  sessionUserId: string | null;
  tokenHash: string;
}

interface RefreshedSessionRow {
  sessionId: string;
  tokenHash: string;
}

interface RevokedSessionRow {
  authMethod: SessionAuthMethod;
  createdAt: number;
  sessionId: string;
  userId: string | null;
}

interface SessionReplacementCandidate {
  proof: {
    kind: "current" | "rotation_grace";
    presentedTokenHash: string;
    sessionId: string;
  };
  row: SessionJoinedRow;
}

interface SessionReplacementCapabilityState {
  active: boolean;
  database: DatabaseHandle;
  identityOutcome: "denied" | "pending" | "resolved" | "unused";
  operationTime: number;
  proof: SessionReplacementCandidate["proof"];
  replacementAttempted: boolean;
  replacementConsumed: boolean;
}

function validDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function assertDuration(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer duration.`);
  }
}

function assertIdentifier(value: string, name: string) {
  if (!SESSION_ID_PATTERN.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function optionalBoundedText(value: string | undefined, maximum: number, name: string) {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function createSessionReplacementCapability(): SessionReplacementCapability {
  const capability = Object.create(null) as SessionReplacementCapability;
  Object.defineProperty(capability, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => {
      throw new TypeError("Session replacement capabilities cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(capability);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function csrfContext(sessionId: string) {
  return `session:${sessionId}:csrf`;
}

function idTokenHintContext(sessionId: string) {
  return `session:${sessionId}:oidc-id-token-hint`;
}

function mapPrincipalRecord(row: SessionJoinedRow): SessionPrincipalRecord | null {
  const user =
    row.joinedUserId === null
      ? null
      : row.joinedUserDisplayName !== null &&
          ["viewer", "requester", "operator", "admin"].includes(row.joinedUserRole ?? "") &&
          ["active", "disabled", "pending_link"].includes(row.joinedUserStatus ?? "")
        ? {
            displayName: row.joinedUserDisplayName,
            id: row.joinedUserId,
            role: row.joinedUserRole as "admin" | "operator" | "requester" | "viewer",
            status: row.joinedUserStatus as "active" | "disabled" | "pending_link",
          }
        : undefined;
  const externalIdentity =
    row.joinedExternalId === null
      ? null
      : row.joinedExternalDisplayClaimsJson !== null &&
          row.joinedExternalIssuer !== null &&
          row.joinedExternalProviderId !== null &&
          row.joinedExternalSubject !== null &&
          row.joinedExternalUserId !== null
        ? {
            displayClaimsJson: row.joinedExternalDisplayClaimsJson,
            id: row.joinedExternalId,
            issuer: row.joinedExternalIssuer,
            providerId: row.joinedExternalProviderId,
            subject: row.joinedExternalSubject,
            userId: row.joinedExternalUserId,
          }
        : undefined;
  const oidcProvider =
    row.joinedProviderId === null
      ? null
      : row.joinedProviderEnabled !== null
        ? { enabled: row.joinedProviderEnabled === 1, id: row.joinedProviderId }
        : undefined;
  const serviceLink =
    row.joinedLinkId === null
      ? null
      : row.joinedLinkCreatedAt !== null &&
          row.joinedLinkExternalDisplayName !== null &&
          row.joinedLinkExternalUserId !== null &&
          row.joinedLinkExternalUsername !== null &&
          ["linked", "relink_required", "revoked", "unavailable"].includes(
            row.joinedLinkHealthState ?? "",
          ) &&
          row.joinedLinkUserId !== null
        ? {
            connectorId: row.joinedLinkConnectorId,
            createdAt: new Date(row.joinedLinkCreatedAt),
            externalDisplayName: row.joinedLinkExternalDisplayName,
            externalUserId: row.joinedLinkExternalUserId,
            externalUsername: row.joinedLinkExternalUsername,
            healthState: row.joinedLinkHealthState as
              "linked" | "relink_required" | "revoked" | "unavailable",
            id: row.joinedLinkId,
            lastVerifiedAt:
              row.joinedLinkLastVerifiedAt === null ? null : new Date(row.joinedLinkLastVerifiedAt),
            userId: row.joinedLinkUserId,
          }
        : undefined;
  const serviceConnector =
    row.joinedConnectorId === null
      ? null
      : row.joinedConnectorEnabled !== null && row.joinedConnectorType === "jellyfin"
        ? {
            enabled: row.joinedConnectorEnabled === 1,
            id: row.joinedConnectorId,
            type: "jellyfin" as const,
          }
        : undefined;

  if (
    user === undefined ||
    externalIdentity === undefined ||
    oidcProvider === undefined ||
    serviceLink === undefined ||
    serviceConnector === undefined
  ) {
    return null;
  }

  return {
    session: {
      absoluteExpiresAt: new Date(row.absoluteExpiresAt),
      authMethod: row.authMethod,
      createdAt: new Date(row.createdAt),
      expiresAt: new Date(row.expiresAt),
      externalIdentityId: row.externalIdentityId,
      id: row.sessionId,
      oidcProviderId: row.oidcProviderId,
      revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
      serviceIdentityLinkId: row.serviceIdentityLinkId,
      userId: row.sessionUserId,
    },
    externalIdentity,
    oidcProvider,
    serviceConnector,
    serviceLink,
    user,
  };
}

export class SessionService {
  readonly #replacementCapabilities = new WeakMap<
    SessionReplacementCapability,
    SessionReplacementCapabilityState
  >();
  private readonly absoluteTtlMs: number;
  private readonly cipher: EnvelopeCipher;
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly database: DatabaseHandle;
  private readonly inactivityTtlMs: number;
  private readonly privacyKey: Buffer;
  private readonly recoveryAbsoluteTtlMs: number;
  private readonly rotationIntervalMs: number;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey" | "session">,
    dependencies: SessionServiceDependencies = {},
  ) {
    assertDuration(config.session.absoluteTtlMs, "Absolute session TTL");
    assertDuration(config.session.inactivityTtlMs, "Inactivity session TTL");
    assertDuration(config.session.recoveryAbsoluteTtlMs, "Recovery session TTL");
    assertDuration(config.session.rotationIntervalMs, "Session rotation interval");
    this.absoluteTtlMs = config.session.absoluteTtlMs;
    this.cipher = new EnvelopeCipher(config.encryptionKey);
    this.clock = dependencies.clock ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.createToken = dependencies.createToken ?? (() => randomToken());
    this.database = database;
    this.inactivityTtlMs = config.session.inactivityTtlMs;
    this.privacyKey = Buffer.from(config.encryptionKey);
    this.recoveryAbsoluteTtlMs = Math.min(
      config.session.recoveryAbsoluteTtlMs,
      MAX_RECOVERY_SESSION_TTL_MS,
    );
    this.rotationIntervalMs = config.session.rotationIntervalMs;
  }

  /** @internal Verifies composition without exposing the bound database handle. */
  public isBoundToDatabase(database: DatabaseHandle): boolean {
    return this.database === database;
  }

  /** @internal Keeps a replacement capability live only for this synchronous transaction scope. */
  public withSessionReplacementCapability<T>(
    sessionToken: unknown,
    operation: (capability: SessionReplacementCapability | undefined) => T,
  ): T {
    if (!this.database.sqlite.inTransaction) {
      throw new Error("A surrounding session transaction is required.");
    }
    const operationTime = this.currentTime();
    const candidate = this.loadSessionReplacementCandidate(sessionToken, operationTime);
    if (!candidate) {
      const result = operation(undefined);
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Session replacement callbacks must be synchronous.");
      }
      return result;
    }

    const capability = createSessionReplacementCapability();
    const state: SessionReplacementCapabilityState = {
      active: true,
      database: this.database,
      identityOutcome: "unused",
      operationTime: operationTime.getTime(),
      proof: candidate.proof,
      replacementAttempted: false,
      replacementConsumed: false,
    };
    this.#replacementCapabilities.set(capability, state);
    try {
      const result = operation(capability);
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Session replacement callbacks must be synchronous.");
      }
      if (
        state.identityOutcome === "pending" ||
        (state.identityOutcome === "resolved" && !state.replacementConsumed)
      ) {
        throw new Error("Proven session replacement did not complete.");
      }
      return result;
    } finally {
      state.active = false;
      this.#replacementCapabilities.delete(capability);
    }
  }

  /** @internal Verifies the identity-reconciliation use of an opaque replacement capability. */
  public verifyReplacementCapabilityForIdentity(capability: unknown): {
    operationTime: number;
    sessionId: string;
  } {
    const state = this.requireReplacementCapability(capability);
    if (state.identityOutcome !== "unused" || state.replacementAttempted) {
      throw new Error("Session replacement capability was already used.");
    }
    state.identityOutcome = "pending";
    return Object.freeze({
      operationTime: state.operationTime,
      sessionId: state.proof.sessionId,
    });
  }

  /** @internal Completes the identity phase before denial or exact replacement. */
  public completeReplacementIdentityResolution(
    capability: unknown,
    outcome: "denied" | "resolved",
  ): void {
    const state = this.requireReplacementCapability(capability);
    if (state.identityOutcome !== "pending" || state.replacementAttempted) {
      throw new Error("Session replacement identity resolution is invalid.");
    }
    state.identityOutcome = outcome;
  }

  /** @internal Consumes the exact session proven for identity reconciliation. */
  public replaceSessionWithCapability(
    capability: unknown,
    input: CreateSessionInput,
  ): IssuedSession {
    const state = this.requireReplacementCapability(capability);
    if (state.identityOutcome !== "resolved" || state.replacementAttempted) {
      throw new Error("Session replacement capability is not ready for replacement.");
    }
    state.replacementAttempted = true;

    return this.withImmediateTransaction(() => {
      const now = new Date(state.operationTime);
      const currentSession = this.loadProvenReplacementSession(state, now);
      if (!currentSession) throw new Error("Proven session could not be replaced.");
      const issued = this.issueSessionInCurrentTransaction(
        input,
        new Set([state.proof.presentedTokenHash]),
        now,
        currentSession.sessionId,
      );
      const revoked = this.revokeSessionForReplacement(currentSession, now);
      if (!revoked) throw new Error("Proven session could not be replaced.");
      this.auditSessionReplacement(revoked, issued, input, now);
      state.replacementConsumed = true;
      return issued;
    });
  }

  public createSession(input: CreateSessionInput): IssuedSession {
    return this.withImmediateTransaction(() =>
      this.issueSessionInCurrentTransaction(input, new Set(), this.currentTime()),
    );
  }

  private issueSessionInCurrentTransaction(
    input: CreateSessionInput,
    disallowedTokenHashes: ReadonlySet<string>,
    now: Date,
    replacingSessionId?: string,
  ): IssuedSession {
    const attribution = this.validateAttribution(input.attribution);
    const ipAddress = optionalBoundedText(input.ipAddress, 256, "IP address");
    const requestId = optionalBoundedText(input.requestId, 128, "Request identifier");
    const userAgent = optionalBoundedText(input.userAgent, 2_048, "User agent");
    this.assertSessionIssuanceAllowed(attribution, now, replacingSessionId);
    this.deleteExpiredRotationAliases(now);
    const supersededRecoverySessionCount =
      attribution.authMethod === "recovery"
        ? this.revokeActiveRecoverySessions(now, replacingSessionId)
        : 0;
    const sessionId = assertIdentifier(this.createId(), "Session identifier");
    const absoluteTtlMs =
      attribution.authMethod === "recovery" ? this.recoveryAbsoluteTtlMs : this.absoluteTtlMs;
    const absoluteExpiresAt = new Date(now.getTime() + absoluteTtlMs);
    const inactivityExpiresAt = new Date(
      Math.min(now.getTime() + this.inactivityTtlMs, absoluteExpiresAt.getTime()),
    );
    for (
      let reservationAttempt = 0;
      reservationAttempt < MAX_TOKEN_GENERATION_ATTEMPTS;
      reservationAttempt += 1
    ) {
      const sessionToken = this.nextUnreservedToken(disallowedTokenHashes);
      const tokenHash = hashToken(sessionToken);
      const csrfDisallowedHashes = new Set(disallowedTokenHashes);
      csrfDisallowedHashes.add(tokenHash);
      const csrfToken = this.nextUnreservedToken(csrfDisallowedHashes);
      const csrfTokenHash = hashToken(csrfToken);
      const encryptedCsrfToken = this.cipher.encrypt(csrfToken, csrfContext(sessionId));

      try {
        this.database.db
          .insert(sessions)
          .values({
            absoluteExpiresAt,
            authMethod: attribution.authMethod,
            createdAt: now,
            csrfTokenHash,
            encryptedCsrfToken,
            encryptedIdTokenHint:
              attribution.authMethod === "oidc" && attribution.idTokenHint
                ? this.cipher.encrypt(attribution.idTokenHint, idTokenHintContext(sessionId))
                : null,
            expiresAt: inactivityExpiresAt,
            externalIdentityId:
              attribution.authMethod === "oidc" ? attribution.externalIdentityId : null,
            id: sessionId,
            ipHash: ipAddress ? privacyHash("ip_address", ipAddress, this.privacyKey) : null,
            lastRotatedAt: now,
            lastSeenAt: now,
            oidcProviderId: attribution.authMethod === "oidc" ? attribution.oidcProviderId : null,
            oidcSessionIdHash:
              attribution.authMethod === "oidc" && attribution.oidcSessionId
                ? privacyHash("oidc_session_id", attribution.oidcSessionId, this.privacyKey)
                : null,
            serviceIdentityLinkId:
              attribution.authMethod === "recovery"
                ? null
                : (attribution.serviceIdentityLinkId ?? null),
            tokenHash,
            userAgentHash: userAgent ? privacyHash("user_agent", userAgent, this.privacyKey) : null,
            userId: attribution.authMethod === "recovery" ? null : attribution.userId,
          })
          .run();
      } catch (error) {
        if (this.isSecretReservationCollision(error)) continue;
        throw error;
      }

      const row = this.loadJoinedSession(sessionId, tokenHash);
      const principalRecord = row && mapPrincipalRecord(row);
      const principal = principalRecord && buildSessionPrincipal(principalRecord, now);
      if (!principal) throw new Error("Session attribution could not be established.");
      this.insertAuditEvent(
        {
          authMethod: attribution.authMethod,
          createdAt: now.getTime(),
          sessionId,
          userId: attribution.authMethod === "recovery" ? null : attribution.userId,
        },
        {
          context: {
            ...(ipAddress ? { ipAddress } : {}),
            ...(requestId ? { requestId } : {}),
          },
          eventType: "auth.session.created",
          metadata: { authenticationMethod: attribution.authMethod },
          occurredAt: now,
          outcome: "success",
          targetId: sessionId,
        },
      );
      if (supersededRecoverySessionCount > 0) {
        this.insertAuditEvent(
          {
            authMethod: "recovery",
            createdAt: now.getTime(),
            sessionId,
            userId: null,
          },
          {
            context: {
              ...(ipAddress ? { ipAddress } : {}),
              ...(requestId ? { requestId } : {}),
            },
            eventType: "auth.recovery_session.superseded",
            metadata: {
              reason: "verified_recovery_access",
              revokedSessionCount: supersededRecoverySessionCount,
            },
            occurredAt: now,
            outcome: "success",
            targetId: sessionId,
          },
        );
      }

      return {
        absoluteExpiresAt,
        csrfToken,
        inactivityExpiresAt,
        principal,
        sessionToken,
      };
    }
    throw new Error("A unique secure session token could not be generated.");
  }

  public replaceSession(currentSessionToken: unknown, input: CreateSessionInput): IssuedSession {
    const disallowedTokenHashes = this.validSessionToken(currentSessionToken)
      ? new Set([hashToken(currentSessionToken)])
      : new Set<string>();
    return this.withImmediateTransaction(() => {
      const now = this.currentTime();
      const currentSession = this.loadReplaceableSession(currentSessionToken, now);
      const issued = this.issueSessionInCurrentTransaction(
        input,
        disallowedTokenHashes,
        now,
        currentSession?.sessionId,
      );
      if (!currentSession) return issued;

      const revoked = this.revokeSessionForReplacement(currentSession, now);
      if (!revoked) throw new Error("Current session could not be replaced.");

      this.auditSessionReplacement(revoked, issued, input, now);
      return issued;
    });
  }

  private revokeSessionForReplacement(currentSession: SessionJoinedRow, now: Date) {
    return this.database.sqlite
      .prepare(
        `update sessions
         set revoked_at = @now
         where id = @sessionId
           and revoked_at is null
           and created_at <= @now
           and last_rotated_at <= @now
           and last_seen_at <= @now
           and expires_at > @now
           and absolute_expires_at > @now
         returning
           id as sessionId,
           user_id as userId,
           auth_method as authMethod,
           created_at as createdAt`,
      )
      .get({ now: now.getTime(), sessionId: currentSession.sessionId }) as
      RevokedSessionRow | undefined;
  }

  private auditSessionReplacement(
    revoked: RevokedSessionRow,
    issued: IssuedSession,
    input: CreateSessionInput,
    now: Date,
  ) {
    this.insertAuditEvent(revoked, {
      context: {
        ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
      eventType: "auth.session.replaced",
      metadata: {
        authenticationMethod: input.attribution.authMethod,
        reason: "reauthentication",
        replacementSessionId: issued.principal.sessionId,
      },
      occurredAt: now,
      outcome: "success",
      targetId: revoked.sessionId,
    });
  }

  public resolveAndRefresh(sessionToken: unknown): ResolvedSession | null {
    if (!this.validSessionToken(sessionToken)) return null;
    const previousTokenHash = hashToken(sessionToken);
    return this.withImmediateTransaction(() => {
      const now = this.currentTime();
      this.deleteExpiredRotationAliases(now);
      const current = this.loadJoinedSessionByTokenHash(previousTokenHash);
      if (!current) {
        const graceRow = this.loadRotationGraceSession(previousTokenHash, now);
        return graceRow ? this.resolveLoadedSession(graceRow, now) : null;
      }
      if (!this.sessionLifecycleIsActive(current, now)) {
        if (!this.recoveryLifetimeIsValid(current)) {
          this.invalidateSession(current, "recovery_ttl_invalid", now);
        }
        return null;
      }
      if (current.lastRotatedAt <= now.getTime() - this.rotationIntervalMs) {
        return this.rotateAndResolveSession(current, previousTokenHash, now);
      }

      const refreshed = this.database.sqlite
        .prepare(
          `update sessions
           set
             last_seen_at = @now,
             expires_at = min(absolute_expires_at, @inactivityTarget)
           where id = @sessionId
             and token_hash = @previousTokenHash
             and revoked_at is null
             and created_at <= @now
             and last_rotated_at <= @now
             and last_seen_at <= @now
             and expires_at > @now
             and absolute_expires_at > @now
             and (
               auth_method <> 'recovery'
               or absolute_expires_at - created_at <= @recoveryTtlLimit
             )
           returning id as sessionId, token_hash as tokenHash`,
        )
        .get({
          inactivityTarget: now.getTime() + this.inactivityTtlMs,
          now: now.getTime(),
          previousTokenHash,
          recoveryTtlLimit: this.recoveryAbsoluteTtlMs,
          sessionId: current.sessionId,
        }) as RefreshedSessionRow | undefined;
      if (!refreshed) return null;
      const row = this.loadJoinedSession(refreshed.sessionId, refreshed.tokenHash);
      return row ? this.resolveLoadedSession(row, now) : null;
    });
  }

  private rotateAndResolveSession(current: SessionJoinedRow, previousTokenHash: string, now: Date) {
    for (
      let reservationAttempt = 0;
      reservationAttempt < MAX_TOKEN_GENERATION_ATTEMPTS;
      reservationAttempt += 1
    ) {
      const rotatedSessionToken = this.nextUnreservedToken(new Set([previousTokenHash]));
      const rotatedTokenHash = hashToken(rotatedSessionToken);
      let refreshed: RefreshedSessionRow | undefined;
      try {
        refreshed = this.database.sqlite
          .prepare(
            `update sessions
             set
               token_hash = @rotatedTokenHash,
               last_rotated_at = @now,
               last_seen_at = @now,
               expires_at = min(absolute_expires_at, @inactivityTarget)
             where id = @sessionId
               and token_hash = @previousTokenHash
               and revoked_at is null
               and created_at <= @now
               and last_rotated_at <= @rotationCutoff
               and last_seen_at <= @now
               and expires_at > @now
               and absolute_expires_at > @now
               and (
                 auth_method <> 'recovery'
                 or absolute_expires_at - created_at <= @recoveryTtlLimit
               )
             returning id as sessionId, token_hash as tokenHash`,
          )
          .get({
            inactivityTarget: now.getTime() + this.inactivityTtlMs,
            now: now.getTime(),
            previousTokenHash,
            recoveryTtlLimit: this.recoveryAbsoluteTtlMs,
            rotatedTokenHash,
            rotationCutoff: now.getTime() - this.rotationIntervalMs,
            sessionId: current.sessionId,
          }) as RefreshedSessionRow | undefined;
      } catch (error) {
        if (this.isSecretReservationCollision(error)) continue;
        throw error;
      }
      if (!refreshed) return null;
      const row = this.loadJoinedSession(refreshed.sessionId, refreshed.tokenHash);
      return row ? this.resolveLoadedSession(row, now, { rotatedSessionToken }) : null;
    }
    throw new Error("A unique secure session token could not be generated.");
  }

  public validateSessionCsrf(
    sessionToken: unknown,
    csrfToken: unknown,
    context: SessionRequestContext = {},
  ): ValidatedSession | null {
    if (!this.validSessionToken(sessionToken)) return null;
    const now = this.currentTime();
    const presentedTokenHash = hashToken(sessionToken);
    const row =
      this.loadJoinedSessionByTokenHash(presentedTokenHash) ??
      this.loadRotationGraceSession(presentedTokenHash, now);
    const principalRecord = row && mapPrincipalRecord(row);
    const principal = principalRecord && buildSessionPrincipal(principalRecord, now);
    if (!row || !principal) return null;
    if (!this.recoveryLifetimeIsValid(row)) {
      this.invalidateSession(row, "recovery_ttl_invalid", now, context);
      return null;
    }

    const parsedCsrfToken = csrfTokenSchema.safeParse(csrfToken);
    const candidateHash = hashToken(parsedCsrfToken.success ? parsedCsrfToken.data : "");
    const candidateMatches = constantTimeTextEqual(candidateHash, row.csrfTokenHash);
    if (!parsedCsrfToken.success || !candidateMatches) {
      this.auditSessionEvent(row, {
        coalescedAuditId: `csrf-denied-${hashToken(`session:${row.sessionId}`)}`,
        context,
        eventType: "auth.session.csrf_denied",
        metadata: { reason: "csrf_mismatch" },
        occurredAt: now,
        outcome: "denied",
        targetId: row.sessionId,
      });
      return null;
    }

    let storedCsrfToken: string;
    try {
      storedCsrfToken = this.cipher.decrypt(row.encryptedCsrfToken, csrfContext(row.sessionId));
    } catch {
      this.invalidateSession(row, "csrf_integrity_failure", now, context);
      return null;
    }
    const storedTokenIsValid = csrfTokenSchema.safeParse(storedCsrfToken).success;
    const storedHashMatches = constantTimeTextEqual(hashToken(storedCsrfToken), row.csrfTokenHash);
    const plaintextMatches = constantTimeTextEqual(parsedCsrfToken.data, storedCsrfToken);
    if (!storedTokenIsValid || !storedHashMatches || !plaintextMatches) {
      this.invalidateSession(row, "csrf_integrity_failure", now, context);
      return null;
    }
    return Object.freeze({
      [VALIDATED_SESSION_BRAND]: true as const,
      sessionId: row.sessionId,
    });
  }

  public revokeValidatedSession(
    validatedSession: ValidatedSession,
    context: SessionRequestContext = {},
  ) {
    if (
      !validatedSession ||
      validatedSession[VALIDATED_SESSION_BRAND] !== true ||
      !SESSION_ID_PATTERN.test(validatedSession.sessionId)
    ) {
      return false;
    }
    return this.revokeSessionById(validatedSession.sessionId, context);
  }

  public revokeSession(sessionToken: unknown, context: SessionRequestContext = {}) {
    if (!this.validSessionToken(sessionToken)) return false;
    const tokenHash = hashToken(sessionToken);
    return this.withImmediateTransaction(() => {
      const now = this.currentTime();
      this.deleteExpiredRotationAliases(now);
      const row =
        this.loadJoinedSessionByTokenHash(tokenHash) ??
        this.loadRotationGraceSession(tokenHash, now);
      return row ? this.revokeSessionById(row.sessionId, context, now) : false;
    });
  }

  public shouldClearSessionCookie(sessionToken: unknown) {
    if (typeof sessionToken !== "string" || !SESSION_TOKEN_PATTERN.test(sessionToken)) return true;
    return this.loadJoinedSessionByTokenHash(hashToken(sessionToken)) !== undefined;
  }

  private revokeSessionById(
    sessionId: string,
    context: SessionRequestContext,
    operationTime?: Date,
  ) {
    return this.withImmediateTransaction(() => {
      const now = operationTime ?? this.currentTime();
      const revoked = this.database.sqlite
        .prepare(
          `update sessions
           set revoked_at = @now
           where id = @sessionId
             and revoked_at is null
             and created_at <= @now
           returning
             id as sessionId,
             user_id as userId,
             auth_method as authMethod,
             created_at as createdAt`,
        )
        .get({ now: now.getTime(), sessionId }) as RevokedSessionRow | undefined;
      if (!revoked) return false;
      this.insertAuditEvent(revoked, {
        context,
        eventType: "auth.session.logout",
        metadata: { reason: "user_logout" },
        occurredAt: now,
        outcome: "success",
        targetId: revoked.sessionId,
      });
      return true;
    });
  }

  private auditSessionEvent(
    row: SessionJoinedRow,
    event: {
      coalescedAuditId?: string;
      context: SessionRequestContext;
      eventType: string;
      metadata: Record<string, boolean | number | string>;
      occurredAt: Date;
      outcome: "denied" | "failure" | "success";
      targetId: string;
    },
  ) {
    this.insertAuditEvent(
      {
        authMethod: row.authMethod,
        createdAt: row.createdAt,
        sessionId: row.sessionId,
        userId: row.sessionUserId,
      },
      event,
    );
  }

  private currentTime() {
    const now = this.clock();
    if (!(now instanceof Date) || !validDate(now)) {
      throw new TypeError("Session operations require a valid clock value.");
    }
    return new Date(now.getTime());
  }

  private decryptAndValidateCsrf(row: SessionJoinedRow, now: Date) {
    let decrypted: ReturnType<EnvelopeCipher["decryptWithMetadata"]>;
    try {
      decrypted = this.cipher.decryptWithMetadata(
        row.encryptedCsrfToken,
        csrfContext(row.sessionId),
      );
    } catch {
      this.invalidateSession(row, "csrf_integrity_failure", now);
      return null;
    }
    const parsed = csrfTokenSchema.safeParse(decrypted.plaintext);
    if (
      !parsed.success ||
      !constantTimeTextEqual(hashToken(decrypted.plaintext), row.csrfTokenHash)
    ) {
      this.invalidateSession(row, "csrf_integrity_failure", now);
      return null;
    }
    if (decrypted.needsReencryption) {
      this.database.sqlite
        .prepare(
          `update sessions
           set encrypted_csrf_token = @encryptedCsrfToken
           where id = @sessionId
             and token_hash = @tokenHash
             and encrypted_csrf_token = @previousCiphertext
             and revoked_at is null`,
        )
        .run({
          encryptedCsrfToken: this.cipher.encrypt(parsed.data, csrfContext(row.sessionId)),
          previousCiphertext: row.encryptedCsrfToken,
          sessionId: row.sessionId,
          tokenHash: row.tokenHash,
        });
    }
    return parsed.data;
  }

  private insertAuditEvent(
    session: RevokedSessionRow,
    event: {
      coalescedAuditId?: string;
      context: SessionRequestContext;
      eventType: string;
      metadata: Record<string, boolean | number | string>;
      occurredAt: Date;
      outcome: "denied" | "failure" | "success";
      targetId: string;
    },
  ) {
    const coalescesById = event.coalescedAuditId !== undefined;
    const auditId = assertIdentifier(event.coalescedAuditId ?? this.createId(), "Audit identifier");
    const requestId = event.context.requestId;
    if (requestId !== undefined && (requestId.length < 1 || requestId.length > 128)) {
      throw new TypeError("Audit request identifier is invalid.");
    }
    this.database.sqlite
      .prepare(
        `insert into audit_events (
          id,
          actor_user_id,
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
          @actorUserId,
          @sessionId,
          @actorSessionId,
          @actorAuthMethod,
          @eventType,
          @outcome,
          'session',
          @targetId,
          @requestId,
          @metadataJson,
          @ipHash,
          @createdAt
        )${coalescesById ? " on conflict(id) do nothing" : ""}`,
      )
      .run({
        actorAuthMethod: session.authMethod,
        actorSessionId: session.sessionId,
        actorUserId: session.userId,
        createdAt: event.occurredAt.getTime(),
        eventType: event.eventType,
        id: auditId,
        ipHash: event.context.ipAddress
          ? privacyHash(
              "ip_address",
              optionalBoundedText(event.context.ipAddress, 256, "IP address")!,
              this.privacyKey,
            )
          : null,
        metadataJson: JSON.stringify(event.metadata),
        outcome: event.outcome,
        requestId: requestId ?? null,
        sessionId: session.sessionId,
        targetId: event.targetId,
      });
  }

  private invalidateSession(
    row: SessionJoinedRow,
    reason: "attribution_invalid" | "csrf_integrity_failure" | "recovery_ttl_invalid",
    now: Date,
    context: SessionRequestContext = {},
  ) {
    this.withImmediateTransaction(() => {
      const result = this.database.sqlite
        .prepare(
          `update sessions
           set revoked_at = @now
           where id = @sessionId and revoked_at is null`,
        )
        .run({ now: Math.max(now.getTime(), row.createdAt), sessionId: row.sessionId });
      if (result.changes !== 1) return;
      this.auditSessionEvent(row, {
        context,
        eventType: "auth.session.invalidated",
        metadata: { reason },
        occurredAt: now,
        outcome: "failure",
        targetId: row.sessionId,
      });
    });
  }

  private loadJoinedSession(sessionId: string, tokenHash: string) {
    return this.database.sqlite
      .prepare(this.joinedSessionQuery("s.id = @sessionId and s.token_hash = @tokenHash"))
      .get({ sessionId, tokenHash }) as SessionJoinedRow | undefined;
  }

  private loadJoinedSessionByTokenHash(tokenHash: string) {
    return this.database.sqlite
      .prepare(this.joinedSessionQuery("s.token_hash = @tokenHash"))
      .get({ tokenHash }) as SessionJoinedRow | undefined;
  }

  private loadJoinedSessionById(sessionId: string) {
    return this.database.sqlite
      .prepare(this.joinedSessionQuery("s.id = @sessionId"))
      .get({ sessionId }) as SessionJoinedRow | undefined;
  }

  private loadReplaceableSession(sessionToken: unknown, now: Date) {
    return this.loadSessionReplacementCandidate(sessionToken, now)?.row;
  }

  private loadSessionReplacementCandidate(
    sessionToken: unknown,
    now: Date,
  ): SessionReplacementCandidate | undefined {
    if (!this.validSessionToken(sessionToken)) return undefined;
    const presentedTokenHash = hashToken(sessionToken);
    const current = this.loadJoinedSessionByTokenHash(presentedTokenHash);
    const row = current ?? this.loadRotationGraceSession(presentedTokenHash, now);
    if (!row) return undefined;
    if (!this.replaceableSessionIsValid(row, now)) return undefined;

    return {
      proof: {
        kind: current ? "current" : "rotation_grace",
        presentedTokenHash,
        sessionId: row.sessionId,
      },
      row,
    };
  }

  private replaceableSessionIsValid(row: SessionJoinedRow, now: Date) {
    if (
      row.revokedAt !== null ||
      row.createdAt > now.getTime() ||
      row.lastRotatedAt > now.getTime() ||
      row.lastSeenAt > now.getTime() ||
      row.expiresAt <= now.getTime() ||
      row.absoluteExpiresAt <= now.getTime() ||
      !this.recoveryLifetimeIsValid(row)
    ) {
      return false;
    }
    const principalRecord = mapPrincipalRecord(row);
    if (!principalRecord || !buildSessionPrincipal(principalRecord, now)) return false;

    try {
      const csrfToken = this.cipher.decrypt(row.encryptedCsrfToken, csrfContext(row.sessionId));
      if (
        !csrfTokenSchema.safeParse(csrfToken).success ||
        !constantTimeTextEqual(hashToken(csrfToken), row.csrfTokenHash)
      ) {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  private loadProvenReplacementSession(state: SessionReplacementCapabilityState, now: Date) {
    const row =
      state.proof.kind === "current"
        ? this.loadJoinedSession(state.proof.sessionId, state.proof.presentedTokenHash)
        : this.loadRotationGraceSession(state.proof.presentedTokenHash, now);
    if (
      !row ||
      row.sessionId !== state.proof.sessionId ||
      !this.replaceableSessionIsValid(row, now)
    ) {
      return undefined;
    }
    return row;
  }

  private loadRotationGraceSession(tokenHash: string, now: Date) {
    const grace = this.database.sqlite
      .prepare(
        `select session_id as sessionId
         from session_rotation_aliases
         where token_hash = @tokenHash
           and purpose = 'bearer'
           and state = 'rotation_grace'
           and valid_from <= @now
           and expires_at > @now
         limit 1`,
      )
      .get({ now: now.getTime(), tokenHash }) as { sessionId: string } | undefined;
    return grace ? this.loadJoinedSessionById(grace.sessionId) : undefined;
  }

  private joinedSessionQuery(predicate: string) {
    return `select
      s.id as sessionId,
      s.token_hash as tokenHash,
      s.user_id as sessionUserId,
      s.auth_method as authMethod,
      s.oidc_provider_id as oidcProviderId,
      s.external_identity_id as externalIdentityId,
      s.service_identity_link_id as serviceIdentityLinkId,
      s.csrf_token_hash as csrfTokenHash,
      s.encrypted_csrf_token as encryptedCsrfToken,
      s.last_rotated_at as lastRotatedAt,
      s.last_seen_at as lastSeenAt,
      s.expires_at as expiresAt,
      s.absolute_expires_at as absoluteExpiresAt,
      s.revoked_at as revokedAt,
      s.created_at as createdAt,
      u.id as joinedUserId,
      u.display_name as joinedUserDisplayName,
      u.role as joinedUserRole,
      u.status as joinedUserStatus,
      e.id as joinedExternalId,
      e.user_id as joinedExternalUserId,
      e.provider_id as joinedExternalProviderId,
      e.issuer as joinedExternalIssuer,
      e.subject as joinedExternalSubject,
      e.display_claims_json as joinedExternalDisplayClaimsJson,
      p.id as joinedProviderId,
      p.enabled as joinedProviderEnabled,
      l.id as joinedLinkId,
      l.user_id as joinedLinkUserId,
      l.connector_id as joinedLinkConnectorId,
      l.external_user_id as joinedLinkExternalUserId,
      l.external_username as joinedLinkExternalUsername,
      l.external_display_name as joinedLinkExternalDisplayName,
      l.health_state as joinedLinkHealthState,
      l.last_verified_at as joinedLinkLastVerifiedAt,
      l.created_at as joinedLinkCreatedAt,
      c.id as joinedConnectorId,
      c.type as joinedConnectorType,
      c.enabled as joinedConnectorEnabled
    from sessions s
    left join users u on u.id = s.user_id
    left join external_identities e on e.id = s.external_identity_id
    left join oidc_providers p on p.id = s.oidc_provider_id
    left join service_identity_links l
      on l.user_id = s.user_id and l.service = 'jellyfin'
    left join connector_configs c
      on c.id = l.connector_id and c.type = 'jellyfin'
    where ${predicate}
    limit 1`;
  }

  private nextUnreservedToken(disallowedHashes: ReadonlySet<string>) {
    for (let attempt = 0; attempt < MAX_TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = this.createToken();
      if (!SESSION_TOKEN_PATTERN.test(candidate)) continue;
      const candidateHash = hashToken(candidate);
      if (disallowedHashes.has(candidateHash)) continue;
      const reserved = this.database.sqlite
        .prepare(
          `select 1
           from session_secret_reservations
           where secret_hash = @candidateHash
           limit 1`,
        )
        .get({ candidateHash });
      if (reserved) continue;
      return candidate;
    }
    throw new Error("A unique secure session token could not be generated.");
  }

  private assertSessionIssuanceAllowed(
    attribution: SessionAttribution,
    now: Date,
    replacingSessionId?: string,
  ) {
    const nowTime = now.getTime();
    if (attribution.authMethod === "recovery") {
      const recentRecovery = this.database.sqlite
        .prepare(
          `select count(*) as count
           from (
             select 1
             from sessions
             where auth_method = 'recovery'
               and created_at > @windowCutoff
             limit ${MAX_RECOVERY_SESSION_ISSUANCES_PER_WINDOW}
           )`,
        )
        .get({ windowCutoff: nowTime - SESSION_ISSUANCE_WINDOW_MS }) as { count: number };
      if (recentRecovery.count >= MAX_RECOVERY_SESSION_ISSUANCES_PER_WINDOW) {
        throw new SessionIssuanceLimitError("issuance_rate_limit");
      }
      return;
    }
    const active = this.database.sqlite
      .prepare(
        `select count(*) as count
         from (
           select 1
           from sessions
           where user_id = @userId
             and revoked_at is null
             and expires_at > @now
             and absolute_expires_at > @now
             and (@replacingSessionId is null or id <> @replacingSessionId)
           limit ${MAX_ACTIVE_SESSIONS_PER_USER}
         )`,
      )
      .get({
        now: nowTime,
        replacingSessionId: replacingSessionId ?? null,
        userId: attribution.userId,
      }) as { count: number };
    if (active.count >= MAX_ACTIVE_SESSIONS_PER_USER) {
      throw new SessionIssuanceLimitError("active_session_limit");
    }

    const recent = this.database.sqlite
      .prepare(
        `select count(*) as count
         from (
           select 1
           from sessions
           where user_id = @userId
             and created_at > @windowCutoff
           limit ${MAX_SESSION_ISSUANCES_PER_USER_WINDOW}
         )`,
      )
      .get({
        userId: attribution.userId,
        windowCutoff: nowTime - SESSION_ISSUANCE_WINDOW_MS,
      }) as { count: number };
    if (recent.count >= MAX_SESSION_ISSUANCES_PER_USER_WINDOW) {
      throw new SessionIssuanceLimitError("issuance_rate_limit");
    }
  }

  private revokeActiveRecoverySessions(now: Date, replacingSessionId?: string) {
    const revoked = this.database.sqlite
      .prepare(
        `update sessions
         set revoked_at = max(@now, created_at)
         where auth_method = 'recovery'
           and revoked_at is null
           and (@replacingSessionId is null or id <> @replacingSessionId)
         returning id`,
      )
      .all({ now: now.getTime(), replacingSessionId: replacingSessionId ?? null });
    return revoked.length;
  }

  private deleteExpiredRotationAliases(now: Date) {
    this.database.sqlite
      .prepare("delete from session_rotation_aliases where expires_at <= @now")
      .run({ now: now.getTime() });
  }

  private sessionLifecycleIsActive(row: SessionJoinedRow, now: Date) {
    const operationTime = now.getTime();
    return (
      row.revokedAt === null &&
      row.createdAt <= operationTime &&
      row.lastRotatedAt <= operationTime &&
      row.lastSeenAt <= operationTime &&
      row.expiresAt > operationTime &&
      row.absoluteExpiresAt > operationTime &&
      this.recoveryLifetimeIsValid(row)
    );
  }

  private isSecretReservationCollision(error: unknown) {
    return error instanceof Error && error.message === SECRET_RESERVATION_COLLISION;
  }

  private requireReplacementCapability(capability: unknown) {
    if (
      !this.database.sqlite.inTransaction ||
      typeof capability !== "object" ||
      capability === null
    ) {
      throw new Error("Session replacement capability is invalid.");
    }
    const state = this.#replacementCapabilities.get(capability as SessionReplacementCapability);
    if (!state?.active || state.database !== this.database) {
      throw new Error("Session replacement capability is invalid.");
    }
    return state;
  }

  private withImmediateTransaction<T>(operation: () => T): T {
    const transaction = this.database.sqlite.transaction(operation);
    return this.database.sqlite.inTransaction ? transaction() : transaction.immediate();
  }

  private resolveLoadedSession(
    row: SessionJoinedRow,
    now: Date,
    rotation?: { rotatedSessionToken: string },
  ): ResolvedSession | null {
    const principalRecord = mapPrincipalRecord(row);
    const principal = principalRecord && buildSessionPrincipal(principalRecord, now);
    if (!principal) {
      this.invalidateSession(row, "attribution_invalid", now);
      return null;
    }
    if (!this.recoveryLifetimeIsValid(row)) {
      this.invalidateSession(row, "recovery_ttl_invalid", now);
      return null;
    }
    const csrfToken = this.decryptAndValidateCsrf(row, now);
    if (!csrfToken) return null;
    return {
      absoluteExpiresAt: new Date(row.absoluteExpiresAt),
      csrfToken,
      inactivityExpiresAt: new Date(row.expiresAt),
      principal,
      ...rotation,
    };
  }

  private recoveryLifetimeIsValid(row: SessionJoinedRow) {
    return (
      row.authMethod !== "recovery" ||
      row.absoluteExpiresAt - row.createdAt <= this.recoveryAbsoluteTtlMs
    );
  }

  private validSessionToken(value: unknown): value is string {
    return typeof value === "string" && SESSION_TOKEN_PATTERN.test(value);
  }

  private validateAttribution(attribution: SessionAttribution): SessionAttribution {
    if (attribution.authMethod === "recovery") return attribution;
    assertIdentifier(attribution.userId, "User identifier");
    if (attribution.authMethod === "jellyfin") {
      assertIdentifier(attribution.serviceIdentityLinkId, "Service identity link identifier");
      return attribution;
    }
    assertIdentifier(attribution.externalIdentityId, "External identity identifier");
    assertIdentifier(attribution.oidcProviderId, "OIDC provider identifier");
    if (attribution.serviceIdentityLinkId !== undefined) {
      assertIdentifier(attribution.serviceIdentityLinkId, "Service identity link identifier");
    }
    optionalBoundedText(attribution.oidcSessionId, 2_048, "OIDC session identifier");
    optionalBoundedText(attribution.idTokenHint, 16_384, "OIDC ID token hint");
    return attribution;
  }
}
