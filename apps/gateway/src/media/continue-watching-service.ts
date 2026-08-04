import {
  RadarrAdapter,
  type RadarrLibraryMovieOwnership,
} from "@omnifin/connectors/adapters/radarr";
import {
  JellyfinUserMediaClient,
  type JellyfinContinueWatchingResult,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import type { ApiKeyConnectorConfig, ConnectorTargetConfig } from "@omnifin/connectors/types";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  continueWatchingResponseSchema,
  type ContinueWatchingResponse,
} from "@omnifin/contracts/dashboard";
import {
  libraryBrowseKindSchema,
  libraryBrowseQuerySchema,
  libraryBrowseResponseSchema,
  libraryBrowseSortSchema,
  libraryExtrasQuerySchema,
  libraryExtrasResponseSchema,
  libraryMutationIdempotencyKeySchema,
  libraryPlaybackStateMutationRequestSchema,
  libraryPlaybackStateMutationResponseSchema,
  libraryRemovalPreviewSchema,
  librarySeasonEpisodesQuerySchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseSchema,
  viewingHistoryKindSchema,
  viewingHistoryQuerySchema,
  viewingHistoryRangeSchema,
  viewingHistoryResponseSchema,
  viewingHistoryStateSchema,
  type LibraryBrowseQuery,
  type LibraryBrowseResponse,
  type LibraryExtrasQuery,
  type LibraryExtrasResponse,
  type LibraryPlaybackStateMutationRequest,
  type LibraryPlaybackStateMutationResponse,
  type LibraryRemovalPreview,
  type LibrarySeasonEpisodesQuery,
  type LibrarySeasonEpisodesResponse,
  type LibraryTitleDetailResponse,
  type ViewingHistoryQuery,
  type ViewingHistoryResponse,
} from "@omnifin/contracts/library";
import { connectorCredentialInputSchema, type PartialFailure } from "@omnifin/contracts/connectors";
import type { DiscoveryTrailer } from "@omnifin/contracts/discovery";
import { createHash, X509Certificate } from "node:crypto";
import { z, ZodError } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";
import { DiscoverySearchError, DiscoverySearchService } from "../discovery/search-service.js";
import {
  MediaReferenceError,
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "./media-reference-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UPSTREAM_MEDIA_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_USER_MEDIA_STATE_OPERATIONS_PER_USER = 4_096;
const STALE_USER_MEDIA_STATE_OPERATION_MS = 5 * 60 * 1_000;
const USER_MEDIA_STATE_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const USER_MEDIA_STATE_OPERATION_ID_PATTERN = /^user_media_state_[A-Za-z0-9_-]{22}$/u;
const LIBRARY_REMOVAL_PREVIEW_TTL_MS = 5 * 60 * 1_000;
const libraryPersonImagePayloadSchema = z.strictObject({
  itemId: z.string().regex(UPSTREAM_MEDIA_IDENTIFIER_PATTERN),
  version: z.literal(1),
});
const libraryCursorPayloadSchema = z.strictObject({
  kind: libraryBrowseKindSchema,
  limit: z.int().positive().max(50),
  linkId: z.string().regex(IDENTIFIER_PATTERN),
  linkRevision: z.int().nonnegative().max(2_147_483_647),
  query: z.string().min(1).max(100).nullable(),
  sort: libraryBrowseSortSchema,
  startIndex: z.int().nonnegative().max(1_000_000),
  version: z.literal(1),
});
type LibraryCursorPayload = z.infer<typeof libraryCursorPayloadSchema>;

const libraryExtrasCursorPayloadSchema = z.strictObject({
  limit: z.int().positive().max(24),
  linkId: z.string().regex(IDENTIFIER_PATTERN),
  linkRevision: z.int().nonnegative().max(2_147_483_647),
  parentReferenceId: z.string().regex(/^media_[A-Za-z0-9_-]{22}$/u),
  startIndex: z.int().nonnegative().max(1_000_000),
  version: z.literal(1),
});
type LibraryExtrasCursorPayload = z.infer<typeof libraryExtrasCursorPayloadSchema>;

const librarySeasonCursorPayloadSchema = z.strictObject({
  limit: z.int().positive().max(50),
  linkId: z.string().regex(IDENTIFIER_PATTERN),
  linkRevision: z.int().nonnegative().max(2_147_483_647),
  seasonNumber: z.int().nonnegative().max(100_000),
  startIndex: z.int().nonnegative().max(1_000_000),
  titleReferenceId: z.string().regex(/^media_[A-Za-z0-9_-]{22}$/u),
  version: z.literal(1),
});
type LibrarySeasonCursorPayload = z.infer<typeof librarySeasonCursorPayloadSchema>;

const viewingHistoryCursorPayloadSchema = z.strictObject({
  afterItemId: z.string().regex(UPSTREAM_MEDIA_IDENTIFIER_PATTERN),
  kind: viewingHistoryKindSchema,
  limit: z.int().positive().max(50),
  linkId: z.string().regex(IDENTIFIER_PATTERN),
  linkRevision: z.int().nonnegative().max(2_147_483_647),
  range: viewingHistoryRangeSchema,
  since: z.iso.datetime({ offset: true }).nullable(),
  state: viewingHistoryStateSchema,
  version: z.literal(1),
});
type ViewingHistoryCursorPayload = z.infer<typeof viewingHistoryCursorPayloadSchema>;

interface ContinueWatchingSourceRow {
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

interface LibraryRemovalRadarrRow {
  baseUrl: string;
  displayName: string;
  enabled: number;
  encryptedCredentials: string;
  id: string;
  insecureHttpApproved: number;
  tlsPolicy: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

interface UserMediaStateOperationRow {
  createdAt: number;
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  responseJson: string | null;
  state: string;
}

export interface ContinueWatchingContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface ContinueWatchingClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

export interface ContinueWatchingDependencies {
  clock?: () => Date;
  createAuditToken?: () => string;
  createRemovalPreviewToken?: () => string;
  createUserMediaStateOperationToken?: () => string;
  createClient?: (
    input: ContinueWatchingClientFactoryInput,
  ) => Pick<JellyfinUserMediaClient, "readContinueWatching" | "readImage"> &
    Partial<
      Pick<
        JellyfinUserMediaClient,
        | "readLibraryExtras"
        | "readLibrary"
        | "readLibrarySeasonEpisodes"
        | "readLibraryTitle"
        | "readViewingHistory"
        | "updatePlaybackState"
      >
    >;
  createRadarrAdapter?: (
    input: ApiKeyConnectorConfig,
  ) => Pick<RadarrAdapter, "resolveLibraryMovie">;
  mediaReferences?: MediaReferenceDependencies;
  readOnlineExtras?: (
    input: {
      kind: "movie" | "series";
      principal: SessionPrincipal;
      tmdbId: number;
    },
    signal?: AbortSignal,
  ) => Promise<{ displayName: string; items: readonly DiscoveryTrailer[] }>;
  resolveManagedMovie?: (
    input: {
      providerIds: { imdb: string | null; tmdb: number | null };
    },
    signal?: AbortSignal,
  ) => Promise<{
    hasFile: boolean;
    mediaId: number;
    monitored: boolean;
    sizeBytes: number | null;
  } | null>;
}

export class ContinueWatchingError extends Error {
  public readonly code = "continue_watching_unavailable";

  public constructor(options?: ErrorOptions) {
    super("Continue Watching is temporarily unavailable.", options);
    this.name = "ContinueWatchingError";
  }
}

export type MediaLibraryErrorReason = "cursor_invalid" | "not_found" | "unavailable";

export class MediaLibraryError extends Error {
  public readonly code = "media_library_unavailable";
  public readonly reason: MediaLibraryErrorReason;

  public constructor(reason: MediaLibraryErrorReason, options?: ErrorOptions) {
    super(
      reason === "cursor_invalid"
        ? "The library continuation cursor is invalid or no longer current."
        : reason === "not_found"
          ? "The library title is no longer available."
          : "The Jellyfin library is temporarily unavailable.",
      options,
    );
    this.name = "MediaLibraryError";
    this.reason = reason;
  }
}

export type LibraryRemovalPreviewErrorReason =
  "not_found" | "paired_user_cannot_delete" | "unavailable";

export class LibraryRemovalPreviewError extends Error {
  public readonly code = "library_removal_preview_unavailable";
  public readonly reason: LibraryRemovalPreviewErrorReason;

  public constructor(reason: LibraryRemovalPreviewErrorReason, options?: ErrorOptions) {
    super("The library removal preview is unavailable.", options);
    this.name = "LibraryRemovalPreviewError";
    this.reason = reason;
  }
}

export type MediaPlaybackStateErrorReason =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "not_found"
  | "operation_limit_reached"
  | "permission_denied"
  | "response_invalid"
  | "storage_failure"
  | "unavailable";

export class MediaPlaybackStateError extends Error {
  public readonly reason: MediaPlaybackStateErrorReason;

  public constructor(reason: MediaPlaybackStateErrorReason, options?: ErrorOptions) {
    super("The Jellyfin playback state could not be updated.", options);
    this.name = "MediaPlaybackStateError";
    this.reason = reason;
  }
}

export interface MediaPlaybackStateMutationResult {
  replayed: boolean;
  response: LibraryPlaybackStateMutationResponse;
}

export type ViewingHistoryErrorReason = "cursor_invalid" | "unavailable";

export class ViewingHistoryError extends Error {
  public readonly reason: ViewingHistoryErrorReason;

  public constructor(reason: ViewingHistoryErrorReason, options?: ErrorOptions) {
    super(
      reason === "cursor_invalid"
        ? "The viewing-history cursor is invalid or no longer current."
        : "Viewing history is temporarily unavailable.",
      options,
    );
    this.name = "ViewingHistoryError";
    this.reason = reason;
  }
}

export type MediaArtworkErrorReason = "not_found" | "unavailable";

export class MediaArtworkError extends Error {
  public readonly code = "media_artwork_unavailable";
  public readonly reason: MediaArtworkErrorReason;

  public constructor(reason: MediaArtworkErrorReason, options?: ErrorOptions) {
    super(
      reason === "not_found"
        ? "The requested media artwork is not available."
        : "Media artwork is temporarily unavailable.",
      options,
    );
    this.name = "MediaArtworkError";
    this.reason = reason;
  }
}

class ContinueWatchingConfigurationError extends Error {}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function accessToken(row: ContinueWatchingSourceRow, cipher: EnvelopeCipher) {
  try {
    return cipher.decrypt(row.encryptedAccessToken, accessTokenContext(row.linkId));
  } catch (error) {
    throw new ContinueWatchingConfigurationError("invalid", { cause: error });
  }
}

function safeDisplayName(value: string) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || "Jellyfin").slice(0, 160);
}

function connectorSecrets(row: ContinueWatchingSourceRow, cipher: EnvelopeCipher) {
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
    throw new ContinueWatchingConfigurationError("invalid", { cause: error });
  }
}

function defaultClient(input: ContinueWatchingClientFactoryInput) {
  const { accessToken, deviceId, ...target } = input;
  return new JellyfinUserMediaClient({ accessToken, deviceId, target });
}

type UserMediaOperation = "media.continue_watching" | "media.library" | "media.viewing_history";

function safeFailure(
  error: unknown,
  occurredAt: Date,
  operation: UserMediaOperation,
): PartialFailure {
  if (error instanceof SafeConnectorError && error.service === "jellyfin") {
    return error.toPartialFailure(occurredAt);
  }
  if (error instanceof ContinueWatchingConfigurationError) {
    return {
      code: "configuration_invalid",
      message: "The Jellyfin media connection could not be used.",
      occurredAt: occurredAt.toISOString(),
      operation,
      retryable: false,
      service: "jellyfin",
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "response_invalid",
      message: "Jellyfin returned media data that could not be safely interpreted.",
      occurredAt: occurredAt.toISOString(),
      operation,
      retryable: false,
      service: "jellyfin",
    };
  }
  return {
    code: "upstream_error",
    message: mediaOperationFailureMessage(error, operation),
    occurredAt: occurredAt.toISOString(),
    operation: error instanceof MediaReferenceError ? "media.reference" : operation,
    retryable: true,
    service: "jellyfin",
  };
}

function onlineExtrasFailure(error: unknown, occurredAt: Date): PartialFailure {
  const code =
    error instanceof SafeConnectorError
      ? error.code
      : error instanceof ZodError
        ? "response_invalid"
        : "upstream_error";
  return {
    code,
    message: "Online trailers are temporarily unavailable.",
    occurredAt: occurredAt.toISOString(),
    operation: "discovery.detail",
    retryable: code !== "configuration_invalid" && code !== "response_invalid",
    service: "seerr",
    ...(error instanceof SafeConnectorError && error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
}

function mediaOperationFailureMessage(error: unknown, operation: UserMediaOperation) {
  if (error instanceof MediaReferenceError) {
    if (operation === "media.library") return "Library references are temporarily unavailable.";
    if (operation === "media.viewing_history") {
      return "Viewing history references are temporarily unavailable.";
    }
    return "Continue Watching references are temporarily unavailable.";
  }
  if (operation === "media.library") return "The Jellyfin library is temporarily unavailable.";
  if (operation === "media.viewing_history") {
    return "Jellyfin viewing history is temporarily unavailable.";
  }
  return "Jellyfin Continue Watching is temporarily unavailable.";
}

function unavailableResponse(
  row: ContinueWatchingSourceRow,
  failure: PartialFailure,
  occurredAt: Date,
) {
  return continueWatchingResponseSchema.parse({
    failures: [failure],
    generatedAt: occurredAt.toISOString(),
    items: [],
    source: {
      connectorId: row.connectorId,
      displayName: safeDisplayName(row.connectorDisplayName),
      failure,
      status: "unavailable",
    },
    state: "unavailable",
    truncated: false,
  });
}

function unavailableLibraryResponse(
  row: ContinueWatchingSourceRow,
  failure: PartialFailure,
  occurredAt: Date,
) {
  return libraryBrowseResponseSchema.parse({
    generatedAt: occurredAt.toISOString(),
    items: [],
    nextCursor: null,
    source: {
      displayName: safeDisplayName(row.connectorDisplayName),
      failure,
      status: "unavailable",
    },
    state: "unavailable",
  });
}

function playbackStateFailure(error: unknown): MediaPlaybackStateErrorReason {
  if (error instanceof MediaPlaybackStateError) return error.reason;
  if (error instanceof SafeConnectorError) {
    if (error.status === 404) return "not_found";
    if (error.status === 403) return "permission_denied";
    if (error.code === "response_invalid" || error.code === "unsupported_version") {
      return "response_invalid";
    }
    return "unavailable";
  }
  if (error instanceof ZodError) return "response_invalid";
  return "unavailable";
}

function viewingHistorySince(range: ViewingHistoryQuery["range"], now: Date) {
  if (range === "all") return null;
  const since = new Date(now);
  if (range === "1_year") since.setUTCFullYear(since.getUTCFullYear() - 1);
  else {
    const days = range === "7_days" ? 7 : range === "30_days" ? 30 : 90;
    since.setUTCDate(since.getUTCDate() - days);
  }
  return since.toISOString();
}

export class ContinueWatchingService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAuditToken: () => string;
  readonly #createClient: NonNullable<ContinueWatchingDependencies["createClient"]>;
  readonly #createRemovalPreviewToken: () => string;
  readonly #createRadarrAdapter: NonNullable<ContinueWatchingDependencies["createRadarrAdapter"]>;
  readonly #createUserMediaStateOperationToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #references: MediaReferenceService;
  readonly #readOnlineExtras: NonNullable<ContinueWatchingDependencies["readOnlineExtras"]>;
  readonly #resolveManagedMovie: NonNullable<ContinueWatchingDependencies["resolveManagedMovie"]>;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: ContinueWatchingDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAuditToken = dependencies.createAuditToken ?? (() => randomToken(16));
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#createRemovalPreviewToken =
      dependencies.createRemovalPreviewToken ?? (() => randomToken(16));
    this.#createRadarrAdapter =
      dependencies.createRadarrAdapter ?? ((input) => new RadarrAdapter(input));
    this.#createUserMediaStateOperationToken =
      dependencies.createUserMediaStateOperationToken ?? (() => randomToken(16));
    this.#references = new MediaReferenceService(database, config, dependencies.mediaReferences);
    if (dependencies.readOnlineExtras) this.#readOnlineExtras = dependencies.readOnlineExtras;
    else {
      const discovery = new DiscoverySearchService(database, config);
      this.#readOnlineExtras = (input, signal) =>
        discovery.trailers(
          { kind: input.kind, tmdbId: input.tmdbId },
          { principal: input.principal },
          signal,
        );
    }
    this.#resolveManagedMovie =
      dependencies.resolveManagedMovie ??
      ((input, signal) => this.#resolveManagedMovieFromConnectors(input.providerIds, signal));
  }

  public async read(
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<ContinueWatchingResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    try {
      const client = this.#client(row);
      const result = await client.readContinueWatching(signal);
      return this.#response(row, result, occurredAt);
    } catch (error) {
      return unavailableResponse(
        row,
        safeFailure(error, occurredAt, "media.continue_watching"),
        occurredAt,
      );
    }
  }

  public async browse(
    rawQuery: LibraryBrowseQuery,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibraryBrowseResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const query = libraryBrowseQuerySchema.parse(rawQuery);
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    const startIndex = query.cursor ? this.#decodeLibraryCursor(query.cursor, query, row) : 0;
    try {
      const client = this.#client(row);
      if (!client.readLibrary) throw new ContinueWatchingConfigurationError();
      const result = await client.readLibrary(
        {
          kind: query.kind,
          limit: query.limit,
          ...(query.query === undefined ? {} : { query: query.query }),
          sort: query.sort,
          startIndex,
          userId: row.externalUserId,
        },
        signal,
      );
      return this.#libraryResponse(row, query, result, occurredAt);
    } catch (error) {
      return unavailableLibraryResponse(
        row,
        safeFailure(error, occurredAt, "media.library"),
        occurredAt,
      );
    }
  }

  public async readViewingHistory(
    rawQuery: ViewingHistoryQuery,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<ViewingHistoryResponse> {
    const principal = requirePermission(context.principal, "playback.history.self.manage");
    const query = viewingHistoryQuerySchema.parse(rawQuery);
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    const cursor = query.cursor ? this.#decodeViewingHistoryCursor(query.cursor, query, row) : null;
    const since = cursor?.since ?? viewingHistorySince(query.range, occurredAt);

    try {
      const client = this.#client(row);
      if (!client.readViewingHistory) throw new ContinueWatchingConfigurationError();
      const result = await client.readViewingHistory(
        {
          ...(cursor === null ? {} : { afterItemId: cursor.afterItemId }),
          kind: query.kind,
          limit: query.limit,
          ...(since === null ? {} : { since }),
          state: query.state,
          userId: row.externalUserId,
        },
        signal,
      );
      if (!result.boundaryFound) throw new ViewingHistoryError("cursor_invalid");
      return this.#viewingHistoryResponse(row, query, result, since, occurredAt);
    } catch (error) {
      if (error instanceof ViewingHistoryError) throw error;
      return viewingHistoryResponseSchema.parse({
        generatedAt: occurredAt.toISOString(),
        items: [],
        nextCursor: null,
        source: {
          displayName: safeDisplayName(row.connectorDisplayName),
          failure: safeFailure(error, occurredAt, "media.viewing_history"),
          status: "unavailable",
        },
        state: "unavailable",
      });
    }
  }

  public async readLibraryTitle(
    referenceId: string,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibraryTitleDetailResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new MediaLibraryError("not_found", { cause: error });
    }
    if (reference.kind !== "movie" && reference.kind !== "series") {
      throw new MediaLibraryError("not_found");
    }
    try {
      const client = this.#client(row);
      if (!client.readLibraryTitle) throw new ContinueWatchingConfigurationError();
      const result = await client.readLibraryTitle(
        { itemId: reference.itemId, userId: row.externalUserId },
        signal,
      );
      if (result.item.externalId !== reference.itemId || result.item.kind !== reference.kind) {
        throw new MediaReferenceError();
      }
      const [refreshedReferenceId] = this.#references.createOrRefresh(this.#referenceContext(row), [
        this.#titleReferenceInput(result.item),
      ]);
      if (refreshedReferenceId !== referenceId) throw new MediaReferenceError();
      return libraryTitleDetailResponseSchema.parse({
        generatedAt: occurredAt.toISOString(),
        media: this.#libraryMedia(result.item, referenceId),
        movie:
          result.movie === null
            ? null
            : {
                ...result.movie,
                cast: result.movie.cast.map(({ image, imagePath: _imagePath, ...credit }) => ({
                  ...credit,
                  imagePath:
                    image === null ? null : this.#personImagePath(referenceId, image.itemId),
                })),
                crew: result.movie.crew.map(({ image, imagePath: _imagePath, ...credit }) => ({
                  ...credit,
                  imagePath:
                    image === null ? null : this.#personImagePath(referenceId, image.itemId),
                })),
              },
        playback:
          result.item.kind === "movie" && result.item.runtimeSeconds !== null
            ? {
                durationSeconds: result.item.runtimeSeconds,
                played: result.item.played,
                positionSeconds: result.item.positionSeconds,
              }
            : null,
        seasons: result.seasons,
        seasonsTruncated: result.seasonsTruncated,
      });
    } catch (error) {
      if (error instanceof MediaLibraryError) throw error;
      throw new MediaLibraryError("unavailable", { cause: error });
    }
  }

  public async readLibraryExtras(
    referenceId: string,
    rawQuery: LibraryExtrasQuery,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibraryExtrasResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const query = libraryExtrasQuerySchema.parse(rawQuery);
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new MediaLibraryError("not_found", { cause: error });
    }
    if (reference.kind !== "movie" && reference.kind !== "series") {
      throw new MediaLibraryError("not_found");
    }
    const startIndex = query.cursor
      ? this.#decodeLibraryExtrasCursor(query.cursor, query, row, referenceId)
      : 0;
    try {
      const client = this.#client(row);
      if (!client.readLibraryExtras) throw new ContinueWatchingConfigurationError();
      const result = await client.readLibraryExtras(
        {
          itemId: reference.itemId,
          limit: query.limit,
          startIndex,
          userId: row.externalUserId,
        },
        signal,
      );
      let onlineItems: readonly DiscoveryTrailer[] = [];
      let onlineSource: {
        displayName: string;
        failure: PartialFailure | null;
        status: "healthy" | "unavailable" | "unconfigured";
      };
      let onlineState: "empty" | "ready" | "unavailable" | "unconfigured";
      if (result.catalogTmdbId === null) {
        onlineSource = { displayName: "Online trailers", failure: null, status: "unconfigured" };
        onlineState = "unconfigured";
      } else {
        try {
          const online = await this.#readOnlineExtras(
            { kind: reference.kind, principal, tmdbId: result.catalogTmdbId },
            signal,
          );
          onlineItems = online.items;
          onlineSource = {
            displayName: safeDisplayName(online.displayName),
            failure: null,
            status: "healthy",
          };
          onlineState = onlineItems.length > 0 ? "ready" : "empty";
        } catch (error) {
          if (error instanceof DiscoverySearchError && error.reason === "connector_unconfigured") {
            onlineSource = { displayName: "Seerr", failure: null, status: "unconfigured" };
            onlineState = "unconfigured";
          } else {
            onlineSource = {
              displayName: "Seerr",
              failure: onlineExtrasFailure(error, occurredAt),
              status: "unavailable",
            };
            onlineState = "unavailable";
          }
        }
      }
      const referenceIds = this.#references.createOrRefresh(
        this.#referenceContext(row),
        result.items.map((item) => ({
          artwork: {
            backdropItemId: item.artwork.backdrop?.itemId ?? null,
            posterItemId: item.artwork.poster?.itemId ?? null,
          },
          episodeNumber: null,
          itemId: item.externalId,
          kind: "extra" as const,
          seasonNumber: null,
          title: item.title,
          year: item.year,
        })),
      );
      return libraryExtrasResponseSchema.parse({
        generatedAt: occurredAt.toISOString(),
        items: result.items.map((item, index) => ({
          extraType: item.extraType,
          media: this.#libraryExtraMedia(item, referenceIds[index]!),
          playback: {
            durationSeconds: item.runtimeSeconds,
            played: item.played,
            positionSeconds: item.positionSeconds,
          },
          source: "local",
        })),
        nextCursor:
          result.nextStartIndex === null
            ? null
            : this.#encodeLibraryExtrasCursor({
                limit: query.limit,
                linkId: row.linkId,
                linkRevision: row.linkRevision,
                parentReferenceId: referenceId,
                startIndex: result.nextStartIndex,
                version: 1,
              }),
        onlineItems,
        onlineSource,
        onlineState,
        parentReferenceId: referenceId,
        source: {
          displayName: safeDisplayName(row.connectorDisplayName),
          failure: null,
          status: "healthy",
        },
        state: result.items.length === 0 ? "empty" : "complete",
      });
    } catch (error) {
      if (error instanceof MediaLibraryError) throw error;
      return libraryExtrasResponseSchema.parse({
        generatedAt: occurredAt.toISOString(),
        items: [],
        nextCursor: null,
        onlineItems: [],
        onlineSource: { displayName: "Seerr", failure: null, status: "unconfigured" },
        onlineState: "unconfigured",
        parentReferenceId: referenceId,
        source: {
          displayName: safeDisplayName(row.connectorDisplayName),
          failure: safeFailure(error, occurredAt, "media.library"),
          status: "unavailable",
        },
        state: "unavailable",
      });
    }
  }

  public async readLibrarySeasonEpisodes(
    referenceId: string,
    seasonNumber: number,
    rawQuery: LibrarySeasonEpisodesQuery,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibrarySeasonEpisodesResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const query = librarySeasonEpisodesQuerySchema.parse(rawQuery);
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new MediaLibraryError("not_found", { cause: error });
    }
    if (reference.kind !== "series" || !Number.isSafeInteger(seasonNumber) || seasonNumber < 0) {
      throw new MediaLibraryError("not_found");
    }
    const startIndex = query.cursor
      ? this.#decodeLibrarySeasonCursor(query.cursor, query, row, referenceId, seasonNumber)
      : 0;
    try {
      const client = this.#client(row);
      if (!client.readLibrarySeasonEpisodes) throw new ContinueWatchingConfigurationError();
      const result = await client.readLibrarySeasonEpisodes(
        {
          limit: query.limit,
          seasonNumber,
          seriesId: reference.itemId,
          startIndex,
          userId: row.externalUserId,
        },
        signal,
      );
      const referenceIds = this.#references.createOrRefresh(
        this.#referenceContext(row),
        result.items.map((item) => ({
          artwork: {
            backdropItemId: item.artwork.backdrop?.itemId ?? null,
            posterItemId: item.artwork.poster?.itemId ?? null,
          },
          episodeNumber: item.episodeNumber,
          itemId: item.externalId,
          kind: item.kind,
          seasonNumber: item.seasonNumber,
          title: item.title,
          year: item.year,
        })),
      );
      const items = result.items.map((item, index) => ({
        airDate: item.airDate,
        communityRating: item.communityRating,
        credits: item.credits,
        creditsTruncated: item.creditsTruncated,
        criticRating: item.criticRating,
        genres: item.genres,
        media: this.#episodeMedia(item, referenceIds[index]!),
        playback: {
          durationSeconds: item.runtimeSeconds,
          played: item.played,
          positionSeconds: item.positionSeconds,
        },
        studios: item.studios,
      }));
      return librarySeasonEpisodesResponseSchema.parse({
        generatedAt: occurredAt.toISOString(),
        items,
        nextCursor:
          result.nextStartIndex === null
            ? null
            : this.#encodeLibrarySeasonCursor({
                limit: query.limit,
                linkId: row.linkId,
                linkRevision: row.linkRevision,
                seasonNumber,
                startIndex: result.nextStartIndex,
                titleReferenceId: referenceId,
                version: 1,
              }),
        seasonNumber,
        titleReferenceId: referenceId,
      });
    } catch (error) {
      if (error instanceof MediaLibraryError) throw error;
      throw new MediaLibraryError("unavailable", { cause: error });
    }
  }

  public async previewLibraryRemoval(
    referenceId: string,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibraryRemovalPreview> {
    const principal = requirePermission(context.principal, "library.delete");
    const row = this.#source(principal);
    const generatedAt = this.#clock();
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new LibraryRemovalPreviewError("not_found", { cause: error });
    }
    if (reference.kind !== "movie" || reference.title === null) {
      throw new LibraryRemovalPreviewError("not_found");
    }

    try {
      const client = this.#client(row);
      if (!client.readLibraryTitle) throw new ContinueWatchingConfigurationError();
      const result = await client.readLibraryTitle(
        { itemId: reference.itemId, userId: row.externalUserId },
        signal,
      );
      if (
        result.item.externalId !== reference.itemId ||
        result.item.kind !== "movie" ||
        result.item.title !== reference.title ||
        result.item.year !== reference.year ||
        result.removal === undefined ||
        result.removal === null
      ) {
        throw new MediaReferenceError();
      }
      if (!result.removal.canDelete) {
        throw new LibraryRemovalPreviewError("paired_user_cannot_delete");
      }
      const ownership = await this.#resolveManagedMovie(
        { providerIds: result.removal.providerIds },
        signal,
      );
      if (ownership !== null && !ownership.hasFile) {
        throw new LibraryRemovalPreviewError("unavailable");
      }
      const commonEffects = {
        organizedFiles: "deleted" as const,
        requestHistory: "retained" as const,
        seedingCopies: "unchanged" as const,
        storageReclamation: "may_be_delayed" as const,
      };
      const managed = ownership !== null;
      return libraryRemovalPreviewSchema.parse({
        confirmation: {
          expectedTitle: result.item.title,
          kind: "exact_title",
          recentAuthenticationRequired: true,
        },
        expiresAt: new Date(generatedAt.valueOf() + LIBRARY_REMOVAL_PREVIEW_TTL_MS).toISOString(),
        generatedAt: generatedAt.toISOString(),
        options: managed
          ? [
              {
                effects: {
                  ...commonEffects,
                  managerRecord: "retained",
                  monitoring: "monitored",
                  reacquisitionRisk: "possible",
                },
                mode: "delete_files_keep_monitored",
              },
              {
                effects: {
                  ...commonEffects,
                  managerRecord: "retained",
                  monitoring: "unmonitored",
                  reacquisitionRisk: "prevented",
                },
                mode: "delete_files_and_unmonitor",
              },
              {
                effects: {
                  ...commonEffects,
                  managerRecord: "removed",
                  monitoring: "removed",
                  reacquisitionRisk: "prevented",
                },
                mode: "remove_from_radarr_and_delete_files",
              },
            ]
          : [
              {
                effects: {
                  ...commonEffects,
                  managerRecord: "not_applicable",
                  monitoring: "not_applicable",
                  reacquisitionRisk: "not_managed",
                },
                mode: "delete_unmanaged_files",
              },
            ],
        previewId: `library_removal_preview_${this.#createRemovalPreviewToken()}`,
        referenceId,
        sizeBytes: ownership?.sizeBytes ?? result.removal.sizeBytes,
        source: managed
          ? { kind: "managed", monitored: ownership.monitored, service: "radarr" }
          : { kind: "unmanaged", monitored: null, service: "jellyfin" },
        title: result.item.title,
        year: result.item.year,
      });
    } catch (error) {
      if (error instanceof LibraryRemovalPreviewError) throw error;
      throw new LibraryRemovalPreviewError("unavailable", { cause: error });
    }
  }

  public async updatePlaybackState(
    referenceId: string,
    rawRequest: LibraryPlaybackStateMutationRequest,
    rawIdempotencyKey: string,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<MediaPlaybackStateMutationResult> {
    const principal = requirePermission(context.principal, "playback.history.self.manage");
    if (!principal.userId) throw new MediaPlaybackStateError("permission_denied");
    const request = libraryPlaybackStateMutationRequestSchema.parse(rawRequest);
    const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(rawIdempotencyKey);
    const row = this.#source(principal);
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new MediaPlaybackStateError("not_found", { cause: error });
    }
    if (reference.kind !== "movie" && reference.kind !== "episode") {
      throw new MediaPlaybackStateError("not_found");
    }

    const keyHash = hashToken(`${principal.userId}\0media_playback_state\0${idempotencyKey}`);
    const fingerprintHash = hashToken(
      JSON.stringify({
        action: request.action,
        linkId: row.linkId,
        linkRevision: row.linkRevision,
        referenceId,
        version: 1,
      }),
    );
    const reservation = this.#reserveUserMediaStateOperation(
      principal.userId,
      referenceId,
      keyHash,
      fingerprintHash,
    );
    if (reservation.kind === "replay") {
      return { replayed: true, response: reservation.response };
    }
    if (reservation.kind === "conflict") {
      throw new MediaPlaybackStateError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new MediaPlaybackStateError("idempotency_in_progress");
    }

    try {
      const client = this.#client(row);
      if (!client.updatePlaybackState) throw new ContinueWatchingConfigurationError();
      const playback = await client.updatePlaybackState(
        {
          action: request.action,
          itemId: reference.itemId,
          userId: row.externalUserId,
        },
        signal,
      );
      const response = libraryPlaybackStateMutationResponseSchema.parse({
        action: request.action,
        playback,
        referenceId,
        updatedAt: this.#clock().toISOString(),
      });
      this.#completeUserMediaStateOperation(
        reservation.operationId,
        response,
        context,
        request.action,
      );
      return { replayed: false, response };
    } catch (error) {
      const reason = playbackStateFailure(error);
      this.#failUserMediaStateOperation(reservation.operationId, reason, context, request.action);
      throw new MediaPlaybackStateError(reason, { cause: error });
    }
  }

  public async readArtwork(
    context: ContinueWatchingContext,
    referenceId: string,
    kind: "backdrop" | "poster",
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    let reference;
    try {
      reference = this.#references.resolve(
        { linkId: row.linkId, linkRevision: row.linkRevision, userId: row.linkUserId },
        referenceId,
      );
    } catch (error) {
      throw new MediaArtworkError("not_found", { cause: error });
    }
    const itemId =
      kind === "poster" ? reference.artwork.posterItemId : reference.artwork.backdropItemId;
    if (itemId === null) throw new MediaArtworkError("not_found");

    try {
      const image = await this.#client(row, 8 * 1_024 * 1_024).readImage({
        itemId,
        maxWidth: kind === "poster" ? 720 : 1_920,
        ...(signal === undefined ? {} : { signal }),
        type: kind === "poster" ? "Primary" : "Backdrop",
      });
      const digest = createHash("sha256").update(image.body).digest("base64url").slice(0, 22);
      return Object.freeze({
        body: image.body,
        contentType: image.contentType,
        etag: `"artwork_${digest}"`,
      });
    } catch (error) {
      throw new MediaArtworkError("unavailable", { cause: error });
    }
  }

  public async readPersonArtwork(
    context: ContinueWatchingContext,
    referenceId: string,
    token: string,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    let itemId: string;
    try {
      const reference = this.#references.resolve(this.#referenceContext(row), referenceId);
      if (reference.kind !== "movie") throw new MediaReferenceError();
      itemId = libraryPersonImagePayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(token, this.#personImageContext(referenceId))),
      ).itemId;
    } catch (error) {
      throw new MediaArtworkError("not_found", { cause: error });
    }

    try {
      const image = await this.#client(row, 4 * 1_024 * 1_024).readImage({
        itemId,
        maxWidth: 480,
        ...(signal === undefined ? {} : { signal }),
        type: "Primary",
      });
      const digest = createHash("sha256").update(image.body).digest("base64url").slice(0, 22);
      return Object.freeze({
        body: image.body,
        contentType: image.contentType,
        etag: `"person_${digest}"`,
      });
    } catch (error) {
      throw new MediaArtworkError("unavailable", { cause: error });
    }
  }

  #client(row: ContinueWatchingSourceRow, maxResponseBytes?: number) {
    const secrets = connectorSecrets(row, this.#cipher);
    const token = accessToken(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (!tlsPolicy) throw new ContinueWatchingConfigurationError();
    try {
      return this.#createClient({
        accessToken: token,
        baseUrl: row.baseUrl,
        connectorId: row.connectorId,
        deviceId: row.deviceId,
        displayName: safeDisplayName(row.connectorDisplayName),
        insecureHttpApproved: row.insecureHttpApproved === 1,
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
        tlsPolicy,
        ...secrets,
      });
    } catch (error) {
      throw new ContinueWatchingConfigurationError("invalid", { cause: error });
    }
  }

  #response(
    row: ContinueWatchingSourceRow,
    result: JellyfinContinueWatchingResult,
    occurredAt: Date,
  ) {
    const referenceIds = this.#references.createOrRefresh(
      { linkId: row.linkId, linkRevision: row.linkRevision, userId: row.linkUserId },
      result.items.map((item) => ({
        artwork: {
          backdropItemId: item.artwork.backdrop?.itemId ?? null,
          posterItemId: item.artwork.poster?.itemId ?? null,
        },
        episodeNumber: item.episodeNumber,
        itemId: item.externalId,
        kind: item.kind,
        seasonNumber: item.seasonNumber,
        title: item.title,
        year: item.year,
      })),
    );
    const items = result.items.map((item, index) => {
      const id = referenceIds[index]!;
      return {
        durationSeconds: item.runtimeSeconds,
        lastPlayedAt: item.lastPlayedAt,
        media: {
          artwork: {
            accentColor: item.artwork.accentColor,
            backdropPath: item.artwork.backdrop === null ? null : `/v1/media/${id}/images/backdrop`,
            blurHash: item.artwork.blurHash,
            posterPath: item.artwork.poster === null ? null : `/v1/media/${id}/images/poster`,
          },
          availability: "available" as const,
          contentRating: item.contentRating,
          id,
          kind: item.kind,
          overview: item.overview,
          runtimeMinutes: Math.max(1, Math.ceil(item.runtimeSeconds / 60)),
          subtitle: item.subtitle,
          title: item.title,
          year: item.year,
        },
        positionSeconds: item.positionSeconds,
        progressPercent: Math.round((item.positionSeconds / item.runtimeSeconds) * 1_000) / 10,
      };
    });
    return continueWatchingResponseSchema.parse({
      failures: [],
      generatedAt: occurredAt.toISOString(),
      items,
      source: {
        connectorId: row.connectorId,
        displayName: safeDisplayName(row.connectorDisplayName),
        failure: null,
        status: "healthy",
      },
      state: items.length === 0 ? "empty" : "complete",
      truncated: result.truncated,
    });
  }

  #libraryResponse(
    row: ContinueWatchingSourceRow,
    query: LibraryBrowseQuery,
    result: Awaited<ReturnType<JellyfinUserMediaClient["readLibrary"]>>,
    occurredAt: Date,
  ) {
    const referenceIds = this.#references.createOrRefresh(
      { linkId: row.linkId, linkRevision: row.linkRevision, userId: row.linkUserId },
      result.items.map((item) => ({
        artwork: {
          backdropItemId: item.artwork.backdrop?.itemId ?? null,
          posterItemId: item.artwork.poster?.itemId ?? null,
        },
        episodeNumber: null,
        itemId: item.externalId,
        kind: item.kind,
        seasonNumber: null,
        title: item.title,
        year: item.year,
      })),
    );
    const items = result.items.map((item, index) => {
      const id = referenceIds[index]!;
      return {
        media: this.#libraryMedia(item, id),
        playback:
          item.kind === "movie" && item.runtimeSeconds !== null
            ? {
                durationSeconds: item.runtimeSeconds,
                played: item.played,
                positionSeconds: item.positionSeconds,
              }
            : null,
      };
    });
    return libraryBrowseResponseSchema.parse({
      generatedAt: occurredAt.toISOString(),
      items,
      nextCursor:
        result.nextStartIndex === null
          ? null
          : this.#encodeLibraryCursor({
              kind: query.kind,
              limit: query.limit,
              linkId: row.linkId,
              linkRevision: row.linkRevision,
              query: query.query ?? null,
              sort: query.sort,
              startIndex: result.nextStartIndex,
              version: 1,
            }),
      source: {
        displayName: safeDisplayName(row.connectorDisplayName),
        failure: null,
        status: "healthy",
      },
      state: items.length === 0 ? "empty" : "complete",
    });
  }

  #viewingHistoryResponse(
    row: ContinueWatchingSourceRow,
    query: ViewingHistoryQuery,
    result: Awaited<ReturnType<JellyfinUserMediaClient["readViewingHistory"]>>,
    since: string | null,
    occurredAt: Date,
  ) {
    const referenceIds = this.#references.createOrRefresh(
      this.#referenceContext(row),
      result.items.map((item) => ({
        artwork: {
          backdropItemId: item.artwork.backdrop?.itemId ?? null,
          posterItemId: item.artwork.poster?.itemId ?? null,
        },
        episodeNumber: item.episodeNumber,
        itemId: item.externalId,
        kind: item.kind,
        seasonNumber: item.seasonNumber,
        title: item.title,
        year: item.year,
      })),
    );
    const items = result.items.map((item, index) => ({
      activity: item.played ? ("completed" as const) : ("in_progress" as const),
      lastPlayedAt: item.lastPlayedAt,
      media: this.#viewingHistoryMedia(item, referenceIds[index]!),
      playback: {
        durationSeconds: item.runtimeSeconds,
        played: item.played,
        positionSeconds: item.positionSeconds,
      },
    }));
    return viewingHistoryResponseSchema.parse({
      generatedAt: occurredAt.toISOString(),
      items,
      nextCursor:
        result.nextAfterItemId === null
          ? null
          : this.#encodeViewingHistoryCursor({
              afterItemId: result.nextAfterItemId,
              kind: query.kind,
              limit: query.limit,
              linkId: row.linkId,
              linkRevision: row.linkRevision,
              range: query.range,
              since,
              state: query.state,
              version: 1,
            }),
      source: {
        displayName: safeDisplayName(row.connectorDisplayName),
        failure: null,
        status: "healthy",
      },
      state: items.length === 0 ? "empty" : "complete",
    });
  }

  #libraryMedia(
    item: Awaited<ReturnType<JellyfinUserMediaClient["readLibrary"]>>["items"][number],
    id: string,
  ) {
    return {
      artwork: {
        accentColor: item.artwork.accentColor,
        backdropPath: item.artwork.backdrop === null ? null : `/v1/media/${id}/images/backdrop`,
        blurHash: item.artwork.blurHash,
        posterPath: item.artwork.poster === null ? null : `/v1/media/${id}/images/poster`,
      },
      availability: "available" as const,
      contentRating: item.contentRating,
      id,
      kind: item.kind,
      overview: item.overview,
      runtimeMinutes:
        item.runtimeSeconds === null ? null : Math.max(1, Math.ceil(item.runtimeSeconds / 60)),
      subtitle: null,
      title: item.title,
      year: item.year,
    };
  }

  #episodeMedia(
    item: Awaited<
      ReturnType<JellyfinUserMediaClient["readLibrarySeasonEpisodes"]>
    >["items"][number],
    id: string,
  ) {
    return {
      artwork: {
        accentColor: item.artwork.accentColor,
        backdropPath: item.artwork.backdrop === null ? null : `/v1/media/${id}/images/backdrop`,
        blurHash: item.artwork.blurHash,
        posterPath: item.artwork.poster === null ? null : `/v1/media/${id}/images/poster`,
      },
      availability: "available" as const,
      contentRating: item.contentRating,
      id,
      kind: "episode" as const,
      overview: item.overview,
      runtimeMinutes: Math.max(1, Math.ceil(item.runtimeSeconds / 60)),
      subtitle: item.subtitle,
      title: item.title,
      year: item.year,
    };
  }

  #viewingHistoryMedia(
    item: Awaited<ReturnType<JellyfinUserMediaClient["readViewingHistory"]>>["items"][number],
    id: string,
  ) {
    return {
      artwork: {
        accentColor: item.artwork.accentColor,
        backdropPath: item.artwork.backdrop === null ? null : `/v1/media/${id}/images/backdrop`,
        blurHash: item.artwork.blurHash,
        posterPath: item.artwork.poster === null ? null : `/v1/media/${id}/images/poster`,
      },
      availability: "available" as const,
      contentRating: item.contentRating,
      id,
      kind: item.kind,
      overview: item.overview,
      runtimeMinutes: Math.max(1, Math.ceil(item.runtimeSeconds / 60)),
      subtitle: item.subtitle,
      title: item.title,
      year: item.year,
    };
  }

  #libraryExtraMedia(
    item: Awaited<ReturnType<JellyfinUserMediaClient["readLibraryExtras"]>>["items"][number],
    id: string,
  ) {
    return {
      artwork: {
        accentColor: item.artwork.accentColor,
        backdropPath: item.artwork.backdrop === null ? null : `/v1/media/${id}/images/backdrop`,
        blurHash: item.artwork.blurHash,
        posterPath: item.artwork.poster === null ? null : `/v1/media/${id}/images/poster`,
      },
      availability: "available" as const,
      contentRating: item.contentRating,
      id,
      kind: "other" as const,
      overview: item.overview,
      runtimeMinutes: Math.max(1, Math.ceil(item.runtimeSeconds / 60)),
      subtitle: "Local extra",
      title: item.title,
      year: item.year,
    };
  }

  #titleReferenceInput(
    item: Awaited<ReturnType<JellyfinUserMediaClient["readLibraryTitle"]>>["item"],
  ) {
    return {
      artwork: {
        backdropItemId: item.artwork.backdrop?.itemId ?? null,
        posterItemId: item.artwork.poster?.itemId ?? null,
      },
      episodeNumber: null,
      itemId: item.externalId,
      kind: item.kind,
      seasonNumber: null,
      title: item.title,
      year: item.year,
    };
  }

  #personImageContext(referenceId: string) {
    return `media_person_image:${referenceId}`;
  }

  #personImagePath(referenceId: string, itemId: string) {
    const token = this.#cipher.encrypt(
      JSON.stringify(libraryPersonImagePayloadSchema.parse({ itemId, version: 1 })),
      this.#personImageContext(referenceId),
    );
    return `/v1/media/${referenceId}/images/people/${token}`;
  }

  #referenceContext(row: ContinueWatchingSourceRow) {
    return { linkId: row.linkId, linkRevision: row.linkRevision, userId: row.linkUserId };
  }

  async #resolveManagedMovieFromConnectors(
    providerIds: { imdb: string | null; tmdb: number | null },
    signal?: AbortSignal,
  ): Promise<RadarrLibraryMovieOwnership | null> {
    const rows = this.#database.sqlite
      .prepare(
        `select id, display_name as displayName, base_url as baseUrl, enabled,
                encrypted_credentials as encryptedCredentials,
                tls_policy as tlsPolicy, insecure_http_approved as insecureHttpApproved
         from connector_configs
         where type = 'radarr'
         order by id asc
         limit 11`,
      )
      .all() as LibraryRemovalRadarrRow[];
    if (rows.length === 0) return null;
    if (
      rows.length > 10 ||
      rows.some(({ enabled }) => enabled !== 1) ||
      (providerIds.imdb === null && providerIds.tmdb === null)
    ) {
      throw new ContinueWatchingConfigurationError("invalid");
    }

    const matches = await Promise.all(
      rows.map(async (row) => {
        const { apiKey, tlsCaCertificatePem } = this.#radarrSecrets(row);
        if (
          !IDENTIFIER_PATTERN.test(row.id) ||
          !row.displayName.trim() ||
          row.displayName.length > 160 ||
          ![0, 1].includes(row.insecureHttpApproved) ||
          (row.tlsPolicy !== "strict" && row.tlsPolicy !== "allow_self_signed")
        ) {
          throw new ContinueWatchingConfigurationError("invalid");
        }
        const adapter = this.#createRadarrAdapter({
          apiKey,
          baseUrl: row.baseUrl,
          clock: { monotonicNow: () => performance.now(), now: this.#clock },
          connectorId: row.id,
          displayName: row.displayName,
          insecureHttpApproved: row.insecureHttpApproved === 1,
          tlsPolicy: row.tlsPolicy,
          ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
        });
        return adapter.resolveLibraryMovie(providerIds, signal);
      }),
    );
    const owned = matches.filter((match): match is RadarrLibraryMovieOwnership => match !== null);
    if (owned.length > 1) throw new ContinueWatchingConfigurationError("invalid");
    return owned[0] ?? null;
  }

  #radarrSecrets(row: LibraryRemovalRadarrRow) {
    try {
      const decoded = JSON.parse(
        this.#cipher.decrypt(row.encryptedCredentials, `connector_credentials:radarr:${row.id}`),
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
      if (credentials.kind !== "api_key") throw new Error("invalid");
      const tlsCaCertificatePem = stored.tlsCaCertificatePem;
      if (tlsCaCertificatePem !== undefined) {
        if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
          throw new Error("invalid");
        }
        const certificate = new X509Certificate(tlsCaCertificatePem);
        if (!certificate.ca) throw new Error("invalid");
      }
      return {
        apiKey: credentials.apiKey,
        ...(typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {}),
      };
    } catch (error) {
      throw new ContinueWatchingConfigurationError("invalid", { cause: error });
    }
  }

  #encodeLibraryCursor(value: LibraryCursorPayload) {
    return this.#cipher.encrypt(JSON.stringify(value), "media_library_cursor");
  }

  #encodeLibraryExtrasCursor(value: LibraryExtrasCursorPayload) {
    return this.#cipher.encrypt(JSON.stringify(value), "media_library_extras_cursor");
  }

  #encodeViewingHistoryCursor(value: ViewingHistoryCursorPayload) {
    return this.#cipher.encrypt(JSON.stringify(value), "media_viewing_history_cursor");
  }

  #encodeLibrarySeasonCursor(value: LibrarySeasonCursorPayload) {
    return this.#cipher.encrypt(JSON.stringify(value), "media_library_season_cursor");
  }

  #decodeLibrarySeasonCursor(
    value: string,
    query: LibrarySeasonEpisodesQuery,
    row: ContinueWatchingSourceRow,
    titleReferenceId: string,
    seasonNumber: number,
  ) {
    try {
      const decoded = librarySeasonCursorPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(value, "media_library_season_cursor")),
      );
      if (
        decoded.linkId !== row.linkId ||
        decoded.linkRevision !== row.linkRevision ||
        decoded.limit !== query.limit ||
        decoded.titleReferenceId !== titleReferenceId ||
        decoded.seasonNumber !== seasonNumber
      ) {
        throw new Error("invalid");
      }
      return decoded.startIndex;
    } catch (error) {
      throw new MediaLibraryError("cursor_invalid", { cause: error });
    }
  }

  #decodeLibraryExtrasCursor(
    value: string,
    query: LibraryExtrasQuery,
    row: ContinueWatchingSourceRow,
    parentReferenceId: string,
  ) {
    try {
      const decoded = libraryExtrasCursorPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(value, "media_library_extras_cursor")),
      );
      if (
        decoded.linkId !== row.linkId ||
        decoded.linkRevision !== row.linkRevision ||
        decoded.limit !== query.limit ||
        decoded.parentReferenceId !== parentReferenceId
      ) {
        throw new Error("invalid");
      }
      return decoded.startIndex;
    } catch (error) {
      throw new MediaLibraryError("cursor_invalid", { cause: error });
    }
  }

  #decodeLibraryCursor(value: string, query: LibraryBrowseQuery, row: ContinueWatchingSourceRow) {
    try {
      const decoded = libraryCursorPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(value, "media_library_cursor")),
      );
      if (
        decoded.linkId !== row.linkId ||
        decoded.linkRevision !== row.linkRevision ||
        decoded.kind !== query.kind ||
        decoded.limit !== query.limit ||
        decoded.query !== (query.query ?? null) ||
        decoded.sort !== query.sort
      ) {
        throw new Error("invalid");
      }
      return decoded.startIndex;
    } catch (error) {
      throw new MediaLibraryError("cursor_invalid", { cause: error });
    }
  }

  #decodeViewingHistoryCursor(
    value: string,
    query: ViewingHistoryQuery,
    row: ContinueWatchingSourceRow,
  ) {
    try {
      const decoded = viewingHistoryCursorPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(value, "media_viewing_history_cursor")),
      );
      if (
        decoded.linkId !== row.linkId ||
        decoded.linkRevision !== row.linkRevision ||
        decoded.kind !== query.kind ||
        decoded.limit !== query.limit ||
        decoded.range !== query.range ||
        decoded.state !== query.state
      ) {
        throw new Error("invalid");
      }
      return decoded;
    } catch (error) {
      throw new ViewingHistoryError("cursor_invalid", { cause: error });
    }
  }

  #reserveUserMediaStateOperation(
    userId: string,
    referenceId: string,
    keyHash: string,
    fingerprintHash: string,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const now = this.#clock().valueOf();
          this.#pruneUserMediaStateOperations(userId, now);
          const existing = this.#database.sqlite
            .prepare(
              `select id, fingerprint_hash as fingerprintHash, state,
                      response_json as responseJson, failure_code as failureCode,
                      created_at as createdAt
               from user_media_state_operations
               where user_id = ? and idempotency_key_hash = ?
               limit 1`,
            )
            .get(userId, keyHash) as UserMediaStateOperationRow | undefined;
          if (existing) {
            if (existing.fingerprintHash !== fingerprintHash) {
              return { kind: "conflict" as const };
            }
            if (existing.state === "succeeded" && existing.responseJson) {
              return {
                kind: "replay" as const,
                response: libraryPlaybackStateMutationResponseSchema.parse(
                  JSON.parse(existing.responseJson),
                ),
              };
            }
            if (
              existing.state === "pending" &&
              existing.createdAt > now - STALE_USER_MEDIA_STATE_OPERATION_MS
            ) {
              return { kind: "pending" as const };
            }
            if (existing.state !== "pending" && existing.state !== "failed") {
              throw new MediaPlaybackStateError("storage_failure");
            }
            const updated = this.#database.sqlite
              .prepare(
                `update user_media_state_operations
                 set state = 'pending', response_json = null, failure_code = null,
                     completed_at = null, created_at = ?, updated_at = ?
                 where id = ? and fingerprint_hash = ?`,
              )
              .run(now, now, existing.id, fingerprintHash);
            if (updated.changes !== 1) throw new MediaPlaybackStateError("storage_failure");
            return { kind: "reserved" as const, operationId: existing.id };
          }

          const count = this.#database.sqlite
            .prepare("select count(*) as count from user_media_state_operations where user_id = ?")
            .get(userId) as { count: number };
          if (count.count >= MAX_USER_MEDIA_STATE_OPERATIONS_PER_USER) {
            throw new MediaPlaybackStateError("operation_limit_reached");
          }
          const operationId = this.#userMediaStateOperationId();
          this.#database.sqlite
            .prepare(
              `insert into user_media_state_operations (
                 id, user_id, reference_id, idempotency_key_hash,
                 fingerprint_hash, state, created_at, updated_at
               ) values (?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(operationId, userId, referenceId, keyHash, fingerprintHash, now, now);
          return { kind: "reserved" as const, operationId };
        })
        .immediate();
    } catch (error) {
      if (error instanceof MediaPlaybackStateError) throw error;
      throw new MediaPlaybackStateError("storage_failure", { cause: error });
    }
  }

  #completeUserMediaStateOperation(
    operationId: string,
    response: LibraryPlaybackStateMutationResponse,
    context: ContinueWatchingContext,
    action: LibraryPlaybackStateMutationRequest["action"],
  ) {
    try {
      const now = this.#clock().valueOf();
      this.#database.sqlite
        .transaction(() => {
          const updated = this.#database.sqlite
            .prepare(
              `update user_media_state_operations
               set state = 'succeeded', response_json = ?, failure_code = null,
                   completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(JSON.stringify(response), now, now, operationId);
          if (updated.changes !== 1) throw new MediaPlaybackStateError("storage_failure");
          this.#auditUserMediaStateOperation(operationId, "success", { action }, context, now);
        })
        .immediate();
    } catch (error) {
      if (error instanceof MediaPlaybackStateError) throw error;
      throw new MediaPlaybackStateError("storage_failure", { cause: error });
    }
  }

  #failUserMediaStateOperation(
    operationId: string,
    failureCode: MediaPlaybackStateErrorReason,
    context: ContinueWatchingContext,
    action: LibraryPlaybackStateMutationRequest["action"],
  ) {
    try {
      const now = this.#clock().valueOf();
      this.#database.sqlite
        .transaction(() => {
          const updated = this.#database.sqlite
            .prepare(
              `update user_media_state_operations
               set state = 'failed', response_json = null, failure_code = ?,
                   completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(failureCode, now, now, operationId);
          if (updated.changes !== 1) throw new MediaPlaybackStateError("storage_failure");
          this.#auditUserMediaStateOperation(
            operationId,
            "failure",
            { action, failureCode },
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof MediaPlaybackStateError) throw error;
      throw new MediaPlaybackStateError("storage_failure", { cause: error });
    }
  }

  #auditUserMediaStateOperation(
    operationId: string,
    outcome: "success" | "failure",
    metadata: {
      action: LibraryPlaybackStateMutationRequest["action"];
      failureCode?: MediaPlaybackStateErrorReason;
    },
    context: ContinueWatchingContext,
    createdAt: number,
  ) {
    if (!context.principal.userId) throw new MediaPlaybackStateError("storage_failure");
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method,
           event_type, outcome, target_type, target_id, request_id,
           metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, 'media.playback_state.changed', ?,
                   'user_media_state_operation', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#userMediaStateAuditId(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        outcome,
        operationId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #userMediaStateAuditId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `audit_${this.#createAuditToken()}`;
      if (!IDENTIFIER_PATTERN.test(candidate)) {
        throw new MediaPlaybackStateError("storage_failure");
      }
      const exists = this.#database.sqlite
        .prepare("select 1 from audit_events where id = ? limit 1")
        .get(candidate);
      if (!exists) return candidate;
    }
    throw new MediaPlaybackStateError("storage_failure");
  }

  #pruneUserMediaStateOperations(userId: string, now: number) {
    this.#database.sqlite
      .prepare(
        `delete from user_media_state_operations
         where user_id = ? and state <> 'pending' and completed_at <= ?`,
      )
      .run(userId, now - USER_MEDIA_STATE_OPERATION_RETENTION_MS);
  }

  #userMediaStateOperationId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `user_media_state_${this.#createUserMediaStateOperationToken()}`;
      if (!USER_MEDIA_STATE_OPERATION_ID_PATTERN.test(candidate)) {
        throw new MediaPlaybackStateError("storage_failure");
      }
      const exists = this.#database.sqlite
        .prepare("select 1 from user_media_state_operations where id = ? limit 1")
        .get(candidate);
      if (!exists) return candidate;
    }
    throw new MediaPlaybackStateError("storage_failure");
  }

  #source(principal: SessionPrincipal) {
    const userId = principal.userId;
    const linkedService = principal.linkedServices.find(({ service }) => service === "jellyfin");
    if (!userId || !linkedService) throw new ContinueWatchingError();
    const row = this.#database.sqlite
      .prepare(
        `select
          l.id as linkId,
          l.user_id as linkUserId,
          l.service as linkService,
          l.device_id as deviceId,
          l.external_user_id as externalUserId,
          l.encrypted_access_token as encryptedAccessToken,
          l.health_state as linkHealthState,
          l.revision as linkRevision,
          c.id as connectorId,
          c.type as connectorType,
          c.display_name as connectorDisplayName,
          c.base_url as baseUrl,
          c.encrypted_credentials as encryptedCredentials,
          c.tls_policy as tlsPolicy,
          c.insecure_http_approved as insecureHttpApproved,
          c.enabled as connectorEnabled
         from service_identity_links l
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.id = ? and l.user_id = ?`,
      )
      .get(linkedService.id, userId) as ContinueWatchingSourceRow | undefined;
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
      throw new ContinueWatchingError();
    }
    return row;
  }
}
