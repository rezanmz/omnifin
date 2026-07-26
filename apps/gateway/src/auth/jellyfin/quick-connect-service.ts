import {
  JellyfinAuthenticationClient,
  type JellyfinQuickConnectResult,
} from "@omnifin/connectors/auth/jellyfin-authentication-client";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  randomToken,
} from "../../security/crypto.js";
import type { IssuedSession } from "../session-service.js";
import {
  JellyfinConnectorConfigurationError,
  JellyfinConnectorRegistry,
  type JellyfinConnectorTarget,
} from "./connector-registry.js";
import type { JellyfinSignInDenialReason, JellyfinSignInService } from "./sign-in-service.js";

export const JELLYFIN_QUICK_CONNECT_TRANSACTION_TTL_MS = 5 * 60 * 1_000;
export const JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS = 2_000;
export const JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT = 4;
export const JELLYFIN_QUICK_CONNECT_UNEXPIRED_ROW_LIMIT = 512;
export const JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME =
  "__Host-omnifin_jellyfin_qc_binding";
export const LOCAL_JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME =
  "omnifin_local_jellyfin_qc_binding";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const MAX_INSERTION_ATTEMPTS = 8;
const CLEANUP_BATCH_SIZE = 64;
const MAX_POLL_COUNT = 150;

type QuickConnectClient = Pick<
  JellyfinAuthenticationClient,
  | "authenticateWithQuickConnect"
  | "getPublicSystemInfo"
  | "initiateQuickConnect"
  | "pollQuickConnect"
  | "quickConnectEnabled"
>;

export interface JellyfinQuickConnectServiceDependencies {
  readonly clock?: () => Date;
  readonly createBrowserBinding?: () => string;
  readonly createClient?: (target: JellyfinConnectorTarget) => QuickConnectClient;
  readonly createDeviceId?: () => string;
  readonly createId?: () => string;
}

export interface StartJellyfinQuickConnectInput {
  readonly browserBindingToken?: unknown;
}

export interface PollJellyfinQuickConnectInput {
  readonly browserBindingToken?: unknown;
  readonly currentSessionToken?: unknown;
  readonly ipAddress?: string;
  readonly requestId?: string;
  readonly transactionId: string;
  readonly userAgent?: string;
}

export interface StartedJellyfinQuickConnect {
  readonly browserBindingToken: string;
  readonly code: string;
  readonly expiresAt: Date;
  readonly pollAfterMs: number;
  readonly transactionId: string;
  toJSON(): never;
}

export type JellyfinQuickConnectPollResult =
  | {
      readonly expiresAt: Date;
      readonly pollAfterMs: number;
      readonly status: "pending";
      toJSON(): never;
    }
  | { readonly status: "expired"; toJSON(): never }
  | {
      readonly reason: JellyfinSignInDenialReason;
      readonly status: "denied";
      toJSON(): never;
    }
  | { readonly session: IssuedSession; readonly status: "signed_in"; toJSON(): never };

export class JellyfinQuickConnectServiceError extends Error {
  public readonly code = "jellyfin_quick_connect_failed";
  public readonly reason:
    | "capacity_exceeded"
    | "configuration_invalid"
    | "invalid_transaction"
    | "provider_unavailable"
    | "quick_connect_disabled";

  public constructor(reason: JellyfinQuickConnectServiceError["reason"], options?: ErrorOptions) {
    super("Jellyfin Quick Connect could not be completed.", options);
    this.name = "JellyfinQuickConnectServiceError";
    this.reason = reason;
  }
}

interface StoredQuickConnectTransaction {
  browserBindingHash: string;
  connectorId: string;
  connectorType: string;
  consumedAt: number | null;
  createdAt: number;
  encryptedPayload: string;
  expiresAt: number;
  id: string;
  nextPollAt: number;
  pollCount: number;
}

interface QuickConnectPayload {
  baseUrl: string;
  code: string;
  connectorId: string;
  deviceId: string;
  insecureHttpApproved: boolean;
  schemaVersion: 1;
  secret: string;
  serverId: string;
  targetUpdatedAt: number;
}

function internalResult<T extends Readonly<Record<string, unknown>>>(
  properties: T,
): Readonly<T> & { toJSON(): never } {
  const result = Object.create(null) as T & { toJSON(): never };
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(result, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  Object.defineProperty(result, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => {
      throw new TypeError("Jellyfin Quick Connect results cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(result);
}

function isCanonicalToken(value: unknown): value is string {
  if (typeof value !== "string" || !OPAQUE_TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function payloadContext(transactionId: string) {
  return `jellyfin-quick-connect:${transactionId}:payload`;
}

function parsePayload(plaintext: string): QuickConnectPayload {
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    throw new JellyfinQuickConnectServiceError("invalid_transaction");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !==
      "baseUrl,code,connectorId,deviceId,insecureHttpApproved,schemaVersion,secret,serverId,targetUpdatedAt"
  ) {
    throw new JellyfinQuickConnectServiceError("invalid_transaction");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.baseUrl !== "string" ||
    candidate.baseUrl.length < 1 ||
    candidate.baseUrl.length > 2_048 ||
    !validIdentifier(candidate.connectorId) ||
    !validIdentifier(candidate.deviceId) ||
    typeof candidate.insecureHttpApproved !== "boolean" ||
    typeof candidate.secret !== "string" ||
    candidate.secret.length < 1 ||
    candidate.secret.length > 256 ||
    typeof candidate.code !== "string" ||
    !CODE_PATTERN.test(candidate.code) ||
    typeof candidate.serverId !== "string" ||
    candidate.serverId.length < 1 ||
    candidate.serverId.length > 256 ||
    !Number.isSafeInteger(candidate.targetUpdatedAt) ||
    (candidate.targetUpdatedAt as number) < 0
  ) {
    throw new JellyfinQuickConnectServiceError("invalid_transaction");
  }
  return candidate as unknown as QuickConnectPayload;
}

function validQuickConnectResult(result: JellyfinQuickConnectResult, payload: QuickConnectPayload) {
  return (
    constantTimeTextEqual(result.Secret, payload.secret) &&
    constantTimeTextEqual(result.Code, payload.code)
  );
}

export function jellyfinQuickConnectBrowserBindingCookieName(
  config: Pick<AppConfig, "secureCookies">,
) {
  return config.secureCookies
    ? JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME
    : LOCAL_JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME;
}

export function writeJellyfinQuickConnectBrowserBindingCookie(
  reply: {
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
  },
  config: Pick<AppConfig, "secureCookies">,
  token: string,
  expiresAt: Date,
) {
  if (!isCanonicalToken(token) || !Number.isSafeInteger(expiresAt.getTime())) {
    throw new JellyfinQuickConnectServiceError("provider_unavailable");
  }
  reply.setCookie(jellyfinQuickConnectBrowserBindingCookieName(config), token, {
    expires: expiresAt,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies,
  });
}

export class JellyfinQuickConnectService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createBrowserBinding: () => string;
  readonly #createClient: (target: JellyfinConnectorTarget) => QuickConnectClient;
  readonly #createDeviceId: () => string;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #registry: JellyfinConnectorRegistry;
  readonly #signIn: JellyfinSignInService;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    signIn: JellyfinSignInService,
    dependencies: JellyfinQuickConnectServiceDependencies = {},
  ) {
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createBrowserBinding = dependencies.createBrowserBinding ?? (() => randomToken(32));
    this.#createClient =
      dependencies.createClient ??
      ((target) =>
        new JellyfinAuthenticationClient({
          baseUrl: target.baseUrl,
          connectorId: target.connectorId,
          displayName: target.displayName,
          insecureHttpApproved: target.insecureHttpApproved,
        }));
    this.#createDeviceId = dependencies.createDeviceId ?? randomUUID;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#registry = new JellyfinConnectorRegistry(database);
    this.#signIn = signIn;
  }

  public toJSON(): never {
    throw new TypeError("Jellyfin Quick Connect services cannot be serialized.");
  }

  public async start(input: StartJellyfinQuickConnectInput): Promise<StartedJellyfinQuickConnect> {
    if (!input || typeof input !== "object") {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    const now = this.#currentTime();
    const target = this.#resolveTarget();
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(target);
    let enabled: boolean;
    try {
      enabled = await client.quickConnectEnabled({ deviceId });
      this.#registry.recordQuickConnectCapability(target, enabled);
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (!enabled) throw new JellyfinQuickConnectServiceError("quick_connect_disabled");

    let publicInfo;
    let initiated;
    try {
      [publicInfo, initiated] = await Promise.all([
        client.getPublicSystemInfo(),
        client.initiateQuickConnect({ deviceId }),
      ]);
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (initiated.Authenticated || !CODE_PATTERN.test(initiated.Code)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }

    const browserBindingToken = isCanonicalToken(input.browserBindingToken)
      ? input.browserBindingToken
      : this.#createBrowserBinding();
    if (!isCanonicalToken(browserBindingToken)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    const expiresAt = new Date(now + JELLYFIN_QUICK_CONNECT_TRANSACTION_TTL_MS);
    const payload: QuickConnectPayload = {
      baseUrl: target.baseUrl,
      code: initiated.Code,
      connectorId: target.connectorId,
      deviceId,
      insecureHttpApproved: target.insecureHttpApproved,
      schemaVersion: 1,
      secret: initiated.Secret,
      serverId: publicInfo.Id,
      targetUpdatedAt: target.updatedAt,
    };

    this.#cleanupExpired(now);
    for (let attempt = 0; attempt < MAX_INSERTION_ATTEMPTS; attempt += 1) {
      const transactionId = this.#nextIdentifier(this.#createId());
      const inserted = this.#insert({
        browserBindingHash: hashToken(browserBindingToken),
        connectorId: target.connectorId,
        createdAt: now,
        encryptedPayload: this.#cipher.encrypt(
          JSON.stringify(payload),
          payloadContext(transactionId),
        ),
        expiresAt: expiresAt.getTime(),
        id: transactionId,
        nextPollAt: now + JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
      });
      if (inserted === "capacity") {
        throw new JellyfinQuickConnectServiceError("capacity_exceeded");
      }
      if (inserted === "collision") continue;
      return internalResult({
        browserBindingToken,
        code: initiated.Code,
        expiresAt,
        pollAfterMs: JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
        transactionId,
      });
    }
    throw new JellyfinQuickConnectServiceError("provider_unavailable");
  }

  public async poll(input: PollJellyfinQuickConnectInput): Promise<JellyfinQuickConnectPollResult> {
    if (
      !input ||
      typeof input !== "object" ||
      !validIdentifier(input.transactionId) ||
      !isCanonicalToken(input.browserBindingToken)
    ) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    const now = this.#currentTime();
    const browserBindingHash = hashToken(input.browserBindingToken);
    const reservation = this.#reservePoll(input.transactionId, browserBindingHash, now);
    if (reservation.status === "expired") return internalResult({ status: "expired" as const });
    if (reservation.status === "pending") {
      return internalResult({
        expiresAt: new Date(reservation.expiresAt),
        pollAfterMs: reservation.pollAfterMs,
        status: "pending" as const,
      });
    }

    const payload = this.#decryptPayload(reservation.row);
    const target = this.#resolveTarget();
    if (!this.#payloadMatchesTarget(payload, target)) {
      throw new JellyfinQuickConnectServiceError("configuration_invalid");
    }
    const client = this.#createClient(target);
    let upstream;
    try {
      upstream = await client.pollQuickConnect({
        deviceId: payload.deviceId,
        secret: payload.secret,
      });
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (!validQuickConnectResult(upstream, payload)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    if (!upstream.Authenticated) {
      return internalResult({
        expiresAt: new Date(reservation.row.expiresAt),
        pollAfterMs: JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
        status: "pending" as const,
      });
    }

    if (!this.#consume(reservation.row, browserBindingHash, now, target)) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    let authentication;
    try {
      authentication = await client.authenticateWithQuickConnect({
        deviceId: payload.deviceId,
        secret: payload.secret,
      });
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (authentication.ServerId !== payload.serverId) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    const result = this.#signIn.completeAuthenticatedSignIn({
      authentication,
      currentSessionToken: input.currentSessionToken,
      deviceId: payload.deviceId,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      proof: "quick_connect",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      target,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    });
    if (result.status === "denied") {
      return internalResult({ reason: result.reason, status: "denied" as const });
    }
    return internalResult({ session: result.session, status: "signed_in" as const });
  }

  #insert(input: {
    browserBindingHash: string;
    connectorId: string;
    createdAt: number;
    encryptedPayload: string;
    expiresAt: number;
    id: string;
    nextPollAt: number;
  }): "capacity" | "collision" | "inserted" {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const globalCount = this.#database.sqlite
            .prepare(
              `select count(*) as count
               from jellyfin_quick_connect_transactions
               where expires_at > ?`,
            )
            .get(input.createdAt) as { count: number };
          const browserCount = this.#database.sqlite
            .prepare(
              `select count(*) as count
               from jellyfin_quick_connect_transactions
               where browser_binding_hash = ?
                 and consumed_at is null
                 and expires_at > ?`,
            )
            .get(input.browserBindingHash, input.createdAt) as { count: number };
          if (
            globalCount.count >= JELLYFIN_QUICK_CONNECT_UNEXPIRED_ROW_LIMIT ||
            browserCount.count >= JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT
          ) {
            return "capacity" as const;
          }
          const existing = this.#database.sqlite
            .prepare("select 1 from jellyfin_quick_connect_transactions where id = ?")
            .get(input.id);
          if (existing) return "collision" as const;
          this.#database.sqlite
            .prepare(
              `insert into jellyfin_quick_connect_transactions (
                id,
                connector_id,
                connector_type,
                browser_binding_hash,
                encrypted_payload,
                expires_at,
                next_poll_at,
                poll_count,
                created_at
              ) values (?, ?, 'jellyfin', ?, ?, ?, ?, 0, ?)`,
            )
            .run(
              input.id,
              input.connectorId,
              input.browserBindingHash,
              input.encryptedPayload,
              input.expiresAt,
              input.nextPollAt,
              input.createdAt,
            );
          return "inserted" as const;
        })
        .immediate();
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #reservePoll(
    transactionId: string,
    browserBindingHash: string,
    now: number,
  ):
    | { status: "expired" }
    | { expiresAt: number; pollAfterMs: number; status: "pending" }
    | { row: StoredQuickConnectTransaction; status: "reserved" } {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const row = this.#database.sqlite
            .prepare(
              `select
                id,
                connector_id as connectorId,
                connector_type as connectorType,
                browser_binding_hash as browserBindingHash,
                encrypted_payload as encryptedPayload,
                expires_at as expiresAt,
                next_poll_at as nextPollAt,
                poll_count as pollCount,
                consumed_at as consumedAt,
                created_at as createdAt
               from jellyfin_quick_connect_transactions
               where id = ?`,
            )
            .get(transactionId) as StoredQuickConnectTransaction | undefined;
          if (
            !row ||
            row.connectorType !== "jellyfin" ||
            !constantTimeTextEqual(row.browserBindingHash, browserBindingHash) ||
            row.consumedAt !== null
          ) {
            throw new JellyfinQuickConnectServiceError("invalid_transaction");
          }
          if (now >= row.expiresAt || row.pollCount >= MAX_POLL_COUNT) {
            return { status: "expired" as const };
          }
          if (now < row.nextPollAt) {
            return {
              expiresAt: row.expiresAt,
              pollAfterMs: Math.max(row.nextPollAt - now, 1_000),
              status: "pending" as const,
            };
          }
          const nextPollAt = Math.min(now + JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS, row.expiresAt);
          const update = this.#database.sqlite
            .prepare(
              `update jellyfin_quick_connect_transactions
               set next_poll_at = ?, poll_count = poll_count + 1
               where id = ?
                 and browser_binding_hash = ?
                 and consumed_at is null
                 and poll_count = ?
                 and next_poll_at = ?`,
            )
            .run(nextPollAt, row.id, browserBindingHash, row.pollCount, row.nextPollAt);
          if (update.changes !== 1) {
            throw new JellyfinQuickConnectServiceError("invalid_transaction");
          }
          return {
            row: { ...row, nextPollAt, pollCount: row.pollCount + 1 },
            status: "reserved" as const,
          };
        })
        .immediate();
    } catch (error) {
      if (error instanceof JellyfinQuickConnectServiceError) throw error;
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #consume(
    row: StoredQuickConnectTransaction,
    browserBindingHash: string,
    now: number,
    target: JellyfinConnectorTarget,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() => {
          if (!this.#registry.bindingIsCurrent(target)) return false;
          const result = this.#database.sqlite
            .prepare(
              `update jellyfin_quick_connect_transactions
               set consumed_at = ?
               where id = ?
                 and browser_binding_hash = ?
                 and consumed_at is null
                 and expires_at > ?
                 and poll_count = ?`,
            )
            .run(now, row.id, browserBindingHash, now, row.pollCount);
          return result.changes === 1;
        })
        .immediate();
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #cleanupExpired(now: number) {
    try {
      this.#database.sqlite
        .prepare(
          `delete from jellyfin_quick_connect_transactions
           where id in (
             select id
             from jellyfin_quick_connect_transactions
             where expires_at <= ?
             order by expires_at asc
             limit ?
           )`,
        )
        .run(now, CLEANUP_BATCH_SIZE);
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #decryptPayload(row: StoredQuickConnectTransaction) {
    try {
      return parsePayload(this.#cipher.decrypt(row.encryptedPayload, payloadContext(row.id)));
    } catch (error) {
      if (error instanceof JellyfinQuickConnectServiceError) throw error;
      throw new JellyfinQuickConnectServiceError("invalid_transaction", { cause: error });
    }
  }

  #payloadMatchesTarget(payload: QuickConnectPayload, target: JellyfinConnectorTarget) {
    return (
      payload.connectorId === target.connectorId &&
      payload.baseUrl === target.baseUrl &&
      payload.insecureHttpApproved === target.insecureHttpApproved &&
      payload.targetUpdatedAt === target.updatedAt &&
      this.#registry.bindingIsCurrent(target)
    );
  }

  #resolveTarget() {
    try {
      return this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinQuickConnectServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
  }

  #currentTime() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    return value;
  }

  #nextIdentifier(value: string) {
    if (!validIdentifier(value)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    return value;
  }
}
