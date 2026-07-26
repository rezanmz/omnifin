import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { privacyHash } from "../../security/crypto.js";
import {
  OidcProviderRegistry,
  OidcProviderRegistryError,
  verifyOidcRuntimeBackchannelLogoutToken,
  type OidcProviderRegistryDependencies,
} from "./provider-registry.js";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_LOGOUT_TOKEN_BYTES = 32 * 1_024;
const MAX_LOGOUT_CLAIM_LENGTH = 512;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

export type OidcBackchannelLogoutErrorCode =
  "invalid_logout_request" | "invalid_logout_token" | "logout_storage_failed";

const ERROR_MESSAGES: Readonly<Record<OidcBackchannelLogoutErrorCode, string>> = Object.freeze({
  invalid_logout_request: "The back-channel logout request is invalid.",
  invalid_logout_token: "The back-channel logout token could not be verified.",
  logout_storage_failed: "The back-channel logout could not be persisted.",
});

/** A context-free error that never retains provider assertions or identifiers. */
export class OidcBackchannelLogoutError extends Error {
  public readonly code: OidcBackchannelLogoutErrorCode;

  public constructor(code: OidcBackchannelLogoutErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OidcBackchannelLogoutError";
    this.code = code;
    Object.freeze(this);
  }
}

export interface VerifiedOidcBackchannelLogoutToken {
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  readonly issuer: string;
  readonly sessionId?: string;
  readonly subject?: string;
  readonly tokenId: string;
}

export interface OidcBackchannelLogoutDependencies {
  readonly clock?: () => Date;
  readonly createId?: () => string;
  readonly providerRegistry?: OidcProviderRegistryDependencies;
  readonly verifyLogoutToken?: (
    providerId: string,
    logoutToken: string,
    currentTime: Date,
  ) => Promise<VerifiedOidcBackchannelLogoutToken>;
}

export interface ProcessOidcBackchannelLogoutInput {
  readonly logoutToken: unknown;
  readonly providerId: unknown;
  readonly requestId?: unknown;
}

export interface ProcessedOidcBackchannelLogout {
  readonly disposition: "accepted" | "replayed";
  readonly revokedSessionCount: number;
}

interface ValidatedLogoutToken {
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly issuer: string;
  readonly sessionId: string | null;
  readonly subject: string | null;
  readonly tokenIdHash: string;
}

function logoutError(code: OidcBackchannelLogoutErrorCode): OidcBackchannelLogoutError {
  return new OidcBackchannelLogoutError(code);
}

function boundedClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LOGOUT_CLAIM_LENGTH
    ? value
    : null;
}

function validDateMilliseconds(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  const milliseconds = value.getTime();
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_TIMESTAMP_MS
    ? milliseconds
    : null;
}

function currentTime(clock: () => Date): Date {
  const value = clock();
  const milliseconds = validDateMilliseconds(value);
  if (milliseconds === null) throw logoutError("logout_storage_failed");
  return new Date(milliseconds);
}

function validateVerifiedToken(
  value: unknown,
  expectedIssuer: string,
  operationTime: Date,
): ValidatedLogoutToken {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw logoutError("invalid_logout_token");
  }
  const candidate = value as Partial<VerifiedOidcBackchannelLogoutToken>;
  const issuedAt = validDateMilliseconds(candidate.issuedAt);
  const expiresAt = validDateMilliseconds(candidate.expiresAt);
  const subject = candidate.subject === undefined ? null : boundedClaim(candidate.subject);
  const sessionId = candidate.sessionId === undefined ? null : boundedClaim(candidate.sessionId);
  const tokenId = boundedClaim(candidate.tokenId);
  const now = operationTime.getTime();
  if (
    candidate.issuer !== expectedIssuer ||
    issuedAt === null ||
    expiresAt === null ||
    tokenId === null ||
    (subject === null && sessionId === null) ||
    (candidate.subject !== undefined && subject === null) ||
    (candidate.sessionId !== undefined && sessionId === null) ||
    issuedAt < now - MAX_CLOCK_SKEW_MS ||
    issuedAt > now + MAX_CLOCK_SKEW_MS ||
    expiresAt <= now ||
    expiresAt <= issuedAt
  ) {
    throw logoutError("invalid_logout_token");
  }
  return Object.freeze({
    expiresAt,
    issuedAt,
    issuer: expectedIssuer,
    sessionId,
    subject,
    tokenIdHash: createHash("sha256").update(tokenId, "utf8").digest("base64url"),
  });
}

function validateRequest(input: ProcessOidcBackchannelLogoutInput) {
  if (
    typeof input.providerId !== "string" ||
    !PROVIDER_ID_PATTERN.test(input.providerId) ||
    typeof input.logoutToken !== "string" ||
    Buffer.byteLength(input.logoutToken, "utf8") > MAX_LOGOUT_TOKEN_BYTES ||
    !COMPACT_JWS_PATTERN.test(input.logoutToken) ||
    (input.requestId !== undefined &&
      (typeof input.requestId !== "string" || !SAFE_IDENTIFIER_PATTERN.test(input.requestId)))
  ) {
    throw logoutError("invalid_logout_request");
  }
  return Object.freeze({
    logoutToken: input.logoutToken,
    providerId: input.providerId,
    requestId: typeof input.requestId === "string" ? input.requestId : null,
  });
}

export class OidcBackchannelLogoutService {
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #privacyKey: Buffer;
  readonly #verifyLogoutToken: NonNullable<OidcBackchannelLogoutDependencies["verifyLogoutToken"]>;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: OidcBackchannelLogoutDependencies,
  ) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#privacyKey = Buffer.from(config.encryptionKey);
    if (dependencies.verifyLogoutToken) {
      this.#verifyLogoutToken = dependencies.verifyLogoutToken;
    } else {
      const providerRegistry = new OidcProviderRegistry(
        database,
        config,
        dependencies.providerRegistry,
      );
      this.#verifyLogoutToken = async (providerId, logoutToken, operationTime) =>
        verifyOidcRuntimeBackchannelLogoutToken(
          await providerRegistry.discover(providerId),
          logoutToken,
          operationTime,
        );
    }
  }

  public async process(
    input: ProcessOidcBackchannelLogoutInput,
  ): Promise<ProcessedOidcBackchannelLogout> {
    const request = validateRequest(input);
    const now = currentTime(this.#clock);
    const provider = this.#database.sqlite
      .prepare("select issuer from oidc_providers where id = ? and enabled = 1")
      .get(request.providerId) as { issuer: string } | undefined;
    if (!provider) throw logoutError("invalid_logout_request");

    let verified: unknown;
    try {
      verified = await this.#verifyLogoutToken(
        request.providerId,
        request.logoutToken,
        new Date(now),
      );
    } catch (error) {
      if (error instanceof OidcProviderRegistryError && error.retryable) {
        throw logoutError("logout_storage_failed");
      }
      throw logoutError("invalid_logout_token");
    }
    const token = validateVerifiedToken(verified, provider.issuer, now);

    try {
      const transaction = this.#database.sqlite.transaction(() => {
        this.#database.sqlite
          .prepare("delete from oidc_logout_receipts where expires_at <= ?")
          .run(now.getTime());
        const replay = this.#database.sqlite
          .prepare(
            "select 1 from oidc_logout_receipts where provider_id = ? and jti_hash = ? limit 1",
          )
          .get(request.providerId, token.tokenIdHash);
        if (replay) {
          return Object.freeze({
            disposition: "replayed" as const,
            revokedSessionCount: 0,
          });
        }

        this.#database.sqlite
          .prepare(
            `insert into oidc_logout_receipts (
               provider_id, jti_hash, issued_at, expires_at, received_at
             ) values (?, ?, ?, ?, ?)`,
          )
          .run(
            request.providerId,
            token.tokenIdHash,
            token.issuedAt,
            token.expiresAt,
            now.getTime(),
          );

        const sessionIdHash =
          token.sessionId === null
            ? null
            : privacyHash("oidc_session_id", token.sessionId, this.#privacyKey);
        let revoked: unknown[];
        if (sessionIdHash !== null && token.subject !== null) {
          revoked = this.#database.sqlite
            .prepare(
              `update sessions
               set revoked_at = max(@now, created_at)
               where id in (
                 select s.id
                 from sessions s
                 join external_identities e on e.id = s.external_identity_id
                 where s.auth_method = 'oidc'
                   and s.oidc_provider_id = @providerId
                   and s.oidc_session_id_hash = @sessionIdHash
                   and e.issuer = @issuer
                   and e.subject = @subject
                   and s.revoked_at is null
                   and s.created_at <= @now
               )
               returning id`,
            )
            .all({
              issuer: token.issuer,
              now: now.getTime(),
              providerId: request.providerId,
              sessionIdHash,
              subject: token.subject,
            });
        } else if (sessionIdHash !== null) {
          revoked = this.#database.sqlite
            .prepare(
              `update sessions
               set revoked_at = max(@now, created_at)
               where auth_method = 'oidc'
                 and oidc_provider_id = @providerId
                 and oidc_session_id_hash = @sessionIdHash
                 and revoked_at is null
                 and created_at <= @now
               returning id`,
            )
            .all({ now: now.getTime(), providerId: request.providerId, sessionIdHash });
        } else {
          revoked = this.#database.sqlite
            .prepare(
              `update sessions
               set revoked_at = max(@now, created_at)
               where id in (
                 select s.id
                 from sessions s
                 join external_identities e on e.id = s.external_identity_id
                 where s.auth_method = 'oidc'
                   and s.oidc_provider_id = @providerId
                   and e.issuer = @issuer
                   and e.subject = @subject
                   and s.revoked_at is null
                   and s.created_at <= @now
               )
               returning id`,
            )
            .all({
              issuer: token.issuer,
              now: now.getTime(),
              providerId: request.providerId,
              subject: token.subject,
            });
        }

        const auditId = this.#createId();
        if (!SAFE_IDENTIFIER_PATTERN.test(auditId)) throw logoutError("logout_storage_failed");
        this.#database.sqlite
          .prepare(
            `insert into audit_events (
               id, event_type, outcome, target_type, target_id,
               request_id, metadata_json, created_at
             ) values (?, 'auth.oidc.backchannel_logout', 'success', 'oidc_provider', ?, ?, ?, ?)`,
          )
          .run(
            auditId,
            request.providerId,
            request.requestId,
            JSON.stringify({
              reason: "provider_initiated_logout",
              scope: sessionIdHash === null ? "subject" : "session",
              revokedSessionCount: revoked.length,
            }),
            now.getTime(),
          );
        return Object.freeze({
          disposition: "accepted" as const,
          revokedSessionCount: revoked.length,
        });
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof OidcBackchannelLogoutError) throw error;
      throw logoutError("logout_storage_failed");
    }
  }
}
