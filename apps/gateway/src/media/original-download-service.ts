import {
  JELLYFIN_ORIGINAL_DOWNLOAD_MAX_BYTES,
  JellyfinUserMediaClient,
  type JellyfinOriginalDownloadMetadata,
  type JellyfinOriginalDownloadStream,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import { connectorCredentialInputSchema } from "@omnifin/contracts/connectors";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  libraryDownloadPrepareResponseSchema,
  type LibraryDownloadPrepareResponse,
} from "@omnifin/contracts/library";
import { X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";
import {
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "./media-reference-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PUBLIC_GRANT_PATTERN = /^media_download_[A-Za-z0-9_-]{22}$/u;
const INTERNAL_GRANT_PATTERN = /^download_grant_[A-Za-z0-9_-]{22}$/u;
const GRANT_TTL_MS = 5 * 60 * 1_000;
const MAX_CREATION_ATTEMPTS = 8;
const MAX_ACTIVE_DOWNLOADS_GLOBAL = 3;
const MAX_ACTIVE_DOWNLOADS_PER_USER = 1;

const storedGrantPayloadSchema = z.strictObject({
  etag: z
    .string()
    .min(1)
    .max(1_024)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .nullable(),
  itemId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  schemaVersion: z.literal(1),
  sizeBytes: z.int().positive().max(JELLYFIN_ORIGINAL_DOWNLOAD_MAX_BYTES),
});
type StoredGrantPayload = z.infer<typeof storedGrantPayloadSchema>;

interface SourceRow {
  baseUrl: string;
  connectorDisplayName: string;
  connectorEnabled: number;
  connectorId: string;
  connectorType: string;
  deviceId: string;
  encryptedAccessToken: string;
  encryptedCredentials: string;
  externalUserId: string;
  insecureHttpApproved: number;
  linkHealthState: string;
  linkId: string;
  linkRevision: number;
  linkService: string;
  linkUserId: string;
  tlsPolicy: string;
}

interface GrantRow {
  contentType: string;
  encryptedPayload: string;
  expiresAt: number;
  filename: string;
  id: string;
  linkId: string;
  linkRevision: number;
  referenceId: string;
  sessionId: string;
  sizeBytes: number;
  state: string;
  userId: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

export interface OriginalDownloadContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface OriginalDownloadClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

type OriginalDownloadClient = Pick<
  JellyfinUserMediaClient,
  "readOriginalDownloadMetadata" | "streamOriginalDownload"
>;

export interface OriginalDownloadDependencies {
  clock?: () => Date;
  createAuditToken?: () => string;
  createClient?: (input: OriginalDownloadClientFactoryInput) => OriginalDownloadClient;
  createGrantToken?: () => string;
  createInternalToken?: () => string;
  mediaReferences?: MediaReferenceDependencies;
}

export type OriginalDownloadErrorReason =
  | "busy"
  | "grant_expired"
  | "grant_invalid"
  | "permission_denied"
  | "range_invalid"
  | "source_changed"
  | "storage_failure"
  | "unavailable";

export class OriginalDownloadError extends Error {
  public readonly reason: OriginalDownloadErrorReason;
  public readonly sizeBytes: number | null;

  public constructor(
    reason: OriginalDownloadErrorReason,
    options: ErrorOptions & { sizeBytes?: number } = {},
  ) {
    super("The original media download could not be completed.", options);
    this.name = "OriginalDownloadError";
    this.reason = reason;
    this.sizeBytes = options.sizeBytes ?? null;
  }
}

export interface OriginalDownloadTransfer extends JellyfinOriginalDownloadStream {
  filename: string;
  finish(outcome: "cancelled" | "failure" | "success", bytesTransferred: number): Promise<void>;
}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function grantPayloadContext(grantId: string) {
  return `media_download_grant:jellyfin:${grantId}`;
}

function operationTime(clock: () => Date) {
  const now = clock();
  const value = now.getTime();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OriginalDownloadError("storage_failure");
  }
  return { date: now, value };
}

function safeDisplayName(value: string) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || "Jellyfin").slice(0, 160);
}

function containerProperties(container: string | null) {
  const known = {
    avi: "video/x-msvideo",
    m4v: "video/x-m4v",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    ts: "video/mp2t",
    webm: "video/webm",
  } as const;
  const extension = container?.toLocaleLowerCase("en-US") as keyof typeof known | undefined;
  return extension && Object.hasOwn(known, extension)
    ? { contentType: known[extension], extension: `.${extension}` }
    : { contentType: "application/octet-stream", extension: "" };
}

function downloadFilename(metadata: JellyfinOriginalDownloadMetadata) {
  const { extension } = containerProperties(metadata.container);
  const title = metadata.title
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}/\\"]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[. ]+|[. ]+$/gu, "")
    .trim();
  const base = `${title || "Media"}${metadata.year === null ? "" : ` (${metadata.year})`}`;
  return `${base.slice(0, 240 - extension.length).replace(/[. ]+$/gu, "") || "Media"}${extension}`;
}

function normalizedRange(value: string | undefined, sizeBytes: number) {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match) throw new OriginalDownloadError("range_invalid", { sizeBytes });
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) {
    throw new OriginalDownloadError("range_invalid", { sizeBytes });
  }
  const start = startText ? Number(startText) : null;
  const end = endText ? Number(endText) : null;
  if (
    (start !== null && (!Number.isSafeInteger(start) || start < 0 || start >= sizeBytes)) ||
    (end !== null && (!Number.isSafeInteger(end) || end < 0)) ||
    (start !== null && end !== null && start > end) ||
    (start === null && (end === null || end === 0))
  ) {
    throw new OriginalDownloadError("range_invalid", { sizeBytes });
  }
  return value;
}

function defaultClient(input: OriginalDownloadClientFactoryInput) {
  const { accessToken, deviceId, ...target } = input;
  return new JellyfinUserMediaClient({ accessToken, deviceId, target });
}

export class OriginalDownloadService {
  readonly #activeByUser = new Map<string, number>();
  #activeGlobal = 0;
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAuditToken: () => string;
  readonly #createClient: (input: OriginalDownloadClientFactoryInput) => OriginalDownloadClient;
  readonly #createGrantToken: () => string;
  readonly #createInternalToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #references: MediaReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: OriginalDownloadDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAuditToken = dependencies.createAuditToken ?? (() => randomToken(16));
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#createGrantToken = dependencies.createGrantToken ?? (() => randomToken(16));
    this.#createInternalToken = dependencies.createInternalToken ?? (() => randomToken(16));
    this.#references = new MediaReferenceService(database, config, {
      ...dependencies.mediaReferences,
      clock: dependencies.mediaReferences?.clock ?? this.#clock,
    });
  }

  public async prepare(
    referenceId: string,
    context: OriginalDownloadContext,
    signal?: AbortSignal,
  ): Promise<LibraryDownloadPrepareResponse> {
    const principal = requirePermission(context.principal, "media.download");
    const source = this.#source(principal);
    let reference;
    try {
      reference = this.#references.resolve(
        { linkId: source.linkId, linkRevision: source.linkRevision, userId: source.linkUserId },
        referenceId,
      );
    } catch (error) {
      throw new OriginalDownloadError("grant_invalid", { cause: error });
    }
    if (reference.kind !== "movie" && reference.kind !== "episode") {
      throw new OriginalDownloadError("permission_denied");
    }

    let metadata: JellyfinOriginalDownloadMetadata;
    try {
      metadata = await this.#client(source).readOriginalDownloadMetadata(
        { itemId: reference.itemId, userId: source.externalUserId },
        signal,
      );
    } catch (error) {
      throw new OriginalDownloadError("unavailable", { cause: error });
    }
    if (!metadata.canDownload) throw new OriginalDownloadError("permission_denied");
    if (
      metadata.externalId !== reference.itemId ||
      metadata.sizeBytes === null ||
      !Number.isSafeInteger(metadata.sizeBytes) ||
      metadata.sizeBytes < 1 ||
      metadata.sizeBytes > JELLYFIN_ORIGINAL_DOWNLOAD_MAX_BYTES
    ) {
      throw new OriginalDownloadError("unavailable");
    }
    const sizeBytes = metadata.sizeBytes;

    const now = operationTime(this.#clock);
    const expiresAt = now.value + GRANT_TTL_MS;
    const filename = downloadFilename(metadata);
    const contentType = containerProperties(metadata.container).contentType;
    const payload = storedGrantPayloadSchema.parse({
      etag: metadata.etag,
      itemId: metadata.externalId,
      schemaVersion: 1,
      sizeBytes,
    });
    let publicGrantId = "";
    let internalGrantId = "";

    try {
      this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare("delete from media_download_grants where expires_at <= ?")
            .run(now.value);
          for (let attempt = 0; attempt < MAX_CREATION_ATTEMPTS; attempt += 1) {
            publicGrantId = `media_download_${this.#createGrantToken()}`;
            internalGrantId = `download_grant_${this.#createInternalToken()}`;
            if (
              !PUBLIC_GRANT_PATTERN.test(publicGrantId) ||
              !INTERNAL_GRANT_PATTERN.test(internalGrantId)
            ) {
              throw new OriginalDownloadError("storage_failure");
            }
            try {
              this.#database.sqlite
                .prepare(
                  `insert into media_download_grants (
                    id, public_token_hash, user_id, session_id, service_identity_link_id,
                    link_revision, reference_id, encrypted_payload, filename, content_type,
                    size_bytes, state, bytes_transferred, expires_at, created_at, updated_at
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?, ?, ?)`,
                )
                .run(
                  internalGrantId,
                  hashToken(publicGrantId),
                  source.linkUserId,
                  principal.sessionId,
                  source.linkId,
                  source.linkRevision,
                  referenceId,
                  this.#cipher.encrypt(
                    JSON.stringify(payload),
                    grantPayloadContext(internalGrantId),
                  ),
                  filename,
                  contentType,
                  sizeBytes,
                  expiresAt,
                  now.value,
                  now.value,
                );
              break;
            } catch (error) {
              const collision = this.#database.sqlite
                .prepare(
                  "select 1 from media_download_grants where id = ? or public_token_hash = ?",
                )
                .get(internalGrantId, hashToken(publicGrantId));
              if (!collision || attempt === MAX_CREATION_ATTEMPTS - 1) throw error;
            }
          }
          if (!publicGrantId || !internalGrantId) {
            throw new OriginalDownloadError("storage_failure");
          }
          this.#audit(
            "media.original_download.prepared",
            "success",
            internalGrantId,
            context,
            {
              sizeBytes,
            },
            now.value,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof OriginalDownloadError) throw error;
      throw new OriginalDownloadError("storage_failure", { cause: error });
    }

    return libraryDownloadPrepareResponseSchema.parse({
      archiveRetrieval: "unknown",
      contentType,
      expiresAt: new Date(expiresAt).toISOString(),
      filename,
      generatedAt: now.date.toISOString(),
      grantId: publicGrantId,
      path: `/v1/media/library/downloads/${publicGrantId}`,
      referenceId,
      sizeBytes,
    });
  }

  public async open(
    grantId: string,
    range: string | undefined,
    context: OriginalDownloadContext,
    signal?: AbortSignal,
  ): Promise<OriginalDownloadTransfer> {
    const principal = requirePermission(context.principal, "media.download");
    if (!PUBLIC_GRANT_PATTERN.test(grantId)) {
      throw new OriginalDownloadError("grant_invalid");
    }
    const source = this.#source(principal);
    const now = operationTime(this.#clock);
    const row = this.#database.sqlite
      .prepare(
        `select
          id, user_id as userId, session_id as sessionId,
          service_identity_link_id as linkId, link_revision as linkRevision,
          reference_id as referenceId, encrypted_payload as encryptedPayload,
          filename, content_type as contentType, size_bytes as sizeBytes, state,
          expires_at as expiresAt
         from media_download_grants
         where public_token_hash = ?`,
      )
      .get(hashToken(grantId)) as GrantRow | undefined;
    if (
      !row ||
      row.userId !== principal.userId ||
      row.sessionId !== principal.sessionId ||
      row.linkId !== source.linkId ||
      row.linkRevision !== source.linkRevision
    ) {
      throw new OriginalDownloadError("grant_invalid");
    }
    if (row.expiresAt <= now.value) throw new OriginalDownloadError("grant_expired");
    if (row.state !== "prepared") throw new OriginalDownloadError("grant_invalid");
    const normalized = normalizedRange(range, row.sizeBytes);

    let payload: StoredGrantPayload;
    try {
      payload = storedGrantPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(row.encryptedPayload, grantPayloadContext(row.id))),
      );
    } catch (error) {
      throw new OriginalDownloadError("storage_failure", { cause: error });
    }
    let metadata: JellyfinOriginalDownloadMetadata;
    const client = this.#client(source);
    try {
      metadata = await client.readOriginalDownloadMetadata(
        { itemId: payload.itemId, userId: source.externalUserId },
        signal,
      );
    } catch (error) {
      throw new OriginalDownloadError("unavailable", { cause: error });
    }
    if (
      !metadata.canDownload ||
      metadata.externalId !== payload.itemId ||
      metadata.etag !== payload.etag ||
      metadata.sizeBytes !== payload.sizeBytes ||
      row.sizeBytes !== payload.sizeBytes
    ) {
      throw new OriginalDownloadError("source_changed");
    }

    const release = this.#acquire(row.userId);
    let stream: JellyfinOriginalDownloadStream;
    try {
      stream = await client.streamOriginalDownload(
        {
          itemId: payload.itemId,
          maxResponseBytes: payload.sizeBytes,
          ...(normalized === undefined ? {} : { range: normalized }),
        },
        signal,
      );
    } catch (error) {
      release();
      this.#markFailed(row, context, 0);
      throw new OriginalDownloadError("unavailable", { cause: error });
    }
    if (stream.status === 416) {
      await stream.body.cancel().catch(() => undefined);
      release();
      this.#markFailed(row, context, 0);
      throw new OriginalDownloadError("range_invalid", { sizeBytes: row.sizeBytes });
    }

    try {
      this.#database.sqlite
        .transaction(() => {
          const claimed = this.#database.sqlite
            .prepare(
              `update media_download_grants
               set state = 'streaming', bytes_transferred = 0, started_at = ?,
                   completed_at = null, updated_at = ?
               where id = ? and state = 'prepared' and expires_at > ?`,
            )
            .run(now.value, now.value, row.id, now.value);
          if (claimed.changes !== 1) throw new OriginalDownloadError("grant_invalid");
          this.#audit(
            "media.original_download.started",
            "success",
            row.id,
            context,
            {
              rangeRequested: normalized !== undefined,
              status: stream.status,
            },
            now.value,
          );
        })
        .immediate();
    } catch (error) {
      await stream.body.cancel().catch(() => undefined);
      release();
      if (error instanceof OriginalDownloadError) throw error;
      throw new OriginalDownloadError("storage_failure", { cause: error });
    }

    let finished = false;
    return Object.freeze({
      ...stream,
      filename: row.filename,
      finish: async (outcome: "cancelled" | "failure" | "success", bytesTransferred: number) => {
        if (finished) return;
        finished = true;
        release();
        this.#finish(row, context, outcome, bytesTransferred);
      },
    });
  }

  #source(principal: SessionPrincipal) {
    const userId = principal.userId;
    const linkedService = principal.linkedServices.find(({ service }) => service === "jellyfin");
    if (!userId || !linkedService) throw new OriginalDownloadError("grant_invalid");
    const row = this.#database.sqlite
      .prepare(
        `select
          l.id as linkId, l.user_id as linkUserId, l.service as linkService,
          l.device_id as deviceId, l.external_user_id as externalUserId,
          l.encrypted_access_token as encryptedAccessToken,
          l.health_state as linkHealthState, l.revision as linkRevision,
          c.id as connectorId, c.type as connectorType, c.display_name as connectorDisplayName,
          c.base_url as baseUrl, c.encrypted_credentials as encryptedCredentials,
          c.tls_policy as tlsPolicy, c.insecure_http_approved as insecureHttpApproved,
          c.enabled as connectorEnabled
         from service_identity_links l
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.id = ? and l.user_id = ?`,
      )
      .get(linkedService.id, userId) as SourceRow | undefined;
    if (
      !row ||
      row.linkUserId !== userId ||
      row.linkId !== linkedService.id ||
      row.linkService !== "jellyfin" ||
      !["linked", "unavailable"].includes(row.linkHealthState) ||
      row.connectorType !== "jellyfin" ||
      row.connectorEnabled !== 1 ||
      !IDENTIFIER_PATTERN.test(row.connectorId) ||
      !IDENTIFIER_PATTERN.test(row.linkId) ||
      !IDENTIFIER_PATTERN.test(row.deviceId) ||
      !IDENTIFIER_PATTERN.test(row.externalUserId) ||
      !Number.isSafeInteger(row.linkRevision) ||
      row.linkRevision < 0 ||
      (row.insecureHttpApproved !== 0 && row.insecureHttpApproved !== 1)
    ) {
      throw new OriginalDownloadError("grant_invalid");
    }
    return row;
  }

  #client(row: SourceRow) {
    try {
      const token = this.#cipher.decrypt(row.encryptedAccessToken, accessTokenContext(row.linkId));
      const decoded = JSON.parse(
        this.#cipher.decrypt(row.encryptedCredentials, credentialsContext(row.connectorId)),
      ) as unknown;
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new Error("invalid");
      }
      const record = decoded as Record<string, unknown>;
      const versioned = record.schemaVersion === 1;
      if (
        versioned &&
        Object.keys(record).some(
          (key) => !["credentials", "schemaVersion", "tlsCaCertificatePem"].includes(key),
        )
      ) {
        throw new Error("invalid");
      }
      const stored = versioned
        ? (record as unknown as StoredConnectorSecrets)
        : ({ credentials: decoded, schemaVersion: 1 } satisfies StoredConnectorSecrets);
      if (connectorCredentialInputSchema.parse(stored.credentials).kind !== "none") {
        throw new Error("invalid");
      }
      const tlsPolicy =
        row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed" ? row.tlsPolicy : null;
      if (!tlsPolicy) throw new Error("invalid");
      const ca = stored.tlsCaCertificatePem;
      if (ca !== undefined) {
        if (typeof ca !== "string" || tlsPolicy !== "allow_self_signed") {
          throw new Error("invalid");
        }
        if (!new X509Certificate(ca).ca) throw new Error("invalid");
      }
      return this.#createClient({
        accessToken: token,
        baseUrl: row.baseUrl,
        connectorId: row.connectorId,
        deviceId: row.deviceId,
        displayName: safeDisplayName(row.connectorDisplayName),
        insecureHttpApproved: row.insecureHttpApproved === 1,
        tlsPolicy,
        ...(typeof ca === "string" ? { tlsCaCertificatePem: ca } : {}),
      });
    } catch (error) {
      if (error instanceof OriginalDownloadError) throw error;
      throw new OriginalDownloadError("unavailable", { cause: error });
    }
  }

  #acquire(userId: string) {
    if (
      this.#activeGlobal >= MAX_ACTIVE_DOWNLOADS_GLOBAL ||
      (this.#activeByUser.get(userId) ?? 0) >= MAX_ACTIVE_DOWNLOADS_PER_USER
    ) {
      throw new OriginalDownloadError("busy");
    }
    this.#activeGlobal += 1;
    this.#activeByUser.set(userId, (this.#activeByUser.get(userId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeGlobal -= 1;
      const remaining = (this.#activeByUser.get(userId) ?? 1) - 1;
      if (remaining === 0) this.#activeByUser.delete(userId);
      else this.#activeByUser.set(userId, remaining);
    };
  }

  #finish(
    row: GrantRow,
    context: OriginalDownloadContext,
    outcome: "cancelled" | "failure" | "success",
    bytesTransferred: number,
  ) {
    const now = operationTime(this.#clock).value;
    const safeBytes =
      Number.isSafeInteger(bytesTransferred) && bytesTransferred >= 0
        ? Math.min(bytesTransferred, row.sizeBytes)
        : 0;
    const state = outcome === "success" ? "completed" : outcome === "failure" ? "failed" : outcome;
    const auditOutcome = outcome === "success" ? "success" : "failure";
    try {
      this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare(
              `update media_download_grants
               set state = ?, bytes_transferred = ?, completed_at = ?, updated_at = ?
               where id = ?`,
            )
            .run(state, safeBytes, now, now, row.id);
          this.#audit(
            `media.original_download.${outcome}`,
            auditOutcome,
            row.id,
            context,
            { bytesTransferred: safeBytes },
            now,
          );
        })
        .immediate();
    } catch (error) {
      throw new OriginalDownloadError("storage_failure", { cause: error });
    }
  }

  #markFailed(row: GrantRow, context: OriginalDownloadContext, bytesTransferred: number) {
    const now = operationTime(this.#clock).value;
    const safeBytes =
      Number.isSafeInteger(bytesTransferred) && bytesTransferred >= 0
        ? Math.min(bytesTransferred, row.sizeBytes)
        : 0;
    try {
      this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare(
              `update media_download_grants
               set state = 'failed', bytes_transferred = ?, updated_at = ?
               where id = ?`,
            )
            .run(safeBytes, now, row.id);
          this.#audit(
            "media.original_download.failure",
            "failure",
            row.id,
            context,
            { bytesTransferred: safeBytes },
            now,
          );
        })
        .immediate();
    } catch (error) {
      throw new OriginalDownloadError("storage_failure", { cause: error });
    }
  }

  #audit(
    eventType: string,
    outcome: "denied" | "failure" | "success",
    targetId: string,
    context: OriginalDownloadContext,
    metadata: Record<string, boolean | number | string>,
    createdAt: number,
  ) {
    let auditId = "";
    for (let attempt = 0; attempt < MAX_CREATION_ATTEMPTS; attempt += 1) {
      auditId = `audit_${this.#createAuditToken()}`;
      if (!IDENTIFIER_PATTERN.test(auditId)) throw new OriginalDownloadError("storage_failure");
      if (!this.#database.sqlite.prepare("select 1 from audit_events where id = ?").get(auditId)) {
        break;
      }
      auditId = "";
    }
    if (!auditId) throw new OriginalDownloadError("storage_failure");
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
          id, actor_user_id, actor_session_id, actor_auth_method,
          event_type, outcome, target_type, target_id, request_id,
          metadata_json, ip_hash, created_at
        ) values (?, ?, ?, ?, ?, ?, 'media_download_grant', ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        outcome,
        targetId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }
}
