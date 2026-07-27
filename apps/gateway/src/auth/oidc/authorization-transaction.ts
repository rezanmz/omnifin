import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier } from "openid-client";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { TextDecoder } from "node:util";
import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import { EnvelopeCipher, hashToken, randomToken } from "../../security/crypto.js";
import type { OidcProviderRuntimeBinding } from "./provider-registry.js";

export const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1_000;
export const OIDC_BROWSER_BINDING_COOKIE_NAME = "__Host-omnifin_oidc_binding";
export const LOCAL_OIDC_BROWSER_BINDING_COOKIE_NAME = "omnifin_local_oidc_binding";
const OIDC_TRANSACTION_BINDING_COOKIE_PREFIX = "__Host-omnifin_oidc_tx_";
const LOCAL_OIDC_TRANSACTION_BINDING_COOKIE_PREFIX = "omnifin_local_oidc_tx_";
// Sixteen active tabs is deliberately generous for one browser. The larger
// ceiling counts every physical, unexpired row—including consumed tombstones—so
// callback churn cannot grow the ten-minute unauthenticated write set without bound.
export const OIDC_AUTHORIZATION_TRANSACTION_ACTIVE_PER_BROWSER_LIMIT = 16;
export const OIDC_AUTHORIZATION_TRANSACTION_UNEXPIRED_ROW_LIMIT = 1_024;

const MAX_GENERATION_ATTEMPTS = 8;
const MAX_CLEANUP_BATCH_SIZE = 256;
const DEFAULT_CLEANUP_BATCH_SIZE = 64;
const MAX_RETURN_PATH_LENGTH = 2_048;
const MAX_REDIRECT_URI_LENGTH = 2_048;
const OPAQUE_256_BIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PKCE_CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MALFORMED_PERCENT_ENCODING_PATTERN = /%(?![A-Fa-f0-9]{2})/;
const PERCENT_ENCODED_BYTE_RUN_PATTERN = /(?:%[A-Fa-f0-9]{2})+/g;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type OidcAuthorizationTransactionConfig = Pick<
  AppConfig,
  "baseUrl" | "encryptionKey" | "environment" | "insecureLoopbackPreview" | "secureCookies"
>;

export type OidcAuthorizationTransactionErrorCode =
  "oidc_transaction_invalid" | "oidc_transaction_unavailable";

export class OidcAuthorizationTransactionError extends Error {
  public readonly code: OidcAuthorizationTransactionErrorCode;

  public constructor(code: OidcAuthorizationTransactionErrorCode) {
    super(
      code === "oidc_transaction_invalid"
        ? "The authentication attempt is invalid or has expired."
        : "Authentication could not be started.",
    );
    this.name = "OidcAuthorizationTransactionError";
    this.code = code;
  }
}

export interface OidcAuthorizationTransactionDependencies {
  calculateCodeChallenge?: (codeVerifier: string) => Promise<string>;
  clock?: () => Date;
  createBrowserBinding?: () => string;
  createCodeVerifier?: () => string;
  createId?: () => string;
  createNonce?: () => string;
  createState?: () => string;
}

export interface CreateOidcAuthorizationTransactionInput {
  browserBindingToken?: string;
  providerId: string;
  providerRuntimeBinding: OidcProviderRuntimeBinding;
  returnPath?: string;
}

export interface CreatedOidcAuthorizationTransaction {
  browserBindingToken: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: Date;
  nonce: string;
  providerId: string;
  providerRuntimeBinding: OidcProviderRuntimeBinding;
  redirectUri: string;
  returnPath: string;
  state: string;
}

export interface ConsumeOidcAuthorizationTransactionInput {
  browserBindingToken: string;
  providerId: string;
  state: string;
}

export type CancelOidcAuthorizationTransactionInput = ConsumeOidcAuthorizationTransactionInput;

export interface ConsumedOidcAuthorizationTransaction {
  codeVerifier: string;
  createdAt: Date;
  expiresAt: Date;
  expectedState: string;
  nonce: string;
  providerId: string;
  providerRuntimeBinding: OidcProviderRuntimeBinding;
  redirectUri: string;
  returnPath: string;
  transactionId: string;
}

export interface OidcBrowserBindingCookieWriter {
  setCookie: (
    name: string,
    value: string,
    options: {
      expires: Date;
      httpOnly: true;
      path: "/";
      sameSite: "lax";
      secure: boolean;
    },
  ) => unknown;
}

export interface OidcTransactionBindingCookieClearer {
  clearCookie: (
    name: string,
    options: {
      httpOnly: true;
      path: "/";
      sameSite: "lax";
      secure: boolean;
    },
  ) => unknown;
}

interface StoredOidcAuthorizationTransaction {
  createdAt: number;
  encryptedCodeVerifier: string;
  encryptedNonce: string;
  expiresAt: number;
  id: string;
  providerId: string;
  redirectUri: string;
  returnPath: string;
}

interface EncryptedOidcAuthorizationTransactionPayload {
  readonly nonce: string;
  readonly providerId: string;
  readonly providerRuntimeBinding: OidcProviderRuntimeBinding;
  readonly schemaVersion: 1;
}

function invalidTransaction(): never {
  throw new OidcAuthorizationTransactionError("oidc_transaction_invalid");
}

function unavailableTransaction(): never {
  throw new OidcAuthorizationTransactionError("oidc_transaction_unavailable");
}

function isCanonical256BitToken(value: unknown): value is string {
  if (typeof value !== "string" || !OPAQUE_256_BIT_TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function validProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function validCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && PKCE_CODE_VERIFIER_PATTERN.test(value);
}

function validRuntimeBinding(value: unknown): value is OidcProviderRuntimeBinding {
  return isCanonical256BitToken(value);
}

function currentTime(clock: () => Date) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) unavailableTransaction();
  return new Date(now);
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)]$/, "$1")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  return family === 6 && normalized === "::1";
}

function assertCookieConfiguration(config: OidcAuthorizationTransactionConfig) {
  const baseUrl = config.baseUrl;
  if (
    !(baseUrl instanceof URL) ||
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    unavailableTransaction();
  }
  if (
    (config.secureCookies && baseUrl.protocol !== "https:") ||
    (!config.secureCookies &&
      (baseUrl.protocol !== "http:" ||
        !isLoopbackHostname(baseUrl.hostname) ||
        (config.environment === "production" && config.insecureLoopbackPreview !== true)))
  ) {
    unavailableTransaction();
  }
}

export function oidcBrowserBindingCookieName(config: Pick<AppConfig, "secureCookies">) {
  return config.secureCookies
    ? OIDC_BROWSER_BINDING_COOKIE_NAME
    : LOCAL_OIDC_BROWSER_BINDING_COOKIE_NAME;
}

export function oidcTransactionBindingCookieName(
  config: Pick<AppConfig, "secureCookies">,
  state: string,
) {
  if (!isCanonical256BitToken(state)) invalidTransaction();
  const prefix = config.secureCookies
    ? OIDC_TRANSACTION_BINDING_COOKIE_PREFIX
    : LOCAL_OIDC_TRANSACTION_BINDING_COOKIE_PREFIX;
  return `${prefix}${state}`;
}

function oidcBrowserBindingCookieOptions(
  config: Pick<AppConfig, "secureCookies">,
  expiresAt: Date,
) {
  return {
    expires: expiresAt,
    httpOnly: true as const,
    path: "/" as const,
    sameSite: "lax" as const,
    secure: config.secureCookies,
  };
}

export function writeOidcBrowserBindingCookie(
  reply: OidcBrowserBindingCookieWriter,
  config: OidcAuthorizationTransactionConfig,
  browserBindingToken: string,
  expiresAt: Date,
) {
  assertCookieConfiguration(config);
  if (
    !isCanonical256BitToken(browserBindingToken) ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    unavailableTransaction();
  }
  reply.setCookie(
    oidcBrowserBindingCookieName(config),
    browserBindingToken,
    oidcBrowserBindingCookieOptions(config, expiresAt),
  );
}

export function writeOidcTransactionBindingCookie(
  reply: OidcBrowserBindingCookieWriter,
  config: OidcAuthorizationTransactionConfig,
  state: string,
  browserBindingToken: string,
  expiresAt: Date,
) {
  assertCookieConfiguration(config);
  if (
    !isCanonical256BitToken(browserBindingToken) ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    unavailableTransaction();
  }
  reply.setCookie(
    oidcTransactionBindingCookieName(config, state),
    browserBindingToken,
    oidcBrowserBindingCookieOptions(config, expiresAt),
  );
}

export function clearOidcTransactionBindingCookie(
  reply: OidcTransactionBindingCookieClearer,
  config: OidcAuthorizationTransactionConfig,
  state: string,
) {
  assertCookieConfiguration(config);
  reply.clearCookie(oidcTransactionBindingCookieName(config, state), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies,
  });
}

export function canonicalOidcCallbackUri(baseUrl: URL, providerId: string) {
  if (!validProviderId(providerId)) invalidTransaction();
  if (
    !(baseUrl instanceof URL) ||
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    unavailableTransaction();
  }
  const callback = new URL(
    `/api/auth/oidc/callback/${encodeURIComponent(providerId)}`,
    baseUrl.origin,
  ).toString();
  if (callback.length > MAX_REDIRECT_URI_LENGTH) unavailableTransaction();
  return callback;
}

function assertSafeReturnPathLayer(value: string) {
  if (
    value.length === 0 ||
    value.length > MAX_RETURN_PATH_LENGTH ||
    value[0] !== "/" ||
    value.startsWith("//") ||
    value.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    invalidTransaction();
  }
}

function decodePercentEncodedLayer(value: string) {
  return value.replace(PERCENT_ENCODED_BYTE_RUN_PATTERN, (encodedRun) => {
    const bytes = Buffer.from(encodedRun.replaceAll("%", ""), "hex");
    try {
      return UTF8_DECODER.decode(bytes);
    } catch {
      invalidTransaction();
    }
  });
}

export function canonicalLocalReturnPath(value: unknown = "/") {
  if (typeof value !== "string") invalidTransaction();
  if (MALFORMED_PERCENT_ENCODING_PATTERN.test(value)) invalidTransaction();
  let layer = value;
  assertSafeReturnPathLayer(layer);
  for (
    let remainingDecodingLayers = value.length;
    remainingDecodingLayers > 0;
    remainingDecodingLayers -= 1
  ) {
    const decodedLayer = decodePercentEncodedLayer(layer);
    if (decodedLayer === layer) return value;
    if (decodedLayer.length >= layer.length) invalidTransaction();
    assertSafeReturnPathLayer(decodedLayer);
    layer = decodedLayer;
  }
  invalidTransaction();
}

function codeVerifierContext(transactionId: string) {
  return `oidc-transaction:${transactionId}:code-verifier`;
}

function nonceContext(transactionId: string) {
  return `oidc-transaction:${transactionId}:nonce`;
}

function serializeEncryptedTransactionPayload(
  nonce: string,
  providerId: string,
  providerRuntimeBinding: OidcProviderRuntimeBinding,
) {
  return JSON.stringify({ nonce, providerId, providerRuntimeBinding, schemaVersion: 1 });
}

function parseEncryptedTransactionPayload(
  plaintext: string,
): EncryptedOidcAuthorizationTransactionPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext) as unknown;
  } catch {
    invalidTransaction();
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype ||
    Object.keys(payload).sort().join(",") !==
      "nonce,providerId,providerRuntimeBinding,schemaVersion"
  ) {
    invalidTransaction();
  }
  const candidate = payload as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !isCanonical256BitToken(candidate.nonce) ||
    !validProviderId(candidate.providerId) ||
    !validRuntimeBinding(candidate.providerRuntimeBinding)
  ) {
    invalidTransaction();
  }
  return candidate as unknown as EncryptedOidcAuthorizationTransactionPayload;
}

export class OidcAuthorizationTransactionService {
  private readonly baseUrl: URL;
  private readonly calculateCodeChallenge: (codeVerifier: string) => Promise<string>;
  private readonly cipher: EnvelopeCipher;
  private readonly clock: () => Date;
  private readonly createBrowserBinding: () => string;
  private readonly createCodeVerifier: () => string;
  private readonly createId: () => string;
  private readonly createNonce: () => string;
  private readonly createState: () => string;
  private readonly database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: OidcAuthorizationTransactionConfig,
    dependencies: OidcAuthorizationTransactionDependencies = {},
  ) {
    assertCookieConfiguration(config);
    this.baseUrl = new URL(config.baseUrl.toString());
    this.calculateCodeChallenge = dependencies.calculateCodeChallenge ?? calculatePKCECodeChallenge;
    this.cipher = new EnvelopeCipher(config.encryptionKey);
    this.clock = dependencies.clock ?? (() => new Date());
    this.createBrowserBinding = dependencies.createBrowserBinding ?? (() => randomToken(32));
    this.createCodeVerifier = dependencies.createCodeVerifier ?? randomPKCECodeVerifier;
    this.createId = dependencies.createId ?? randomUUID;
    this.createNonce = dependencies.createNonce ?? randomNonce;
    this.createState = dependencies.createState ?? (() => randomToken(32));
    this.database = database;
  }

  public async create(
    input: CreateOidcAuthorizationTransactionInput,
  ): Promise<CreatedOidcAuthorizationTransaction> {
    if (
      !input ||
      typeof input !== "object" ||
      !validProviderId(input.providerId) ||
      !validRuntimeBinding(input.providerRuntimeBinding)
    ) {
      invalidTransaction();
    }
    const returnPath = canonicalLocalReturnPath(
      input.returnPath === undefined ? "/" : input.returnPath,
    );
    const now = currentTime(this.clock);
    const expiresAt = new Date(now.getTime() + OIDC_TRANSACTION_TTL_MS);
    const redirectUri = canonicalOidcCallbackUri(this.baseUrl, input.providerId);
    const browserBindingToken = isCanonical256BitToken(input.browserBindingToken)
      ? input.browserBindingToken
      : this.createBrowserBinding();
    if (!isCanonical256BitToken(browserBindingToken)) unavailableTransaction();

    this.cleanupExpired(DEFAULT_CLEANUP_BATCH_SIZE, now);
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const transactionId = this.createId();
      const state = this.createState();
      const codeVerifier = this.createCodeVerifier();
      const nonce = this.createNonce();
      if (
        !validProviderId(transactionId) ||
        !isCanonical256BitToken(state) ||
        !validCodeVerifier(codeVerifier) ||
        !isCanonical256BitToken(nonce)
      ) {
        unavailableTransaction();
      }

      let codeChallenge: string;
      try {
        codeChallenge = await this.calculateCodeChallenge(codeVerifier);
      } catch {
        unavailableTransaction();
      }
      if (!isCanonical256BitToken(codeChallenge)) unavailableTransaction();

      const insertion = this.insert({
        browserBindingHash: hashToken(browserBindingToken),
        createdAt: now.getTime(),
        encryptedCodeVerifier: this.cipher.encrypt(
          codeVerifier,
          codeVerifierContext(transactionId),
        ),
        encryptedNonce: this.cipher.encrypt(
          serializeEncryptedTransactionPayload(
            nonce,
            input.providerId,
            input.providerRuntimeBinding,
          ),
          nonceContext(transactionId),
        ),
        expiresAt: expiresAt.getTime(),
        id: transactionId,
        providerId: input.providerId,
        redirectUri,
        returnPath,
        stateHash: hashToken(state),
      });
      if (insertion === "capacity") unavailableTransaction();
      if (insertion === "collision") continue;

      return {
        browserBindingToken,
        codeChallenge,
        codeChallengeMethod: "S256",
        expiresAt,
        nonce,
        providerId: input.providerId,
        providerRuntimeBinding: input.providerRuntimeBinding,
        redirectUri,
        returnPath,
        state,
      };
    }

    unavailableTransaction();
  }

  public consume(
    input: ConsumeOidcAuthorizationTransactionInput,
  ): ConsumedOidcAuthorizationTransaction {
    if (
      !input ||
      typeof input !== "object" ||
      !validProviderId(input.providerId) ||
      !isCanonical256BitToken(input.state) ||
      !isCanonical256BitToken(input.browserBindingToken)
    ) {
      invalidTransaction();
    }
    const now = currentTime(this.clock);
    const browserBindingHash = hashToken(input.browserBindingToken);
    const stateHash = hashToken(input.state);
    let row: StoredOidcAuthorizationTransaction | undefined;
    try {
      row = this.database.sqlite.transaction(() => {
        const parameters = {
          browserBindingHash,
          now: now.getTime(),
          providerId: input.providerId,
          stateHash,
        };
        const claimed = this.database.sqlite
          .prepare(
            `update auth_transactions
             set consumed_at = @now
             where provider_id = @providerId
               and state_hash = @stateHash
               and browser_binding_hash = @browserBindingHash
               and consumed_at is null
               and created_at <= @now
               and expires_at > @now
             returning
               id,
               provider_id as providerId,
               encrypted_code_verifier as encryptedCodeVerifier,
               encrypted_nonce as encryptedNonce,
               redirect_uri as redirectUri,
               return_path as returnPath,
               created_at as createdAt,
               expires_at as expiresAt`,
          )
          .get(parameters) as StoredOidcAuthorizationTransaction | undefined;
        if (claimed) return claimed;

        this.database.sqlite
          .prepare(
            `delete from auth_transactions
             where provider_id = @providerId
               and state_hash = @stateHash
               and browser_binding_hash = @browserBindingHash
               and consumed_at is null
               and (created_at > @now or expires_at <= @now)`,
          )
          .run(parameters);
        return undefined;
      })();
    } catch {
      invalidTransaction();
    }
    if (!row) invalidTransaction();

    // Decrypt only after the atomic update has committed. Authentication-tag
    // failures therefore cannot make a compromised transaction replayable.
    let codeVerifier: string;
    let encryptedPayload: EncryptedOidcAuthorizationTransactionPayload;
    try {
      codeVerifier = this.cipher.decrypt(row.encryptedCodeVerifier, codeVerifierContext(row.id));
      encryptedPayload = parseEncryptedTransactionPayload(
        this.cipher.decrypt(row.encryptedNonce, nonceContext(row.id)),
      );
    } catch {
      invalidTransaction();
    }
    if (
      !validCodeVerifier(codeVerifier) ||
      encryptedPayload.providerId !== input.providerId ||
      row.providerId !== input.providerId ||
      row.redirectUri !== canonicalOidcCallbackUri(this.baseUrl, row.providerId)
    ) {
      invalidTransaction();
    }
    const returnPath = canonicalLocalReturnPath(row.returnPath);
    if (
      !Number.isSafeInteger(row.createdAt) ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.createdAt > now.getTime() ||
      row.expiresAt <= now.getTime() ||
      row.createdAt >= row.expiresAt
    ) {
      invalidTransaction();
    }

    return {
      codeVerifier,
      createdAt: new Date(row.createdAt),
      expiresAt: new Date(row.expiresAt),
      expectedState: input.state,
      nonce: encryptedPayload.nonce,
      providerId: row.providerId,
      providerRuntimeBinding: encryptedPayload.providerRuntimeBinding,
      redirectUri: row.redirectUri,
      returnPath,
      transactionId: row.id,
    };
  }

  /** Removes only the exact unconsumed transaction created for a failed start. */
  public cancel(input: CancelOidcAuthorizationTransactionInput): boolean {
    if (
      !input ||
      typeof input !== "object" ||
      !validProviderId(input.providerId) ||
      !isCanonical256BitToken(input.state) ||
      !isCanonical256BitToken(input.browserBindingToken)
    ) {
      invalidTransaction();
    }
    try {
      const deleted = this.database.sqlite
        .prepare(
          `delete from auth_transactions
           where provider_id = @providerId
             and state_hash = @stateHash
             and browser_binding_hash = @browserBindingHash
             and consumed_at is null`,
        )
        .run({
          browserBindingHash: hashToken(input.browserBindingToken),
          providerId: input.providerId,
          stateHash: hashToken(input.state),
        });
      if (deleted.changes > 1) unavailableTransaction();
      return deleted.changes === 1;
    } catch {
      unavailableTransaction();
    }
  }

  public cleanupExpired(batchSize = DEFAULT_CLEANUP_BATCH_SIZE, now = currentTime(this.clock)) {
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAX_CLEANUP_BATCH_SIZE ||
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime())
    ) {
      unavailableTransaction();
    }
    try {
      return this.database.sqlite
        .prepare(
          `delete from auth_transactions
           where id in (
             select id
             from auth_transactions
             where expires_at <= @now
             order by expires_at asc, id asc
             limit @batchSize
           )`,
        )
        .run({ batchSize, now: now.getTime() }).changes;
    } catch {
      unavailableTransaction();
    }
  }

  private insert(input: {
    browserBindingHash: string;
    createdAt: number;
    encryptedCodeVerifier: string;
    encryptedNonce: string;
    expiresAt: number;
    id: string;
    providerId: string;
    redirectUri: string;
    returnPath: string;
    stateHash: string;
  }) {
    try {
      return this.database.sqlite
        .transaction(() => {
          const parameters = {
            ...input,
            activePerBrowserLimit: OIDC_AUTHORIZATION_TRANSACTION_ACTIVE_PER_BROWSER_LIMIT,
            unexpiredRowLimit: OIDC_AUTHORIZATION_TRANSACTION_UNEXPIRED_ROW_LIMIT,
          };
          const inserted = this.database.sqlite
            .prepare(
              `insert or ignore into auth_transactions (
                 id,
                 state_hash,
                 provider_id,
                 browser_binding_hash,
                 encrypted_code_verifier,
                 encrypted_nonce,
                 redirect_uri,
                 return_path,
                 expires_at,
                 created_at
               )
               select
                 @id,
                 @stateHash,
                 @providerId,
                 @browserBindingHash,
                 @encryptedCodeVerifier,
                 @encryptedNonce,
                 @redirectUri,
                 @returnPath,
                 @expiresAt,
                 @createdAt
               where (
                 select count(*)
                 from auth_transactions
                 where expires_at > @createdAt
               ) < @unexpiredRowLimit
                 and (
                   select count(*)
                   from auth_transactions
                   where browser_binding_hash = @browserBindingHash
                     and consumed_at is null
                     and expires_at > @createdAt
                 ) < @activePerBrowserLimit`,
            )
            .run(parameters);
          if (inserted.changes === 1) return "inserted" as const;

          const capacity = this.database.sqlite
            .prepare(
              `select
                 count(*) as unexpiredRowCount,
                 coalesce(sum(
                   case
                     when browser_binding_hash = @browserBindingHash and consumed_at is null
                       then 1
                     else 0
                   end
                 ), 0) as activeBrowserCount
               from auth_transactions
               where expires_at > @createdAt`,
            )
            .get(parameters) as
            { activeBrowserCount: unknown; unexpiredRowCount: unknown } | undefined;
          if (
            !capacity ||
            !Number.isSafeInteger(capacity.unexpiredRowCount) ||
            !Number.isSafeInteger(capacity.activeBrowserCount)
          ) {
            unavailableTransaction();
          }
          if (
            (capacity.unexpiredRowCount as number) >=
              OIDC_AUTHORIZATION_TRANSACTION_UNEXPIRED_ROW_LIMIT ||
            (capacity.activeBrowserCount as number) >=
              OIDC_AUTHORIZATION_TRANSACTION_ACTIVE_PER_BROWSER_LIMIT
          ) {
            return "capacity" as const;
          }
          return "collision" as const;
        })
        .immediate();
    } catch {
      unavailableTransaction();
    }
  }
}
