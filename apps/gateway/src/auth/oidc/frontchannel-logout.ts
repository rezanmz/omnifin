import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { privacyHash } from "../../security/crypto.js";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ISSUER_BYTES = 2_048;
const MAX_SESSION_ID_BYTES = 512;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

export type OidcFrontchannelLogoutErrorCode = "invalid_logout_request" | "logout_storage_failed";

const ERROR_MESSAGES: Readonly<Record<OidcFrontchannelLogoutErrorCode, string>> = Object.freeze({
  invalid_logout_request: "The front-channel logout request is invalid.",
  logout_storage_failed: "The front-channel logout could not be persisted.",
});

/** A context-free error that never retains provider session identifiers. */
export class OidcFrontchannelLogoutError extends Error {
  public readonly code: OidcFrontchannelLogoutErrorCode;

  public constructor(code: OidcFrontchannelLogoutErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OidcFrontchannelLogoutError";
    this.code = code;
    Object.freeze(this);
  }
}

export interface OidcFrontchannelLogoutDependencies {
  readonly clock?: () => Date;
  readonly createId?: () => string;
}

export interface ProcessOidcFrontchannelLogoutInput {
  readonly issuer: unknown;
  readonly providerId: unknown;
  readonly requestId?: unknown;
  readonly sessionId: unknown;
}

export interface ProcessedOidcFrontchannelLogout {
  readonly disposition: "accepted" | "replayed";
  readonly frameAncestorOrigin: string;
  readonly revokedSessionCount: number;
}

function logoutError(code: OidcFrontchannelLogoutErrorCode) {
  return new OidcFrontchannelLogoutError(code);
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function operationTime(clock: () => Date) {
  let value: Date;
  try {
    value = clock();
  } catch {
    throw logoutError("logout_storage_failed");
  }
  if (!(value instanceof Date)) throw logoutError("logout_storage_failed");
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMESTAMP_MS) {
    throw logoutError("logout_storage_failed");
  }
  return new Date(milliseconds);
}

function validateInput(input: ProcessOidcFrontchannelLogoutInput) {
  if (
    typeof input.providerId !== "string" ||
    !PROVIDER_ID_PATTERN.test(input.providerId) ||
    !boundedString(input.issuer, MAX_ISSUER_BYTES) ||
    !boundedString(input.sessionId, MAX_SESSION_ID_BYTES) ||
    (input.requestId !== undefined &&
      (typeof input.requestId !== "string" || !SAFE_IDENTIFIER_PATTERN.test(input.requestId)))
  ) {
    throw logoutError("invalid_logout_request");
  }
  return Object.freeze({
    issuer: input.issuer,
    providerId: input.providerId,
    requestId: typeof input.requestId === "string" ? input.requestId : null,
    sessionId: input.sessionId,
  });
}

function validatedProviderOrigin(storedIssuer: string, requestIssuer: string) {
  if (storedIssuer !== requestIssuer) throw logoutError("invalid_logout_request");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(storedIssuer);
  } catch {
    throw logoutError("invalid_logout_request");
  }
  if (
    issuerUrl.protocol !== "https:" ||
    issuerUrl.username !== "" ||
    issuerUrl.password !== "" ||
    issuerUrl.search !== "" ||
    issuerUrl.hash !== "" ||
    issuerUrl.href !== storedIssuer
  ) {
    throw logoutError("invalid_logout_request");
  }
  return issuerUrl.origin;
}

export class OidcFrontchannelLogoutService {
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #privacyKey: Buffer;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: OidcFrontchannelLogoutDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#privacyKey = Buffer.from(config.encryptionKey);
  }

  public process(input: ProcessOidcFrontchannelLogoutInput): ProcessedOidcFrontchannelLogout {
    const request = validateInput(input);
    const now = operationTime(this.#clock);

    try {
      const provider = this.#database.sqlite
        .prepare("select issuer from oidc_providers where id = ? and enabled = 1")
        .get(request.providerId) as { issuer: string } | undefined;
      if (!provider) throw logoutError("invalid_logout_request");
      const frameAncestorOrigin = validatedProviderOrigin(provider.issuer, request.issuer);
      const sessionIdHash = privacyHash("oidc_session_id", request.sessionId, this.#privacyKey);
      const transaction = this.#database.sqlite.transaction(() => {
        const revoked = this.#database.sqlite
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
        if (revoked.length === 0) {
          return Object.freeze({
            disposition: "replayed" as const,
            frameAncestorOrigin,
            revokedSessionCount: 0,
          });
        }

        const auditId = this.#createId();
        if (!SAFE_IDENTIFIER_PATTERN.test(auditId)) throw logoutError("logout_storage_failed");
        this.#database.sqlite
          .prepare(
            `insert into audit_events (
               id, event_type, outcome, target_type, target_id,
               request_id, metadata_json, created_at
             ) values (?, 'auth.oidc.frontchannel_logout', 'success', 'oidc_provider', ?, ?, ?, ?)`,
          )
          .run(
            auditId,
            request.providerId,
            request.requestId,
            JSON.stringify({
              reason: "provider_initiated_logout",
              scope: "session",
              revokedSessionCount: revoked.length,
            }),
            now.getTime(),
          );
        return Object.freeze({
          disposition: "accepted" as const,
          frameAncestorOrigin,
          revokedSessionCount: revoked.length,
        });
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof OidcFrontchannelLogoutError) throw error;
      throw logoutError("logout_storage_failed");
    }
  }
}
