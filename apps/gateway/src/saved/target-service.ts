import { JellyfinUserMediaClient } from "@omnifin/connectors/media/jellyfin-user-media-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { connectorCredentialInputSchema } from "@omnifin/contracts/connectors";
import {
  savedMembershipSummarySchema,
  type SavedFavoriteState,
  type SavedMembershipSummary,
} from "@omnifin/contracts/saved";
import { X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash, randomToken } from "../security/crypto.js";
import {
  MediaReferenceError,
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "../media/media-reference-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TARGET_ID_PATTERN = /^save_target_[A-Za-z0-9_-]{22}$/u;
const CATALOG_ID_PATTERN = /^catalog_[A-Za-z0-9_-]{22}$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TARGET_TTL_MS = 15 * 60 * 1_000;
const MAX_TARGETS_PER_USER = 1_024;
const MAX_TARGET_CREATION_ATTEMPTS = 8;

const storedFavoriteStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("synced"), value: z.boolean() }),
  z.strictObject({ state: z.literal("unavailable"), value: z.boolean().nullable() }),
]);

const storedTargetPayloadSchema = z.strictObject({
  artwork: z.strictObject({
    backdrop: z.boolean(),
    poster: z.boolean(),
  }),
  catalogIdentityDigest: z.string().regex(DIGEST_PATTERN),
  favorite: storedFavoriteStateSchema,
  itemId: z.string().regex(IDENTIFIER_PATTERN),
  kind: z.enum(["movie", "series"]),
  libraryReferenceId: z.string().regex(/^media_[A-Za-z0-9_-]{22}$/u),
  overview: z.null(),
  resolutionState: z.enum(["current", "connector_unavailable"]),
  schemaVersion: z.literal(1),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  year: z.int().min(1870).max(2200).nullable(),
});

export type StoredSavedTarget = z.infer<typeof storedTargetPayloadSchema>;

interface SavedTargetSourceRow {
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

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

interface StoredTargetRow {
  id: string;
}

interface CatalogMembershipRow {
  customListCount: number;
  id: string;
  watchLater: number;
}

export interface SavedTargetContext {
  principal: SessionPrincipal;
}

export interface SavedTargetClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

export interface SavedTargetClient {
  readFavoriteState(
    input: { itemId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<boolean>;
  updateFavoriteState(
    input: { favorite: boolean; itemId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface SavedTargetServiceDependencies {
  clock?: () => Date;
  createClient?: (input: SavedTargetClientFactoryInput) => SavedTargetClient;
  createTargetToken?: () => string;
  mediaReferences?: MediaReferenceDependencies;
}

export type SavedTargetErrorReason = "not_found" | "principal_unavailable" | "storage_failure";

export class SavedTargetServiceError extends Error {
  public readonly reason: SavedTargetErrorReason;

  public constructor(reason: SavedTargetErrorReason, options?: ErrorOptions) {
    super("The private save target could not be issued.", options);
    this.name = "SavedTargetServiceError";
    this.reason = reason;
  }
}

class SavedTargetConfigurationError extends Error {}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function targetContext(userId: string, targetId: string) {
  return `saved_target_payload:${userId}:${targetId}`;
}

function accessToken(row: SavedTargetSourceRow, cipher: EnvelopeCipher) {
  try {
    return cipher.decrypt(row.encryptedAccessToken, accessTokenContext(row.linkId));
  } catch (error) {
    throw new SavedTargetConfigurationError("invalid", { cause: error });
  }
}

function safeDisplayName(value: string) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || "Jellyfin").slice(0, 160);
}

function connectorSecrets(row: SavedTargetSourceRow, cipher: EnvelopeCipher) {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, credentialsContext(row.connectorId)),
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
    const credentials = connectorCredentialInputSchema.parse(stored.credentials);
    if (credentials.kind !== "none") throw new Error("invalid");
    const tlsCaCertificatePem = stored.tlsCaCertificatePem;
    if (tlsCaCertificatePem !== undefined) {
      if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
        throw new Error("invalid");
      }
      const certificate = new X509Certificate(tlsCaCertificatePem);
      if (!certificate.ca) throw new Error("invalid");
    }
    return typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {};
  } catch (error) {
    throw new SavedTargetConfigurationError("invalid", { cause: error });
  }
}

function defaultClient(input: SavedTargetClientFactoryInput): SavedTargetClient {
  const { accessToken: privateAccessToken, deviceId, ...target } = input;
  return new JellyfinUserMediaClient({ accessToken: privateAccessToken, deviceId, target });
}

export class SavedTargetService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: Pick<AppConfig, "encryptionKey">;
  readonly #createClient: (input: SavedTargetClientFactoryInput) => SavedTargetClient;
  readonly #createTargetToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #references: MediaReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: SavedTargetServiceDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createTargetToken = dependencies.createTargetToken ?? (() => randomToken(16));
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#references = new MediaReferenceService(database, config, {
      ...dependencies.mediaReferences,
      clock: dependencies.mediaReferences?.clock ?? this.#clock,
    });
  }

  public async issueOwned(
    referenceId: string,
    context: SavedTargetContext,
    signal?: AbortSignal,
  ): Promise<SavedMembershipSummary> {
    const principal = requirePermission(context.principal, "saved.lists.self.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new SavedTargetServiceError("principal_unavailable");
    }
    const userId = principal.userId;
    const source = this.#source(principal);
    let reference;
    try {
      reference = this.#references.resolve(
        {
          linkId: source.linkId,
          linkRevision: source.linkRevision,
          userId,
        },
        referenceId,
      );
    } catch (error) {
      if (error instanceof MediaReferenceError) {
        throw new SavedTargetServiceError("not_found", { cause: error });
      }
      throw error;
    }
    if ((reference.kind !== "movie" && reference.kind !== "series") || reference.title === null) {
      throw new SavedTargetServiceError("not_found");
    }

    let favorite: SavedFavoriteState = { state: "unavailable", value: null };
    if (source.linkHealthState === "linked") {
      try {
        favorite = {
          state: "synced",
          value: await this.#client(source).readFavoriteState(
            { itemId: reference.itemId, userId: source.externalUserId },
            signal,
          ),
        };
      } catch {
        favorite = { state: "unavailable", value: null };
      }
    }

    const now = this.#now();
    const expiresAt = now + TARGET_TTL_MS;
    const catalogIdentityDigest = privacyHash(
      "saved_catalog_identity",
      `jellyfin\0${source.linkId}\0${reference.kind}\0${reference.itemId}`,
      this.#config.encryptionKey,
    );
    const targetIdentityDigest = privacyHash(
      "saved_target",
      `${source.linkId}\0${source.linkRevision}\0${reference.itemId}`,
      this.#config.encryptionKey,
    );
    const payload = storedTargetPayloadSchema.parse({
      artwork: {
        backdrop: reference.artwork.backdropItemId !== null,
        poster: reference.artwork.posterItemId !== null,
      },
      catalogIdentityDigest,
      favorite,
      itemId: reference.itemId,
      kind: reference.kind,
      libraryReferenceId: reference.id,
      overview: null,
      resolutionState: favorite.state === "synced" ? "current" : "connector_unavailable",
      schemaVersion: 1,
      title: reference.title,
      year: reference.year,
    });

    try {
      return this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare(
              `delete from saved_targets
             where user_id = ? and (
               expires_at <= ? or service_identity_link_id <> ? or link_revision <> ?
             )`,
            )
            .run(userId, now, source.linkId, source.linkRevision);
          const targetId = this.#upsertTarget(
            userId,
            source,
            targetIdentityDigest,
            payload,
            now,
            expiresAt,
          );
          this.#enforceTargetLimit(userId, targetId);
          return savedMembershipSummarySchema.parse(
            this.#membershipSummary(
              userId,
              targetId,
              catalogIdentityDigest,
              favorite,
              now,
              expiresAt,
            ),
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof SavedTargetServiceError) throw error;
      throw new SavedTargetServiceError("storage_failure", { cause: error });
    }
  }

  #upsertTarget(
    userId: string,
    source: SavedTargetSourceRow,
    identityDigest: string,
    payload: StoredSavedTarget,
    now: number,
    expiresAt: number,
  ) {
    const existing = this.#database.sqlite
      .prepare(
        `select id from saved_targets
         where user_id = ? and service_identity_link_id = ?
           and link_revision = ? and identity_digest = ?`,
      )
      .get(userId, source.linkId, source.linkRevision, identityDigest) as
      StoredTargetRow | undefined;
    if (existing) {
      if (!TARGET_ID_PATTERN.test(existing.id))
        throw new SavedTargetServiceError("storage_failure");
      const updated = this.#database.sqlite
        .prepare(
          `update saved_targets
           set encrypted_payload = ?, last_used_at = ?, expires_at = ?, updated_at = ?
           where id = ? and user_id = ?`,
        )
        .run(
          this.#cipher.encrypt(JSON.stringify(payload), targetContext(userId, existing.id)),
          now,
          expiresAt,
          now,
          existing.id,
          userId,
        );
      if (updated.changes !== 1) throw new SavedTargetServiceError("storage_failure");
      return existing.id;
    }

    for (let attempt = 0; attempt < MAX_TARGET_CREATION_ATTEMPTS; attempt += 1) {
      const id = `save_target_${this.#createTargetToken()}`;
      if (!TARGET_ID_PATTERN.test(id)) throw new SavedTargetServiceError("storage_failure");
      try {
        this.#database.sqlite
          .prepare(
            `insert into saved_targets (
               id, user_id, service_identity_link_id, link_revision, identity_digest,
               encrypted_payload, last_used_at, expires_at, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            userId,
            source.linkId,
            source.linkRevision,
            identityDigest,
            this.#cipher.encrypt(JSON.stringify(payload), targetContext(userId, id)),
            now,
            expiresAt,
            now,
            now,
          );
        return id;
      } catch (error) {
        const collision = this.#database.sqlite
          .prepare("select 1 from saved_targets where id = ?")
          .get(id);
        if (!collision) throw error;
      }
    }
    throw new SavedTargetServiceError("storage_failure");
  }

  #membershipSummary(
    userId: string,
    targetId: string,
    catalogIdentityDigest: string,
    favorite: SavedFavoriteState,
    issuedAt: number,
    expiresAt: number,
  ) {
    const catalog = this.#database.sqlite
      .prepare(
        `select
           saved_catalog_items.id as id,
           coalesce(max(case when saved_lists.kind = 'watch_later' then 1 else 0 end), 0) as watchLater,
           count(distinct case when saved_lists.kind = 'custom' then saved_lists.id end) as customListCount
         from saved_catalog_items
         left join saved_list_items
           on saved_list_items.catalog_item_id = saved_catalog_items.id
         left join saved_lists
           on saved_lists.id = saved_list_items.list_id and saved_lists.deleted_at is null
         where saved_catalog_items.user_id = ? and saved_catalog_items.identity_digest = ?
         group by saved_catalog_items.id`,
      )
      .get(userId, catalogIdentityDigest) as CatalogMembershipRow | undefined;
    if (catalog && !CATALOG_ID_PATTERN.test(catalog.id)) {
      throw new SavedTargetServiceError("storage_failure");
    }
    return {
      catalogReferenceId: catalog?.id ?? null,
      customListCount: catalog?.customListCount ?? 0,
      expiresAt: new Date(expiresAt).toISOString(),
      favorite,
      issuedAt: new Date(issuedAt).toISOString(),
      targetReferenceId: targetId,
      watchLater: catalog?.watchLater === 1,
    };
  }

  #enforceTargetLimit(userId: string, protectedId: string) {
    const count = this.#database.sqlite
      .prepare("select count(*) as count from saved_targets where user_id = ?")
      .get(userId) as { count: number };
    if (count.count <= MAX_TARGETS_PER_USER) return;
    this.#database.sqlite
      .prepare(
        `delete from saved_targets where id in (
           select id from saved_targets
           where user_id = ? and id <> ?
           order by last_used_at asc, id asc
           limit ?
         )`,
      )
      .run(userId, protectedId, count.count - MAX_TARGETS_PER_USER);
  }

  #client(row: SavedTargetSourceRow) {
    const secrets = connectorSecrets(row, this.#cipher);
    const token = accessToken(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (!tlsPolicy) throw new SavedTargetConfigurationError();
    try {
      return this.#createClient({
        accessToken: token,
        baseUrl: row.baseUrl,
        connectorId: row.connectorId,
        deviceId: row.deviceId,
        displayName: safeDisplayName(row.connectorDisplayName),
        insecureHttpApproved: row.insecureHttpApproved === 1,
        tlsPolicy,
        ...secrets,
      });
    } catch (error) {
      throw new SavedTargetConfigurationError("invalid", { cause: error });
    }
  }

  #source(principal: SessionPrincipal) {
    const userId = principal.userId;
    const linkedService = principal.linkedServices.find(({ service }) => service === "jellyfin");
    if (!userId || !linkedService) throw new SavedTargetServiceError("principal_unavailable");
    const row = this.#database.sqlite
      .prepare(
        `select
           l.id as linkId, l.user_id as linkUserId, l.service as linkService,
           l.device_id as deviceId, l.external_user_id as externalUserId,
           l.encrypted_access_token as encryptedAccessToken,
           l.health_state as linkHealthState, l.revision as linkRevision,
           c.id as connectorId, c.type as connectorType,
           c.display_name as connectorDisplayName, c.base_url as baseUrl,
           c.encrypted_credentials as encryptedCredentials, c.tls_policy as tlsPolicy,
           c.insecure_http_approved as insecureHttpApproved, c.enabled as connectorEnabled
         from service_identity_links l
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.id = ? and l.user_id = ?`,
      )
      .get(linkedService.id, userId) as SavedTargetSourceRow | undefined;
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
      throw new SavedTargetServiceError("principal_unavailable");
    }
    return row;
  }

  #now() {
    const value = this.#clock().getTime();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 8_640_000_000_000_000 - TARGET_TTL_MS
    ) {
      throw new SavedTargetServiceError("storage_failure");
    }
    return value;
  }
}
