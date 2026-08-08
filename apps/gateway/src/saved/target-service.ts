import { JellyfinUserMediaClient } from "@omnifin/connectors/media/jellyfin-user-media-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { connectorCredentialInputSchema } from "@omnifin/contracts/connectors";
import type { DiscoveryMediaDetail } from "@omnifin/contracts/discovery";
import {
  savedDiscoveryTargetIssueRequestSchema,
  savedFavoriteMutationRequestSchema,
  savedFavoriteMutationResponseSchema,
  savedFavoriteStateSchema,
  savedListIdempotencyKeySchema,
  savedMembershipSummarySchema,
  type SavedFavoriteMutationResponse,
  type SavedFavoriteState,
  type SavedDiscoveryTargetIssueRequest,
  type SavedMembershipSummary,
} from "@omnifin/contracts/saved";
import { X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";
import { DiscoverySearchService } from "../discovery/search-service.js";
import {
  ExternalMutationJournal,
  ExternalMutationJournalError,
  type ExternalMutationRecord,
} from "../operations/external-mutation-journal.js";
import {
  MediaReferenceError,
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "../media/media-reference-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TARGET_ID_PATTERN = /^save_target_[A-Za-z0-9_-]{22}$/u;
const CATALOG_ID_PATTERN = /^catalog_[A-Za-z0-9_-]{22}$/u;
const OPERATION_ID_PATTERN = /^saved_operation_[A-Za-z0-9_-]{22}$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TARGET_TTL_MS = 15 * 60 * 1_000;
const FAVORITE_PENDING_RECONCILE_MS = 30_000;
const FAVORITE_DISPATCH_LEASE_MS = 30_000;
const MAX_TARGETS_PER_USER = 1_024;
const MAX_TARGET_CREATION_ATTEMPTS = 8;

export const storedSavedCatalogSnapshotSchema = z.strictObject({
  availability: z.enum(["owned", "requestable", "requested", "unavailable"]).default("owned"),
  artwork: z.strictObject({ backdrop: z.boolean(), poster: z.boolean() }),
  favorite: savedFavoriteStateSchema,
  kind: z.enum(["movie", "series"]),
  overview: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .nullable(),
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

const storedFavoriteStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("synced"), value: z.boolean() }),
  z.strictObject({ state: z.literal("unavailable"), value: z.boolean().nullable() }),
]);

const storedOwnedTargetPayloadSchema = z.strictObject({
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
  source: z.literal("jellyfin").default("jellyfin"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  year: z.int().min(1870).max(2200).nullable(),
});

const storedDiscoveryTargetPayloadSchema = z.strictObject({
  artwork: z.strictObject({
    backdrop: z.literal(false),
    poster: z.literal(false),
  }),
  availability: z.enum(["requestable", "requested"]),
  catalogIdentityDigest: z.string().regex(DIGEST_PATTERN),
  favorite: z.strictObject({ state: z.literal("not_applicable"), value: z.null() }),
  kind: z.enum(["movie", "series"]),
  libraryReferenceId: z.null(),
  overview: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .nullable(),
  resolutionState: z.literal("current"),
  schemaVersion: z.literal(1),
  source: z.literal("seerr"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  tmdbId: z.int().positive().max(2_147_483_647),
  year: z.int().min(1870).max(2200).nullable(),
});

export const storedTargetPayloadSchema = z.discriminatedUnion("source", [
  storedOwnedTargetPayloadSchema,
  storedDiscoveryTargetPayloadSchema,
]);

export type StoredSavedTarget = z.infer<typeof storedTargetPayloadSchema>;

interface SavedTargetSourceRow {
  baseUrl: string;
  connectorDisplayName: string;
  connectorEnabled: number;
  connectorId: string;
  connectorConfigGeneration: number;
  connectorInstanceGeneration: number;
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

interface ResolvedTargetRow {
  encryptedPayload: string;
  expiresAt: number;
  linkRevision: number;
  serviceIdentityLinkId: string;
}

interface CatalogMembershipRow {
  id: string;
  watchLater: number;
}

interface CustomListMembershipRow {
  id: string;
}

interface FavoriteCatalogRow {
  encryptedSnapshot: string;
  id: string;
}

interface FavoriteOperation {
  fingerprintHash: string;
  id: string;
  idempotencyKeyHash: string;
  resourceId: string;
  userId: string;
}

interface FavoriteOperationRow {
  encryptedResponse: string | null;
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  kind: string;
  state: string;
  updatedAt: number;
}

export interface SavedTargetContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface ResolvedSavedTarget {
  linkId: string;
  linkRevision: number;
  payload: StoredSavedTarget;
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
  createAuditId?: () => string;
  createClient?: (input: SavedTargetClientFactoryInput) => SavedTargetClient;
  createDispatchToken?: () => string;
  createLeaseToken?: () => string;
  createOperationToken?: () => string;
  createTargetToken?: () => string;
  mediaReferences?: MediaReferenceDependencies;
  resolveDiscovery?: (
    input: SavedDiscoveryTargetIssueRequest,
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ) => Promise<DiscoveryMediaDetail>;
}

export type SavedTargetErrorReason =
  | "connector_unavailable"
  | "expired"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "not_found"
  | "outcome_unknown"
  | "principal_unavailable"
  | "storage_failure"
  | "synchronization_failed";

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

function savedDiscoveryAvailability(
  availability: DiscoveryMediaDetail["availability"],
): "requestable" | "requested" {
  switch (availability) {
    case "partial":
    case "unavailable":
      return "requestable";
    case "processing":
    case "requested":
      return "requested";
    case "available":
      throw new SavedTargetServiceError("not_found");
    case "unknown":
      throw new SavedTargetServiceError("connector_unavailable");
  }
}

export class SavedTargetService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAuditId: () => string;
  readonly #createClient: (input: SavedTargetClientFactoryInput) => SavedTargetClient;
  readonly #createDispatchToken: () => string;
  readonly #createLeaseToken: () => string;
  readonly #createOperationToken: () => string;
  readonly #createTargetToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #journal: ExternalMutationJournal;
  readonly #references: MediaReferenceService;
  readonly #resolveDiscovery: NonNullable<SavedTargetServiceDependencies["resolveDiscovery"]>;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: SavedTargetServiceDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAuditId = dependencies.createAuditId ?? (() => `saved-audit-${randomToken(16)}`);
    this.#createDispatchToken = dependencies.createDispatchToken ?? (() => randomToken(16));
    this.#createLeaseToken = dependencies.createLeaseToken ?? (() => randomToken(16));
    this.#createOperationToken = dependencies.createOperationToken ?? (() => randomToken(16));
    this.#createTargetToken = dependencies.createTargetToken ?? (() => randomToken(16));
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#journal = new ExternalMutationJournal(database.sqlite, config.encryptionKey);
    this.#references = new MediaReferenceService(database, config, {
      ...dependencies.mediaReferences,
      clock: dependencies.mediaReferences?.clock ?? this.#clock,
    });
    const discovery = new DiscoverySearchService(database, config);
    this.#resolveDiscovery =
      dependencies.resolveDiscovery ??
      ((input, principal, signal) =>
        discovery
          .detail(
            { kind: input.kind, tmdbId: input.tmdbId },
            { language: input.language },
            { principal },
            signal,
          )
          .then(({ item }) => item));
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
      source: "jellyfin",
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

  public async issueDiscovery(
    rawInput: unknown,
    context: SavedTargetContext,
    signal?: AbortSignal,
  ): Promise<SavedMembershipSummary> {
    const principal = requirePermission(context.principal, "saved.lists.self.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new SavedTargetServiceError("principal_unavailable");
    }
    const userId = principal.userId;
    const input = savedDiscoveryTargetIssueRequestSchema.parse(rawInput);
    const source = this.#source(principal);
    let detail: DiscoveryMediaDetail;
    try {
      detail = await this.#resolveDiscovery(input, principal, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new SavedTargetServiceError("connector_unavailable", { cause: error });
    }
    if (detail.kind !== input.kind || detail.tmdbId !== input.tmdbId) {
      throw new SavedTargetServiceError("connector_unavailable");
    }

    const availability = savedDiscoveryAvailability(detail.availability);
    const now = this.#now();
    const expiresAt = now + TARGET_TTL_MS;
    const catalogIdentityDigest = privacyHash(
      "saved_catalog_identity",
      `tmdb\0${detail.kind}\0${detail.tmdbId}`,
      this.#config.encryptionKey,
    );
    const targetIdentityDigest = privacyHash(
      "saved_target",
      `tmdb\0${detail.kind}\0${detail.tmdbId}`,
      this.#config.encryptionKey,
    );
    const payload = storedTargetPayloadSchema.parse({
      artwork: { backdrop: false, poster: false },
      availability,
      catalogIdentityDigest,
      favorite: { state: "not_applicable", value: null },
      kind: detail.kind,
      libraryReferenceId: null,
      overview: detail.overview,
      resolutionState: "current",
      schemaVersion: 1,
      source: "seerr",
      title: detail.title,
      tmdbId: detail.tmdbId,
      year: detail.year,
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
              payload.favorite,
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

  public resolveOwned(targetReferenceId: string, context: SavedTargetContext): ResolvedSavedTarget {
    const principal = requirePermission(context.principal, "saved.lists.self.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new SavedTargetServiceError("principal_unavailable");
    }
    const source = this.#source(principal);
    const resolved = this.#resolveTarget(targetReferenceId, principal.userId, source);
    if (resolved.payload.source !== "jellyfin") {
      throw new SavedTargetServiceError("not_found");
    }
    return resolved;
  }

  public resolve(targetReferenceId: string, context: SavedTargetContext): ResolvedSavedTarget {
    const principal = requirePermission(context.principal, "saved.lists.self.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new SavedTargetServiceError("principal_unavailable");
    }
    return this.#resolveTarget(targetReferenceId, principal.userId, this.#source(principal));
  }

  public async updateFavorite(
    targetReferenceId: string,
    rawInput: unknown,
    rawIdempotencyKey: string,
    context: SavedTargetContext,
    signal?: AbortSignal,
  ): Promise<SavedFavoriteMutationResponse> {
    const principal = requirePermission(context.principal, "favorites.self.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new SavedTargetServiceError("principal_unavailable");
    }
    const activePrincipal = principal as SessionPrincipal & { userId: string };
    const input = savedFavoriteMutationRequestSchema.parse(rawInput);
    const idempotencyKey = savedListIdempotencyKeySchema.parse(rawIdempotencyKey);
    const source = this.#source(activePrincipal);
    if (source.linkHealthState !== "linked") {
      throw new SavedTargetServiceError("connector_unavailable");
    }
    const resolved = this.#resolveTarget(targetReferenceId, activePrincipal.userId, source);
    if (resolved.payload.source !== "jellyfin") {
      throw new SavedTargetServiceError("not_found");
    }
    const operation = this.#favoriteOperation(
      activePrincipal.userId,
      targetReferenceId,
      resolved,
      input.favorite,
      idempotencyKey,
    );
    const reservation = this.#reserveFavoriteOperation(operation, this.#now());
    if (reservation.kind === "replay") return reservation.response;

    const dispatch = this.#favoriteDispatch(operation, source, resolved, input.favorite);
    let observed = input.favorite;
    if (!dispatch.owned && dispatch.record.state === "reserved") {
      throw new SavedTargetServiceError("idempotency_in_progress");
    }
    if (dispatch.record.state === "failed") {
      throw new SavedTargetServiceError("connector_unavailable");
    }
    if (dispatch.record.state === "uncertain") {
      throw new SavedTargetServiceError("outcome_unknown");
    }
    if (dispatch.record.state !== "succeeded") {
      if (
        !dispatch.owned &&
        (dispatch.record.connectorId !== source.connectorId ||
          dispatch.record.connectorInstanceGeneration !== source.connectorInstanceGeneration ||
          dispatch.record.connectorConfigGeneration !== source.connectorConfigGeneration)
      ) {
        this.#markFavoriteReconcileRequired(operation, "generation_mismatch");
        throw new SavedTargetServiceError("outcome_unknown");
      }
      const client = this.#client(source);
      const target = { itemId: resolved.payload.itemId, userId: source.externalUserId };
      if (!dispatch.owned) this.#markFavoriteDispatchReconcile(dispatch.record.id);
      try {
        this.#assertFavoriteGeneration(source);
        observed = await client.readFavoriteState(target, signal);
      } catch (error) {
        if (dispatch.owned && this.#journal.read(dispatch.record.id)?.state === "reserved") {
          this.#journal.completeFailed({
            failureCode: "readback_unavailable",
            id: dispatch.record.id,
            now: this.#now(),
          });
          this.#failFavoriteOperation(operation, "readback_unavailable");
          throw new SavedTargetServiceError("connector_unavailable", { cause: error });
        }
        this.#markFavoriteReconcileRequired(operation, "readback_unavailable");
        throw new SavedTargetServiceError("outcome_unknown", { cause: error });
      }

      if (observed === input.favorite) {
        if (dispatch.owned) {
          this.#markFavoriteDispatchBoundary(
            dispatch.record,
            dispatch.leaseOwner!,
            source,
            operation,
          );
        }
        this.#journal.completeSucceeded({ id: dispatch.record.id, now: this.#now() });
      } else {
        if (!dispatch.owned) {
          this.#markFavoriteReconcileRequired(operation, "intervening_change");
          throw new SavedTargetServiceError("synchronization_failed");
        }
        this.#markFavoriteDispatchBoundary(
          dispatch.record,
          dispatch.leaseOwner!,
          source,
          operation,
        );
        try {
          this.#assertFavoriteGeneration(source);
          await client.updateFavoriteState({ favorite: input.favorite, ...target }, signal);
          observed = await client.readFavoriteState(target, signal);
        } catch (error) {
          this.#markFavoriteDispatchReconcile(dispatch.record.id);
          this.#markFavoriteReconcileRequired(operation, "outcome_unknown");
          throw new SavedTargetServiceError("outcome_unknown", { cause: error });
        }
        if (observed === input.favorite) {
          this.#journal.completeSucceeded({ id: dispatch.record.id, now: this.#now() });
        } else {
          this.#markFavoriteDispatchReconcile(dispatch.record.id);
          this.#markFavoriteReconcileRequired(operation, "not_confirmed");
        }
      }
    }
    if (observed !== input.favorite) {
      throw new SavedTargetServiceError("synchronization_failed");
    }
    const now = this.#now();
    const response = savedFavoriteMutationResponseSchema.parse({
      favorite: observed,
      synchronizedAt: new Date(now).toISOString(),
      targetReferenceId,
    });
    try {
      this.#database.sqlite
        .transaction(() => {
          const payload = storedTargetPayloadSchema.parse({
            ...resolved.payload,
            favorite: { state: "synced", value: observed },
            resolutionState: "current",
          });
          const updatedTarget = this.#database.sqlite
            .prepare(
              `update saved_targets set encrypted_payload = ?, updated_at = ?
               where id = ? and user_id = ? and expires_at > ?`,
            )
            .run(
              this.#cipher.encrypt(
                JSON.stringify(payload),
                targetContext(activePrincipal.userId, targetReferenceId),
              ),
              now,
              targetReferenceId,
              activePrincipal.userId,
              now,
            );
          if (updatedTarget.changes !== 1) throw new SavedTargetServiceError("expired");
          const catalog = this.#refreshCatalogFavorite(
            activePrincipal.userId,
            payload.catalogIdentityDigest,
            observed,
            now,
          );
          this.#auditFavorite(
            activePrincipal,
            payload.catalogIdentityDigest,
            catalog?.id ?? null,
            observed,
            context,
            now,
          );
          this.#completeFavoriteOperation(operation, response, now);
        })
        .immediate();
      return response;
    } catch (error) {
      this.#markFavoriteReconcileRequired(operation, "outcome_unknown");
      throw new SavedTargetServiceError("outcome_unknown", { cause: error });
    }
  }

  #favoriteDispatch(
    operation: FavoriteOperation,
    source: SavedTargetSourceRow,
    resolved: ResolvedSavedTarget,
    favorite: boolean,
  ): { leaseOwner: string | null; owned: boolean; record: ExternalMutationRecord } {
    const parentOperationType = "saved_list_operation" as const;
    const existing = this.#journal.replay({
      kind: "saved.favorite",
      parentOperationId: operation.id,
      parentOperationType,
    });
    if (existing) {
      if (existing.state !== "reserved") {
        return { leaseOwner: null, owned: false, record: existing };
      }
      const now = this.#now();
      if (
        existing.leaseOwner === null ||
        existing.leaseExpiresAt === null ||
        existing.leaseExpiresAt >= now
      ) {
        return { leaseOwner: null, owned: false, record: existing };
      }
      const leaseOwner = this.#favoriteLeaseOwner();
      return {
        leaseOwner,
        owned: true,
        record: this.#journal.claimStaleReserved({
          expectedLeaseExpiresAt: existing.leaseExpiresAt,
          expectedLeaseOwner: existing.leaseOwner,
          id: existing.id,
          leaseExpiresAt: now + FAVORITE_DISPATCH_LEASE_MS,
          leaseOwner,
          now,
        }),
      };
    }

    const now = this.#now();
    const leaseOwner = this.#favoriteLeaseOwner();
    try {
      return {
        leaseOwner,
        owned: true,
        record: this.#journal.reserve({
          connectorConfigGeneration: source.connectorConfigGeneration,
          connectorId: source.connectorId,
          connectorInstanceGeneration: source.connectorInstanceGeneration,
          id: this.#favoriteDispatchId(),
          kind: "saved.favorite",
          leaseExpiresAt: now + FAVORITE_DISPATCH_LEASE_MS,
          leaseOwner,
          normalizedRequest: {
            favorite,
            itemId: resolved.payload.source === "jellyfin" ? resolved.payload.itemId : "invalid",
            userId: source.externalUserId,
            version: 1,
          },
          now,
          parentOperationId: operation.id,
          parentOperationType,
          targetDigest: hashToken(
            `saved_favorite_target\0${source.connectorId}\0${source.externalUserId}\0${
              resolved.payload.source === "jellyfin" ? resolved.payload.itemId : "invalid"
            }`,
          ),
          userId: operation.userId,
        }),
      };
    } catch (error) {
      if (
        error instanceof ExternalMutationJournalError &&
        (error.code === "target_locked" || error.code === "reservation_conflict")
      ) {
        throw new SavedTargetServiceError("idempotency_in_progress", { cause: error });
      }
      throw new SavedTargetServiceError("storage_failure", { cause: error });
    }
  }

  #markFavoriteDispatchBoundary(
    dispatch: ExternalMutationRecord,
    leaseOwner: string,
    source: SavedTargetSourceRow,
    operation: FavoriteOperation,
  ) {
    try {
      this.#database.sqlite
        .transaction(() => {
          if (
            dispatch.connectorId !== source.connectorId ||
            dispatch.connectorInstanceGeneration !== source.connectorInstanceGeneration ||
            dispatch.connectorConfigGeneration !== source.connectorConfigGeneration
          ) {
            throw new SavedTargetServiceError("connector_unavailable");
          }
          this.#assertFavoriteGeneration(source);
          this.#journal.markDispatched({ id: dispatch.id, leaseOwner, now: this.#now() });
        })
        .immediate();
    } catch (error) {
      if (error instanceof SavedTargetServiceError && error.reason === "connector_unavailable") {
        const current = this.#journal.read(dispatch.id);
        if (current?.state === "reserved") {
          this.#journal.completeFailed({
            failureCode: "generation_mismatch",
            id: current.id,
            now: this.#now(),
          });
          this.#failFavoriteOperation(operation, "generation_mismatch");
        }
      }
      if (error instanceof SavedTargetServiceError) throw error;
      throw new SavedTargetServiceError("storage_failure", { cause: error });
    }
  }

  #assertFavoriteGeneration(source: SavedTargetSourceRow) {
    const current = this.#database.sqlite
      .prepare(
        `select instance_generation as instanceGeneration,
                config_generation as configGeneration, enabled, type
           from connector_configs where id = ? limit 1`,
      )
      .get(source.connectorId) as
      | { configGeneration: number; enabled: number; instanceGeneration: number; type: string }
      | undefined;
    if (
      !current ||
      current.enabled !== 1 ||
      current.type !== "jellyfin" ||
      current.instanceGeneration !== source.connectorInstanceGeneration ||
      current.configGeneration !== source.connectorConfigGeneration
    ) {
      throw new SavedTargetServiceError("connector_unavailable");
    }
  }

  #markFavoriteDispatchReconcile(id: string) {
    const current = this.#journal.read(id);
    if (current?.state === "dispatched") {
      this.#journal.markReconcileRequired({
        failureCode: "outcome_unknown",
        id,
        now: this.#now(),
      });
    }
  }

  #failFavoriteOperation(operation: FavoriteOperation, failureCode: string) {
    const now = this.#now();
    const updated = this.#database.sqlite
      .prepare(
        `update saved_list_operations
            set state = 'failed', encrypted_response = null, failure_code = ?,
                completed_at = ?, updated_at = ?
          where id = ? and user_id = ? and kind = 'favorite'
            and state in ('pending', 'reconcile_required')`,
      )
      .run(failureCode, now, now, operation.id, operation.userId);
    if (updated.changes !== 1) throw new SavedTargetServiceError("storage_failure");
  }

  #favoriteDispatchId() {
    const id = `mutation_dispatch_${this.#createDispatchToken()}`;
    if (!/^mutation_dispatch_[A-Za-z0-9_-]{22}$/u.test(id)) {
      throw new SavedTargetServiceError("storage_failure");
    }
    return id;
  }

  #favoriteLeaseOwner() {
    const owner = `saved-favorite-${this.#createLeaseToken()}`;
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(owner)) {
      throw new SavedTargetServiceError("storage_failure");
    }
    return owner;
  }

  #favoriteOperation(
    userId: string,
    targetReferenceId: string,
    resolved: ResolvedSavedTarget,
    favorite: boolean,
    idempotencyKey: string,
  ): FavoriteOperation {
    const id = `saved_operation_${this.#createOperationToken()}`;
    if (!OPERATION_ID_PATTERN.test(id)) throw new SavedTargetServiceError("storage_failure");
    return {
      fingerprintHash: privacyHash(
        "saved_operation",
        JSON.stringify({
          catalogIdentityDigest: resolved.payload.catalogIdentityDigest,
          favorite,
          kind: "favorite",
          linkId: resolved.linkId,
          linkRevision: resolved.linkRevision,
        }),
        this.#config.encryptionKey,
      ),
      id,
      idempotencyKeyHash: hashToken(`${userId}\0saved_favorite\0${idempotencyKey}`),
      resourceId: targetReferenceId,
      userId,
    };
  }

  #reserveFavoriteOperation(
    operation: FavoriteOperation,
    now: number,
  ):
    | { failureCode: string | null; kind: "new" | "reconcile" }
    | { kind: "replay"; response: SavedFavoriteMutationResponse } {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const existing = this.#database.sqlite
            .prepare(
              `select id, kind, fingerprint_hash as fingerprintHash, state,
                      encrypted_response as encryptedResponse, failure_code as failureCode,
                      updated_at as updatedAt
               from saved_list_operations
               where user_id = ? and idempotency_key_hash = ?`,
            )
            .get(operation.userId, operation.idempotencyKeyHash) as
            FavoriteOperationRow | undefined;
          if (existing) {
            if (
              existing.kind !== "favorite" ||
              existing.fingerprintHash !== operation.fingerprintHash
            ) {
              throw new SavedTargetServiceError("idempotency_conflict");
            }
            operation.id = existing.id;
            if (existing.state === "succeeded" && existing.encryptedResponse !== null) {
              return {
                kind: "replay" as const,
                response: savedFavoriteMutationResponseSchema.parse(
                  JSON.parse(
                    this.#cipher.decrypt(
                      existing.encryptedResponse,
                      `saved_list_operation:${operation.userId}:${existing.id}`,
                    ),
                  ),
                ),
              };
            }
            if (
              existing.state === "pending" &&
              existing.updatedAt > now - FAVORITE_PENDING_RECONCILE_MS
            ) {
              throw new SavedTargetServiceError("idempotency_in_progress");
            }
            const claimed = this.#database.sqlite
              .prepare(
                `update saved_list_operations
                 set state = 'pending', encrypted_response = null, failure_code = null,
                     completed_at = null, updated_at = ?
                 where id = ? and user_id = ? and kind = 'favorite'
                   and state = ? and updated_at = ?`,
              )
              .run(now, existing.id, operation.userId, existing.state, existing.updatedAt);
            if (claimed.changes !== 1) {
              throw new SavedTargetServiceError("idempotency_in_progress");
            }
            return { failureCode: existing.failureCode, kind: "reconcile" as const };
          }
          this.#database.sqlite
            .prepare(
              `insert into saved_list_operations (
                 id, user_id, kind, resource_id, idempotency_key_hash, fingerprint_hash,
                 state, encrypted_response, failure_code, completed_at, created_at, updated_at
               ) values (?, ?, 'favorite', ?, ?, ?, 'pending', null, null, null, ?, ?)`,
            )
            .run(
              operation.id,
              operation.userId,
              operation.resourceId,
              operation.idempotencyKeyHash,
              operation.fingerprintHash,
              now,
              now,
            );
          return { failureCode: null, kind: "new" as const };
        })
        .immediate();
    } catch (error) {
      if (error instanceof SavedTargetServiceError) throw error;
      throw new SavedTargetServiceError("storage_failure", { cause: error });
    }
  }

  #completeFavoriteOperation(
    operation: FavoriteOperation,
    response: SavedFavoriteMutationResponse,
    now: number,
  ) {
    const updated = this.#database.sqlite
      .prepare(
        `update saved_list_operations
         set state = 'succeeded', encrypted_response = ?, failure_code = null,
             completed_at = ?, updated_at = ?
         where id = ? and user_id = ? and kind = 'favorite'
           and state in ('pending', 'reconcile_required')`,
      )
      .run(
        this.#cipher.encrypt(
          JSON.stringify(response),
          `saved_list_operation:${operation.userId}:${operation.id}`,
        ),
        now,
        now,
        operation.id,
        operation.userId,
      );
    if (updated.changes !== 1) throw new SavedTargetServiceError("storage_failure");
  }

  #markFavoriteReconcileRequired(operation: FavoriteOperation, failureCode: string) {
    try {
      const now = this.#now();
      this.#database.sqlite
        .prepare(
          `update saved_list_operations
           set state = 'reconcile_required', encrypted_response = null,
               failure_code = ?, completed_at = ?, updated_at = ?
           where id = ? and user_id = ? and kind = 'favorite'
             and state in ('pending', 'reconcile_required')`,
        )
        .run(failureCode, now, now, operation.id, operation.userId);
    } catch {
      // The durable pending intent still prevents a false success response.
    }
  }

  #resolveTarget(
    targetReferenceId: string,
    userId: string,
    source: SavedTargetSourceRow,
  ): ResolvedSavedTarget {
    if (!TARGET_ID_PATTERN.test(targetReferenceId)) {
      throw new SavedTargetServiceError("not_found");
    }
    const now = this.#now();
    try {
      const row = this.#database.sqlite
        .prepare(
          `select encrypted_payload as encryptedPayload, expires_at as expiresAt,
                  link_revision as linkRevision,
                  service_identity_link_id as serviceIdentityLinkId
           from saved_targets
           where id = ? and user_id = ?`,
        )
        .get(targetReferenceId, userId) as ResolvedTargetRow | undefined;
      if (!row) {
        throw new SavedTargetServiceError("not_found");
      }
      if (row.expiresAt <= now) throw new SavedTargetServiceError("expired");
      if (row.serviceIdentityLinkId !== source.linkId || row.linkRevision !== source.linkRevision) {
        throw new SavedTargetServiceError("not_found");
      }
      const payload = storedTargetPayloadSchema.parse(
        JSON.parse(
          this.#cipher.decrypt(row.encryptedPayload, targetContext(userId, targetReferenceId)),
        ),
      );
      if (payload.source === "jellyfin") {
        const reference = this.#references.resolve(
          { linkId: source.linkId, linkRevision: source.linkRevision, userId },
          payload.libraryReferenceId,
        );
        if (
          reference.itemId !== payload.itemId ||
          reference.kind !== payload.kind ||
          reference.title !== payload.title
        ) {
          throw new SavedTargetServiceError("not_found");
        }
      }
      const touched = this.#database.sqlite
        .prepare(
          `update saved_targets set last_used_at = ?
           where id = ? and user_id = ? and expires_at > ?`,
        )
        .run(now, targetReferenceId, userId, now);
      if (touched.changes !== 1) throw new SavedTargetServiceError("not_found");
      return { linkId: source.linkId, linkRevision: source.linkRevision, payload };
    } catch (error) {
      if (error instanceof SavedTargetServiceError) throw error;
      if (error instanceof MediaReferenceError) {
        throw new SavedTargetServiceError("not_found", { cause: error });
      }
      throw new SavedTargetServiceError("storage_failure", { cause: error });
    }
  }

  #refreshCatalogFavorite(userId: string, identityDigest: string, favorite: boolean, now: number) {
    const catalog = this.#database.sqlite
      .prepare(
        `select id, encrypted_snapshot as encryptedSnapshot
         from saved_catalog_items where user_id = ? and identity_digest = ?`,
      )
      .get(userId, identityDigest) as FavoriteCatalogRow | undefined;
    if (!catalog) return null;
    if (!CATALOG_ID_PATTERN.test(catalog.id)) throw new SavedTargetServiceError("storage_failure");
    let snapshot: z.infer<typeof storedSavedCatalogSnapshotSchema>;
    try {
      snapshot = storedSavedCatalogSnapshotSchema.parse(
        JSON.parse(
          this.#cipher.decrypt(
            catalog.encryptedSnapshot,
            `saved_catalog_snapshot:${userId}:${catalog.id}`,
          ),
        ),
      );
    } catch (error) {
      throw new SavedTargetServiceError("storage_failure", { cause: error });
    }
    const snapshotChanged =
      snapshot.resolutionState !== "current" ||
      snapshot.favorite.state !== "synced" ||
      snapshot.favorite.value !== favorite;
    if (!snapshotChanged) {
      const touched = this.#database.sqlite
        .prepare(
          `update saved_catalog_items set last_resolved_at = ?, updated_at = ?
           where id = ? and user_id = ? and identity_digest = ?`,
        )
        .run(now, now, catalog.id, userId, identityDigest);
      if (touched.changes !== 1) throw new SavedTargetServiceError("storage_failure");
      return catalog;
    }
    const exhausted = this.#database.sqlite
      .prepare(
        `select 1
         from saved_lists
         join saved_list_items on saved_list_items.list_id = saved_lists.id
         where saved_lists.user_id = ? and saved_lists.deleted_at is null
           and saved_list_items.catalog_item_id = ? and saved_lists.revision >= 2147483647
         limit 1`,
      )
      .get(userId, catalog.id);
    if (exhausted) throw new SavedTargetServiceError("storage_failure");
    const updated = this.#database.sqlite
      .prepare(
        `update saved_catalog_items set encrypted_snapshot = ?, last_resolved_at = ?, updated_at = ?
         where id = ? and user_id = ? and identity_digest = ?`,
      )
      .run(
        this.#cipher.encrypt(
          JSON.stringify({
            ...snapshot,
            favorite: { state: "synced", value: favorite },
            resolutionState: "current",
          }),
          `saved_catalog_snapshot:${userId}:${catalog.id}`,
        ),
        now,
        now,
        catalog.id,
        userId,
        identityDigest,
      );
    if (updated.changes !== 1) throw new SavedTargetServiceError("storage_failure");
    this.#database.sqlite
      .prepare(
        `update saved_lists set revision = revision + 1, updated_at = ?
         where user_id = ? and deleted_at is null and id in (
           select list_id from saved_list_items where user_id = ? and catalog_item_id = ?
         )`,
      )
      .run(now, userId, userId, catalog.id);
    return catalog;
  }

  #auditFavorite(
    principal: SessionPrincipal & { userId: string },
    identityDigest: string,
    catalogId: string | null,
    favorite: boolean,
    context: SavedTargetContext,
    createdAt: number,
  ) {
    const id = this.#createAuditId();
    if (!IDENTIFIER_PATTERN.test(id)) throw new SavedTargetServiceError("storage_failure");
    const targetId =
      catalogId ??
      `saved-favorite-${privacyHash(
        "saved_favorite_audit",
        identityDigest,
        this.#config.encryptionKey,
      )}`;
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method,
           event_type, outcome, target_type, target_id, request_id,
           metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, 'saved.favorite.changed', 'success', 'saved_favorite', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        principal.userId,
        principal.sessionId,
        principal.authenticationMethod.kind,
        targetId,
        context.requestId ?? null,
        JSON.stringify({ catalogLinked: catalogId !== null, favorite }),
        context.ipAddress
          ? privacyHash("rate_limit_client", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
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
           coalesce(max(case when saved_lists.kind = 'watch_later' then 1 else 0 end), 0) as watchLater
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
    const customListIds = catalog
      ? (
          this.#database.sqlite
            .prepare(
              `select saved_lists.id as id
               from saved_lists
               join saved_list_items on saved_list_items.list_id = saved_lists.id
               where saved_lists.user_id = ? and saved_lists.deleted_at is null
                 and saved_lists.kind = 'custom' and saved_list_items.catalog_item_id = ?
               order by saved_lists.created_at asc, saved_lists.id asc
               limit ?`,
            )
            .all(userId, catalog.id, 50) as CustomListMembershipRow[]
        ).map(({ id }) => id)
      : [];
    return {
      catalogReferenceId: catalog?.id ?? null,
      customListCount: customListIds.length,
      customListIds,
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
           c.instance_generation as connectorInstanceGeneration,
           c.config_generation as connectorConfigGeneration,
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
      !Number.isSafeInteger(row.connectorInstanceGeneration) ||
      row.connectorInstanceGeneration < 0 ||
      !Number.isSafeInteger(row.connectorConfigGeneration) ||
      row.connectorConfigGeneration < 0 ||
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
