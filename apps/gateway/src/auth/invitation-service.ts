import {
  INVITATION_DEFAULT_TTL_SECONDS,
  INVITATION_MAX_TTL_SECONDS,
  INVITATION_TOKEN_BYTES,
  REGISTRATION_HANDOFF_TTL_SECONDS,
  REGISTRATION_HANDOFF_TOKEN_BYTES,
  invitationCreateRequestSchema,
  invitationCreateResponseSchema,
  invitationExchangeRequestSchema,
  invitationListQuerySchema,
  invitationListResponseSchema,
  invitationRevokeResponseSchema,
  invitationSummarySchema,
  type InvitationCreateRequest,
  type InvitationCreateResponse,
  type InvitationListQuery,
  type InvitationListResponse,
  type InvitationRevokeResponse,
  type InvitationStatus,
  type InvitationSummary,
} from "@omnifin/contracts/invitations";
import type { SessionPrincipal } from "@omnifin/contracts/auth";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { hashToken, privacyHash, randomToken } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_IP_LENGTH = 256;
const CLAIM_BRAND = Symbol("invitation-registration-claim");

export type InvitationServiceErrorReason =
  | "cursor_invalid"
  | "integrity_failure"
  | "invitation_consumed"
  | "invitation_expired"
  | "invitation_not_found"
  | "invitation_revoked"
  | "registration_handoff_invalid"
  | "permission_denied"
  | "storage_failure";

export class InvitationServiceError extends Error {
  public readonly reason: InvitationServiceErrorReason;

  public constructor(reason: InvitationServiceErrorReason, options?: ErrorOptions) {
    super("Invitation administration could not be completed.", options);
    this.name = "InvitationServiceError";
    this.reason = reason;
  }
}

export interface InvitationServiceDependencies {
  clock?: () => Date;
  createId?: () => string;
  createHandoffToken?: () => string;
  createToken?: () => string;
}

export interface InvitationAdminContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface InvitationRegistrationContext {
  ipAddress?: string;
  requestId?: string;
}

export interface InvitationRegistrationHandoffInput {
  invitationId: string;
  handoffToken: unknown;
}

export interface InvitationRegistrationHandoff {
  readonly invitationId: string;
  readonly expiresAt: Date;
  readonly [HANDOFF_BRAND]: true;
  toJSON(): never;
}

/**
 * A single-use, transaction-scoped admission proof. It deliberately contains
 * no role, recipient, or identity information for the later proof lane.
 */
export interface InvitationRegistrationClaim {
  readonly consumedAt: Date;
  readonly invitationId: string;
  readonly [CLAIM_BRAND]: true;
  toJSON(): never;
}

interface InvitationRow {
  consumedAt: number | null;
  createdAt: number;
  expiresAt: number;
  id: string;
  revokedAt: number | null;
  registrationHandoffExpiresAt: number | null;
  registrationHandoffHash: string | null;
  tokenHash: string;
}

const HANDOFF_BRAND = Symbol("invitation-registration-handoff");

function validIdentifier(value: unknown) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validOptionalText(value: string | undefined, maximum: number) {
  return (
    value === undefined || (value.length >= 1 && value.length <= maximum && value.trim() === value)
  );
}

function invitationStatus(row: InvitationRow, now: number): InvitationStatus {
  if (row.consumedAt !== null) return "consumed";
  if (row.revokedAt !== null) return "revoked";
  return row.expiresAt <= now ? "expired" : "active";
}

function presentInvitation(row: InvitationRow, now: number): InvitationSummary {
  if (
    !validIdentifier(row.id) ||
    !validTimestamp(row.createdAt) ||
    !validTimestamp(row.expiresAt) ||
    row.expiresAt <= row.createdAt ||
    (row.consumedAt !== null &&
      (!validTimestamp(row.consumedAt) || row.consumedAt < row.createdAt)) ||
    (row.revokedAt !== null && (!validTimestamp(row.revokedAt) || row.revokedAt < row.createdAt)) ||
    (row.consumedAt !== null && row.revokedAt !== null) ||
    (row.registrationHandoffHash === null) !== (row.registrationHandoffExpiresAt === null) ||
    (row.registrationHandoffHash !== null &&
      (!INVITATION_TOKEN_PATTERN.test(row.registrationHandoffHash) ||
        row.registrationHandoffExpiresAt === null ||
        !validTimestamp(row.registrationHandoffExpiresAt) ||
        row.registrationHandoffExpiresAt < row.createdAt ||
        row.registrationHandoffExpiresAt > row.expiresAt)) ||
    ((row.consumedAt !== null || row.revokedAt !== null) &&
      (row.registrationHandoffHash !== null || row.registrationHandoffExpiresAt !== null))
  ) {
    throw new InvitationServiceError("integrity_failure");
  }
  const parsed = invitationSummarySchema.safeParse({
    consumedAt: row.consumedAt === null ? null : new Date(row.consumedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    id: row.id,
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt).toISOString(),
    status: invitationStatus(row, now),
  });
  if (!parsed.success) throw new InvitationServiceError("integrity_failure");
  return parsed.data;
}

function decodeInvitationToken(value: unknown) {
  if (typeof value !== "string" || !INVITATION_TOKEN_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === INVITATION_TOKEN_BYTES && decoded.toString("base64url") === value
    ? value
    : null;
}

function decodeRegistrationHandoffToken(value: unknown) {
  if (typeof value !== "string" || !INVITATION_TOKEN_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === REGISTRATION_HANDOFF_TOKEN_BYTES &&
    decoded.toString("base64url") === value
    ? value
    : null;
}

function createHandoff(invitationId: string, expiresAt: number): InvitationRegistrationHandoff {
  const handoff = Object.create(null) as InvitationRegistrationHandoff;
  Object.defineProperties(handoff, {
    invitationId: { enumerable: true, value: invitationId, writable: false },
    expiresAt: { enumerable: true, value: new Date(expiresAt), writable: false },
    [HANDOFF_BRAND]: { enumerable: false, value: true, writable: false },
    toJSON: {
      enumerable: false,
      value: () => {
        throw new TypeError("Invitation registration handoffs cannot be serialized.");
      },
      writable: false,
    },
  });
  return Object.freeze(handoff);
}

function createClaim(invitationId: string, consumedAt: number): InvitationRegistrationClaim {
  const claim = Object.create(null) as InvitationRegistrationClaim;
  Object.defineProperties(claim, {
    consumedAt: {
      configurable: false,
      enumerable: true,
      value: new Date(consumedAt),
      writable: false,
    },
    invitationId: {
      configurable: false,
      enumerable: true,
      value: invitationId,
      writable: false,
    },
    [CLAIM_BRAND]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    toJSON: {
      configurable: false,
      enumerable: false,
      value: () => {
        throw new TypeError("Invitation registration claims cannot be serialized.");
      },
      writable: false,
    },
  });
  return Object.freeze(claim);
}

export class InvitationService {
  readonly #config: AppConfig;
  readonly #createId: () => string;
  readonly #createHandoffToken: () => string;
  readonly #createToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #clock: () => Date;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: InvitationServiceDependencies = {},
  ) {
    this.#config = config;
    this.#createId = dependencies.createId ?? (() => randomToken(16));
    this.#createHandoffToken =
      dependencies.createHandoffToken ?? (() => randomToken(REGISTRATION_HANDOFF_TOKEN_BYTES));
    this.#createToken = dependencies.createToken ?? (() => randomToken(INVITATION_TOKEN_BYTES));
    this.#database = database;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  public create(
    input: InvitationCreateRequest,
    context: InvitationAdminContext,
  ): InvitationCreateResponse {
    this.#assertAdminContext(context);
    const parsed = invitationCreateRequestSchema.safeParse(input);
    if (!parsed.success) throw new InvitationServiceError("integrity_failure");
    const now = this.#currentTime();
    const ttlSeconds = parsed.data.expiresInSeconds ?? INVITATION_DEFAULT_TTL_SECONDS;
    const ttl = ttlSeconds * 1_000;
    if (
      ttlSeconds <= 0 ||
      ttlSeconds > INVITATION_MAX_TTL_SECONDS ||
      now.getTime() > Number.MAX_SAFE_INTEGER - ttl
    ) {
      throw new InvitationServiceError("integrity_failure");
    }
    const invitationId = this.#nextIdentifier("invite");
    const token = this.#nextToken();
    const createdAt = now.getTime();
    const expiresAt = createdAt + ttl;
    let result: InvitationCreateResponse | undefined;
    try {
      this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare(
              `insert into invitations (id, token_hash, expires_at, created_at)
               values (?, ?, ?, ?)`,
            )
            .run(invitationId, hashToken(token), expiresAt, createdAt);
          this.#insertAudit(
            "auth.invitation.created",
            invitationId,
            { lifetimeMs: ttl },
            context,
            now.getTime(),
          );
          result = invitationCreateResponseSchema.parse({
            invitation: presentInvitation(
              {
                consumedAt: null,
                createdAt,
                expiresAt,
                id: invitationId,
                revokedAt: null,
                registrationHandoffExpiresAt: null,
                registrationHandoffHash: null,
                tokenHash: hashToken(token),
              },
              createdAt,
            ),
            invitationUrl: this.#invitationUrl(token),
          });
        })
        .immediate();
    } catch (error) {
      if (error instanceof InvitationServiceError) throw error;
      throw new InvitationServiceError("storage_failure", { cause: error });
    }
    if (!result) throw new InvitationServiceError("integrity_failure");
    return result;
  }

  public list(input: InvitationListQuery, context: InvitationAdminContext): InvitationListResponse {
    this.#assertAdminContext(context);
    const parsed = invitationListQuerySchema.safeParse(input);
    if (!parsed.success) throw new InvitationServiceError("cursor_invalid");
    const now = this.#currentTime().getTime();
    try {
      let cursorCreatedAt: number | null = null;
      if (parsed.data.cursor !== undefined) {
        const cursor = this.#database.sqlite
          .prepare("select created_at as createdAt from invitations where id = ?")
          .get(parsed.data.cursor) as { createdAt: number } | undefined;
        if (!cursor || !validTimestamp(cursor.createdAt)) {
          throw new InvitationServiceError("cursor_invalid");
        }
        cursorCreatedAt = cursor.createdAt;
      }
      const rows = this.#database.sqlite
        .prepare(
          `select id, token_hash as tokenHash, expires_at as expiresAt,
                  consumed_at as consumedAt, revoked_at as revokedAt,
                  registration_handoff_hash as registrationHandoffHash,
                  registration_handoff_expires_at as registrationHandoffExpiresAt,
                  created_at as createdAt
           from invitations
           where @cursor is null
              or created_at > @cursorCreatedAt
              or (created_at = @cursorCreatedAt and id > @cursor)
           order by created_at asc, id asc
           limit @limit`,
        )
        .all({
          cursor: parsed.data.cursor ?? null,
          cursorCreatedAt,
          limit: 51,
        }) as InvitationRow[];
      const hasNextPage = rows.length > 50;
      const invitations = rows.slice(0, 50).map((row) => presentInvitation(row, now));
      return invitationListResponseSchema.parse({
        invitations,
        nextCursor: hasNextPage ? (invitations.at(-1)?.id ?? null) : null,
      });
    } catch (error) {
      if (error instanceof InvitationServiceError) throw error;
      throw new InvitationServiceError("storage_failure", { cause: error });
    }
  }

  public revoke(invitationId: string, context: InvitationAdminContext): InvitationRevokeResponse {
    this.#assertAdminContext(context);
    if (!validIdentifier(invitationId)) throw new InvitationServiceError("invitation_not_found");
    let result: InvitationRevokeResponse | undefined;
    try {
      this.#database.sqlite
        .transaction(() => {
          const now = this.#currentTime().getTime();
          const updated = this.#database.sqlite
            .prepare(
              `update invitations
               set revoked_at = ?, registration_handoff_hash = null,
                   registration_handoff_expires_at = null
               where id = ? and consumed_at is null and revoked_at is null
                 and expires_at > ?`,
            )
            .run(now, invitationId, now);
          if (updated.changes !== 1) {
            this.#throwCurrentState(invitationId, now);
          }
          this.#insertAudit("auth.invitation.revoked", invitationId, {}, context, now);
          const row = this.#read(invitationId);
          if (!row) throw new InvitationServiceError("integrity_failure");
          result = invitationRevokeResponseSchema.parse({
            invitation: presentInvitation(row, now),
          });
        })
        .immediate();
    } catch (error) {
      if (error instanceof InvitationServiceError) throw error;
      throw new InvitationServiceError("storage_failure", { cause: error });
    }
    if (!result) throw new InvitationServiceError("integrity_failure");
    return result;
  }

  /** Exchanges the invite bearer for an independent, short-lived browser handoff. */
  public exchangeForRegistrationHandoff(token: unknown) {
    const parsed = invitationExchangeRequestSchema.safeParse({ token });
    if (!parsed.success) throw new InvitationServiceError("registration_handoff_invalid");
    const decodedToken = decodeInvitationToken(parsed.data.token);
    if (!decodedToken) throw new InvitationServiceError("registration_handoff_invalid");
    const now = this.#currentTime().getTime();
    const handoffToken = this.#nextHandoffToken();
    let result: { expiresAt: Date; handoffToken: string; invitationId: string } | undefined;
    try {
      this.#database.sqlite
        .transaction(() => {
          const row = this.#readByTokenHash(hashToken(decodedToken));
          if (!row) throw new InvitationServiceError("registration_handoff_invalid");
          this.#assertExchangeable(row, now);
          const expiresAt = Math.min(row.expiresAt, now + REGISTRATION_HANDOFF_TTL_SECONDS * 1_000);
          const updated = this.#database.sqlite
            .prepare(
              `update invitations
               set registration_handoff_hash = ?, registration_handoff_expires_at = ?
               where id = ? and consumed_at is null and revoked_at is null and expires_at > ?`,
            )
            .run(hashToken(handoffToken), expiresAt, row.id, now);
          if (updated.changes !== 1)
            throw new InvitationServiceError("registration_handoff_invalid");
          result = { expiresAt: new Date(expiresAt), handoffToken, invitationId: row.id };
        })
        .immediate();
    } catch (error) {
      if (error instanceof InvitationServiceError) throw error;
      throw new InvitationServiceError("storage_failure", { cause: error });
    }
    if (!result) throw new InvitationServiceError("integrity_failure");
    return result;
  }

  /** Resolves the current handoff without consuming it. */
  public resolveRegistrationHandoff(
    input: InvitationRegistrationHandoffInput,
  ): InvitationRegistrationHandoff {
    const invitationId = input.invitationId;
    const handoffToken = decodeRegistrationHandoffToken(input.handoffToken);
    if (!validIdentifier(invitationId) || !handoffToken) {
      throw new InvitationServiceError("registration_handoff_invalid");
    }
    const now = this.#currentTime().getTime();
    const row = this.#database.sqlite
      .prepare(
        `select id, token_hash as tokenHash, expires_at as expiresAt,
                consumed_at as consumedAt, revoked_at as revokedAt,
                registration_handoff_hash as registrationHandoffHash,
                registration_handoff_expires_at as registrationHandoffExpiresAt,
                created_at as createdAt
         from invitations where id = ? and registration_handoff_hash = ?`,
      )
      .get(invitationId, hashToken(handoffToken)) as InvitationRow | undefined;
    if (!row || row.registrationHandoffExpiresAt === null) {
      throw new InvitationServiceError("registration_handoff_invalid");
    }
    this.#assertExchangeable(row, now);
    if (row.registrationHandoffExpiresAt <= now) {
      throw new InvitationServiceError("registration_handoff_invalid");
    }
    return createHandoff(row.id, row.registrationHandoffExpiresAt);
  }

  /**
   * Begins the trusted proof flow from the browser handoff alone. This is a
   * non-consuming lease renewal; the invitation id is returned only as
   * internal state for the caller that will bind it into its encrypted flow.
   */
  public beginRegistrationHandoff(handoffToken: unknown): InvitationRegistrationHandoff {
    const decodedToken = decodeRegistrationHandoffToken(handoffToken);
    if (!decodedToken) throw new InvitationServiceError("registration_handoff_invalid");
    const now = this.#currentTime().getTime();
    let result: InvitationRegistrationHandoff | undefined;
    try {
      this.#database.sqlite
        .transaction(() => {
          const row = this.#readByHandoffHash(hashToken(decodedToken));
          if (!row || row.registrationHandoffExpiresAt === null) {
            throw new InvitationServiceError("registration_handoff_invalid");
          }
          this.#assertExchangeable(row, now);
          if (row.registrationHandoffExpiresAt <= now) {
            throw new InvitationServiceError("registration_handoff_invalid");
          }
          const expiresAt = Math.min(row.expiresAt, now + REGISTRATION_HANDOFF_TTL_SECONDS * 1_000);
          const renewed = this.#database.sqlite
            .prepare(
              `update invitations
               set registration_handoff_expires_at = ?
               where id = ? and registration_handoff_hash = ?
                 and registration_handoff_expires_at > ? and consumed_at is null
                 and revoked_at is null and expires_at > ?`,
            )
            .run(expiresAt, row.id, hashToken(decodedToken), now, now);
          if (renewed.changes !== 1) {
            throw new InvitationServiceError("registration_handoff_invalid");
          }
          result = createHandoff(row.id, expiresAt);
        })
        .immediate();
    } catch (error) {
      if (error instanceof InvitationServiceError) throw error;
      throw new InvitationServiceError("storage_failure", { cause: error });
    }
    if (!result) throw new InvitationServiceError("integrity_failure");
    return result;
  }

  /**
   * Final proof-lane operation. Callers must already own the enclosing immediate
   * transaction; the guarded update is the one-way consumption CAS boundary.
   */
  public consumeRegistrationHandoffInExistingTransaction(
    input: InvitationRegistrationHandoffInput,
    context: InvitationRegistrationContext = {},
  ): InvitationRegistrationClaim {
    if (!this.#database.sqlite.inTransaction) throw new InvitationServiceError("storage_failure");
    if (
      !validOptionalText(context.ipAddress, MAX_IP_LENGTH) ||
      !validOptionalText(context.requestId, MAX_REQUEST_ID_LENGTH)
    ) {
      throw new InvitationServiceError("integrity_failure");
    }
    const invitationId = input.invitationId;
    const handoffToken = decodeRegistrationHandoffToken(input.handoffToken);
    if (!validIdentifier(invitationId) || !handoffToken) {
      throw new InvitationServiceError("registration_handoff_invalid");
    }
    const now = this.#currentTime().getTime();
    const consumed = this.#database.sqlite
      .prepare(
        `update invitations
         set consumed_at = ?, registration_handoff_hash = null,
             registration_handoff_expires_at = null
         where id = ? and registration_handoff_hash = ?
           and registration_handoff_expires_at > ? and consumed_at is null
           and revoked_at is null and expires_at > ?`,
      )
      .run(now, invitationId, hashToken(handoffToken), now, now);
    if (consumed.changes !== 1) throw new InvitationServiceError("registration_handoff_invalid");
    this.#insertAudit(
      "auth.invitation.consumed",
      invitationId,
      { handoff: true, registration: true },
      context,
      now,
    );
    return createClaim(invitationId, now);
  }

  #assertAdminContext(context: InvitationAdminContext) {
    const principal = context.principal;
    if (
      principal.accountState !== "active" ||
      principal.role !== "admin" ||
      principal.authenticationMethod.kind === "recovery" ||
      !principal.userId ||
      !validIdentifier(principal.userId) ||
      !validIdentifier(principal.sessionId) ||
      !validOptionalText(context.ipAddress, MAX_IP_LENGTH) ||
      !validOptionalText(context.requestId, MAX_REQUEST_ID_LENGTH) ||
      !principal.permissions.includes("identities.manage")
    ) {
      throw new InvitationServiceError("permission_denied");
    }
  }

  #currentTime() {
    let now: Date;
    try {
      now = this.#clock();
    } catch (error) {
      throw new InvitationServiceError("integrity_failure", { cause: error });
    }
    if (!(now instanceof Date) || !validTimestamp(now.getTime())) {
      throw new InvitationServiceError("integrity_failure");
    }
    return new Date(now.getTime());
  }

  #nextIdentifier(prefix: "audit" | "invite") {
    let suffix: string;
    try {
      suffix = this.#createId();
    } catch (error) {
      throw new InvitationServiceError("integrity_failure", { cause: error });
    }
    const identifier = `${prefix}_${suffix}`;
    if (!validIdentifier(identifier)) throw new InvitationServiceError("integrity_failure");
    return identifier;
  }

  #nextToken() {
    let token: string;
    try {
      token = this.#createToken();
    } catch (error) {
      throw new InvitationServiceError("integrity_failure", { cause: error });
    }
    if (!decodeInvitationToken(token)) throw new InvitationServiceError("integrity_failure");
    return token;
  }

  #nextHandoffToken() {
    let token: string;
    try {
      token = this.#createHandoffToken();
    } catch (error) {
      throw new InvitationServiceError("integrity_failure", { cause: error });
    }
    if (!decodeRegistrationHandoffToken(token)) {
      throw new InvitationServiceError("integrity_failure");
    }
    return token;
  }

  #invitationUrl(token: string) {
    const url = new URL(this.#config.baseUrl.toString());
    url.pathname = "/invite";
    url.hash = `invite=${token}`;
    return url.toString();
  }

  #readByTokenHash(tokenHash: string) {
    return this.#database.sqlite
      .prepare(
        `select id, token_hash as tokenHash, expires_at as expiresAt,
                consumed_at as consumedAt, revoked_at as revokedAt,
                registration_handoff_hash as registrationHandoffHash,
                registration_handoff_expires_at as registrationHandoffExpiresAt,
                created_at as createdAt
         from invitations where token_hash = ?`,
      )
      .get(tokenHash) as InvitationRow | undefined;
  }

  #readByHandoffHash(handoffHash: string) {
    return this.#database.sqlite
      .prepare(
        `select id, token_hash as tokenHash, expires_at as expiresAt,
                consumed_at as consumedAt, revoked_at as revokedAt,
                registration_handoff_hash as registrationHandoffHash,
                registration_handoff_expires_at as registrationHandoffExpiresAt,
                created_at as createdAt
         from invitations where registration_handoff_hash = ?`,
      )
      .get(handoffHash) as InvitationRow | undefined;
  }

  #assertExchangeable(row: InvitationRow, now: number) {
    if (row.consumedAt !== null || row.revokedAt !== null || row.expiresAt <= now) {
      throw new InvitationServiceError("registration_handoff_invalid");
    }
  }

  #read(invitationId: string) {
    return this.#database.sqlite
      .prepare(
        `select id, token_hash as tokenHash, expires_at as expiresAt,
                consumed_at as consumedAt, revoked_at as revokedAt,
                registration_handoff_hash as registrationHandoffHash,
                registration_handoff_expires_at as registrationHandoffExpiresAt,
                created_at as createdAt
         from invitations where id = ?`,
      )
      .get(invitationId) as InvitationRow | undefined;
  }

  #throwCurrentState(invitationId: string, now: number): never {
    const row = this.#read(invitationId);
    if (!row) throw new InvitationServiceError("invitation_not_found");
    if (row.consumedAt !== null) throw new InvitationServiceError("invitation_consumed");
    if (row.revokedAt !== null) throw new InvitationServiceError("invitation_revoked");
    if (row.expiresAt <= now) throw new InvitationServiceError("invitation_expired");
    throw new InvitationServiceError("storage_failure");
  }

  #insertAudit(
    eventType: string,
    targetId: string,
    metadata: Readonly<Record<string, boolean | number | string>>,
    context: InvitationAdminContext | InvitationRegistrationContext,
    occurredAt: number,
  ) {
    const isAdmin = "principal" in context;
    const principal = isAdmin ? context.principal : undefined;
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
          id, actor_user_id, session_id, actor_session_id, actor_auth_method,
          event_type, outcome, target_type, target_id, request_id, metadata_json, ip_hash, created_at
        ) values (?, ?, ?, ?, ?, ?, 'success', 'invitation', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#nextIdentifier("audit"),
        principal?.userId ?? null,
        principal?.sessionId ?? null,
        principal?.sessionId ?? null,
        principal?.authenticationMethod.kind ?? null,
        eventType,
        targetId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        occurredAt,
      );
  }
}
