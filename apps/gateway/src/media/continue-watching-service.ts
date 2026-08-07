import {
  RadarrAdapter,
  type RadarrLibraryMovieOwnership,
} from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import {
  JellyfinUserMediaClient,
  type JellyfinContinueWatchingResult,
  type JellyfinLibraryTitleResult,
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
  libraryConnectedActionsResponseSchema,
  libraryExtrasQuerySchema,
  libraryExtrasResponseSchema,
  libraryMutationIdempotencyKeySchema,
  libraryPlaybackStateMutationRequestSchema,
  libraryPlaybackStateMutationResponseSchema,
  libraryPersonProfileLinkResponseSchema,
  libraryRemovalCommitRequestSchema,
  libraryRemovalFailureCodeSchema,
  libraryRemovalOperationIdSchema,
  libraryRemovalOperationSchema,
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
  type LibraryConnectedActionsResponse,
  type LibraryExtrasQuery,
  type LibraryExtrasResponse,
  type LibraryPlaybackStateMutationRequest,
  type LibraryPlaybackStateMutationResponse,
  type LibraryPersonProfileLinkResponse,
  type LibraryRemovalCommitRequest,
  type LibraryRemovalOperation,
  type LibraryRemovalPreview,
  type LibrarySeasonEpisodesQuery,
  type LibrarySeasonEpisodesResponse,
  type LibraryTitleDetailResponse,
  type LibraryConnectedAction,
  type LibraryConnectedActionService,
  type ViewingHistoryQuery,
  type ViewingHistoryResponse,
} from "@omnifin/contracts/library";
import {
  connectorCredentialInputSchema,
  connectorPublicUiUrlSchema,
  type PartialFailure,
} from "@omnifin/contracts/connectors";
import {
  playbackContextResponseSchema,
  type PlaybackContextResponse,
} from "@omnifin/contracts/playback";
import type { DiscoveryTrailer } from "@omnifin/contracts/discovery";
import { createHash, X509Certificate } from "node:crypto";
import { z, ZodError } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { DiscoverySearchError, DiscoverySearchService } from "../discovery/search-service.js";
import {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  privacyHash,
  randomToken,
} from "../security/crypto.js";
import {
  MediaReferenceError,
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "./media-reference-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UPSTREAM_MEDIA_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SERVARR_TITLE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,299}$/u;
const MAX_USER_MEDIA_STATE_OPERATIONS_PER_USER = 4_096;
const STALE_USER_MEDIA_STATE_OPERATION_MS = 5 * 60 * 1_000;
const USER_MEDIA_STATE_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const USER_MEDIA_STATE_OPERATION_ID_PATTERN = /^user_media_state_[A-Za-z0-9_-]{22}$/u;
const LIBRARY_REMOVAL_PREVIEW_TTL_MS = 5 * 60 * 1_000;
const MAX_LIBRARY_REMOVAL_PREVIEWS_PER_USER = 20;
const MAX_LIBRARY_REMOVAL_PREVIEW_BYTES = 65_536;
const LIBRARY_REMOVAL_RECENT_AUTH_MS = 10 * 60 * 1_000;
const MAX_LIBRARY_REMOVAL_OPERATIONS_PER_USER = 4_096;
const LIBRARY_REMOVAL_OPERATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const LIBRARY_REMOVAL_STALE_OPERATION_MS = 5 * 60 * 1_000;
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

const storedLibraryRemovalPreviewShape = {
  itemId: z.string().regex(UPSTREAM_MEDIA_IDENTIFIER_PATTERN),
  linkId: z.string().regex(IDENTIFIER_PATTERN),
  linkRevision: z.int().nonnegative().max(2_147_483_647),
  referenceId: z.string().regex(/^media_[A-Za-z0-9_-]{22}$/u),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  userId: z.string().regex(IDENTIFIER_PATTERN),
  year: z.int().min(1870).max(2200).nullable(),
};

const storedLibraryRemovalPreviewV1Schema = z.strictObject({
  ...storedLibraryRemovalPreviewShape,
  schemaVersion: z.literal(1),
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      connectorId: z.string().regex(IDENTIFIER_PATTERN),
      fileId: z.int().positive().max(2_147_483_647).optional(),
      kind: z.literal("managed"),
      mediaId: z.int().positive().max(2_147_483_647),
      monitored: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("unmanaged") }),
  ]),
});

const storedLibraryRemovalPreviewV2Schema = z.strictObject({
  ...storedLibraryRemovalPreviewShape,
  schemaVersion: z.literal(2),
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      connectorId: z.string().regex(IDENTIFIER_PATTERN),
      fileId: z.int().positive().max(2_147_483_647),
      kind: z.literal("managed"),
      mediaId: z.int().positive().max(2_147_483_647),
      monitored: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("unmanaged") }),
  ]),
});

const storedLibraryRemovalPreviewSchema = z.discriminatedUnion("schemaVersion", [
  storedLibraryRemovalPreviewV1Schema,
  storedLibraryRemovalPreviewV2Schema,
]);

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

type LibraryRemovalManagedMovie = RadarrLibraryMovieOwnership & {
  connectorId: string;
};
type LibraryRemovalRadarrAdapter = Pick<
  RadarrAdapter,
  | "deleteLibraryMovie"
  | "deleteLibraryMovieFile"
  | "resolveLibraryMovie"
  | "updateAcquisitionMonitoring"
>;

interface LibraryRemovalManagedResolution {
  adapter: LibraryRemovalRadarrAdapter;
  ownership: LibraryRemovalManagedMovie;
}

interface LibraryConnectedActionTarget {
  publicUiUrl: string;
  titleSlug: string;
}

const libraryConnectedServiceRowSchema = z.strictObject({
  baseUrl: z.string().trim().min(1).max(2_048),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  enabled: z.literal(1),
  encryptedCredentials: z.string().min(1).max(65_536),
  id: z.string().regex(IDENTIFIER_PATTERN),
  insecureHttpApproved: z.union([z.literal(0), z.literal(1)]),
  publicUiUrl: connectorPublicUiUrlSchema,
  tlsPolicy: z.enum(["strict", "allow_self_signed"]),
  type: z.enum(["radarr", "sonarr"]),
  updatedAt: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

type LibraryConnectedServiceRow = z.infer<typeof libraryConnectedServiceRowSchema>;

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

interface LibraryRemovalPreviewRow {
  consumedAt: number | null;
  encryptedPayload: string;
  expiresAt: number;
  linkRevision: number;
  mediaReferenceId: string;
  serviceIdentityLinkId: string;
  sessionId: string;
  userId: string;
}

interface LibraryRemovalOperationRow {
  fingerprintHash: string;
  responseJson: string;
  state: string;
  updatedAt: number;
}

type StoredLibraryRemovalPreview = z.infer<typeof storedLibraryRemovalPreviewSchema>;

type LibraryRemovalReservation =
  | {
      kind: "new";
      operation: LibraryRemovalOperation;
      payload: StoredLibraryRemovalPreview;
    }
  | { kind: "replay"; operation: LibraryRemovalOperation };

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
  createRemovalOperationToken?: () => string;
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
        | "readLibraryPerson"
        | "readLibrarySeasonEpisodes"
        | "readLibraryTitle"
        | "readPlaybackContext"
        | "readViewingHistory"
        | "deleteLibraryItem"
        | "updatePlaybackState"
      >
    >;
  createRadarrAdapter?: (input: ApiKeyConnectorConfig) => LibraryRemovalRadarrAdapter;
  createRadarrNavigationAdapter?: (
    input: ApiKeyConnectorConfig,
  ) => Pick<RadarrAdapter, "resolveLibraryMovieNavigation">;
  createSonarrAdapter?: (
    input: ApiKeyConnectorConfig,
  ) => Pick<SonarrAdapter, "resolveLibrarySeriesNavigation">;
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
  ) => Promise<LibraryRemovalManagedMovie | null>;
  resolveConnectedAction?: (
    input: {
      identity: JellyfinLibraryTitleResult["managementIdentity"];
      service: LibraryConnectedActionService;
    },
    signal?: AbortSignal,
  ) => Promise<LibraryConnectedActionTarget | null>;
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

export type LibraryConnectedActionErrorReason = "not_found" | "unavailable";

export class LibraryConnectedActionError extends Error {
  public readonly code = "library_connected_action_unavailable";
  public readonly reason: LibraryConnectedActionErrorReason;

  public constructor(reason: LibraryConnectedActionErrorReason, options?: ErrorOptions) {
    super("The connected service action is unavailable.", options);
    this.name = "LibraryConnectedActionError";
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

export type LibraryRemovalErrorReason =
  | "authentication_stale"
  | "confirmation_mismatch"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_changed"
  | "invalid_mode"
  | "not_found"
  | "operation_limit_reached"
  | "preview_expired"
  | "source_changed"
  | "storage_failure"
  | "unavailable";

export class LibraryRemovalError extends Error {
  public readonly code = "library_removal_failed";
  public readonly reason: LibraryRemovalErrorReason;

  public constructor(reason: LibraryRemovalErrorReason, options?: ErrorOptions) {
    super("The library title could not be removed safely.", options);
    this.name = "LibraryRemovalError";
    this.reason = reason;
  }
}

export interface LibraryRemovalResult {
  operation: LibraryRemovalOperation;
  replayed: boolean;
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

export type MediaPlaybackContextErrorReason = "not_found" | "unavailable";

export class MediaPlaybackContextError extends Error {
  public readonly reason: MediaPlaybackContextErrorReason;

  public constructor(reason: MediaPlaybackContextErrorReason, options?: ErrorOptions) {
    super(
      reason === "not_found"
        ? "The playback context is no longer available."
        : "Playback context is temporarily unavailable.",
      options,
    );
    this.name = "MediaPlaybackContextError";
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
      : ({
          credentials: decoded,
          schemaVersion: 1,
        } satisfies StoredConnectorSecrets);
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
    totalResults: null,
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
  readonly #createRemovalOperationToken: () => string;
  readonly #createRemovalPreviewToken: () => string;
  readonly #createRadarrAdapter: NonNullable<ContinueWatchingDependencies["createRadarrAdapter"]>;
  readonly #createRadarrNavigationAdapter: NonNullable<
    ContinueWatchingDependencies["createRadarrNavigationAdapter"]
  >;
  readonly #createSonarrAdapter: NonNullable<ContinueWatchingDependencies["createSonarrAdapter"]>;
  readonly #createUserMediaStateOperationToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #references: MediaReferenceService;
  readonly #readOnlineExtras: NonNullable<ContinueWatchingDependencies["readOnlineExtras"]>;
  readonly #resolveManagedMovie: NonNullable<ContinueWatchingDependencies["resolveManagedMovie"]>;
  readonly #resolveConnectedAction: NonNullable<
    ContinueWatchingDependencies["resolveConnectedAction"]
  >;

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
    this.#createRemovalOperationToken =
      dependencies.createRemovalOperationToken ?? (() => randomToken(16));
    this.#createRemovalPreviewToken =
      dependencies.createRemovalPreviewToken ?? (() => randomToken(16));
    this.#createRadarrAdapter =
      dependencies.createRadarrAdapter ?? ((input) => new RadarrAdapter(input));
    this.#createRadarrNavigationAdapter =
      dependencies.createRadarrNavigationAdapter ?? ((input) => new RadarrAdapter(input));
    this.#createSonarrAdapter =
      dependencies.createSonarrAdapter ?? ((input) => new SonarrAdapter(input));
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
    this.#resolveConnectedAction =
      dependencies.resolveConnectedAction ??
      ((input, signal) =>
        this.#resolveConnectedActionFromConnectors(input.identity, input.service, signal));
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
      const titleCredits = result.movie ?? result.seriesCredits;
      const personReferences = this.#personReferences(
        row,
        titleCredits === null ? [] : [...titleCredits.cast, ...titleCredits.crew],
      );
      const publicCredit = (credit: NonNullable<typeof titleCredits>["cast"][number]) => ({
        imagePath:
          credit.image === null ? null : this.#personImagePath(referenceId, credit.image.itemId),
        name: credit.name,
        personReferenceId:
          credit.person === null ? null : (personReferences.get(credit.person.itemId) ?? null),
        role: credit.role,
        type: credit.type,
      });
      return libraryTitleDetailResponseSchema.parse({
        generatedAt: occurredAt.toISOString(),
        media: this.#libraryMedia(result.item, referenceId),
        movie:
          result.movie === null
            ? null
            : {
                ...result.movie,
                cast: result.movie.cast.map(publicCredit),
                crew: result.movie.crew.map(publicCredit),
              },
        playback:
          result.item.kind === "movie" && result.item.runtimeSeconds !== null
            ? {
                durationSeconds: result.item.runtimeSeconds,
                played: result.item.played,
                positionSeconds: result.item.positionSeconds,
              }
            : null,
        providerReferences: result.providerReferences,
        seasons: result.seasons,
        seasonsTruncated: result.seasonsTruncated,
        seriesCredits:
          result.seriesCredits === null
            ? null
            : {
                cast: result.seriesCredits.cast.map(publicCredit),
                castTruncated: result.seriesCredits.castTruncated,
                crew: result.seriesCredits.crew.map(publicCredit),
                crewTruncated: result.seriesCredits.crewTruncated,
              },
      });
    } catch (error) {
      if (error instanceof MediaLibraryError) throw error;
      throw new MediaLibraryError("unavailable", { cause: error });
    }
  }

  public async readConnectedActions(
    referenceId: string,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibraryConnectedActionsResponse> {
    const principal = requirePermission(context.principal, "acquisition.manage");
    let row: ContinueWatchingSourceRow;
    try {
      row = this.#source(principal);
    } catch (error) {
      throw new LibraryConnectedActionError("unavailable", { cause: error });
    }
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new LibraryConnectedActionError("not_found", { cause: error });
    }
    if (reference.kind !== "movie" && reference.kind !== "series") {
      throw new LibraryConnectedActionError("not_found");
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
        result.item.kind !== reference.kind ||
        result.managementIdentity.kind !== reference.kind
      ) {
        throw new MediaReferenceError();
      }
      return libraryConnectedActionsResponseSchema.parse({
        actions: await this.#availableConnectedActions(
          result.managementIdentity,
          referenceId,
          signal,
        ),
        generatedAt: this.#clock().toISOString(),
        mediaKind: result.item.kind,
        referenceId,
      });
    } catch (error) {
      if (error instanceof LibraryConnectedActionError) throw error;
      throw new LibraryConnectedActionError("unavailable", { cause: error });
    }
  }

  public async openConnectedAction(
    referenceId: string,
    service: LibraryConnectedActionService,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<URL> {
    const principal = requirePermission(context.principal, "acquisition.manage");
    let row: ContinueWatchingSourceRow;
    try {
      row = this.#source(principal);
    } catch (error) {
      throw new LibraryConnectedActionError("unavailable", { cause: error });
    }
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new LibraryConnectedActionError("not_found", { cause: error });
    }
    if (
      (reference.kind !== "movie" && reference.kind !== "series") ||
      (reference.kind === "movie" ? service !== "radarr" : service !== "sonarr")
    ) {
      throw new LibraryConnectedActionError("not_found");
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
        result.item.kind !== reference.kind ||
        result.managementIdentity.kind !== reference.kind
      ) {
        throw new MediaReferenceError();
      }
      const target = await this.#resolveConnectedAction(
        { identity: result.managementIdentity, service },
        signal,
      );
      if (target === null) throw new LibraryConnectedActionError("not_found");
      return this.#connectedActionUrl(target, service);
    } catch (error) {
      if (error instanceof LibraryConnectedActionError) throw error;
      throw new LibraryConnectedActionError("unavailable", { cause: error });
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
        onlineSource = {
          displayName: "Online trailers",
          failure: null,
          status: "unconfigured",
        };
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
            onlineSource = {
              displayName: "Seerr",
              failure: null,
              status: "unconfigured",
            };
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
        onlineSource: {
          displayName: "Seerr",
          failure: null,
          status: "unconfigured",
        },
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

  public async readLibraryPersonProfile(
    referenceId: string,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibraryPersonProfileLinkResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new MediaLibraryError("not_found", { cause: error });
    }
    if (reference.kind !== "person") throw new MediaLibraryError("not_found");
    try {
      const client = this.#client(row);
      if (!client.readLibraryPerson) throw new ContinueWatchingConfigurationError();
      const person = await client.readLibraryPerson(
        { itemId: reference.itemId, userId: row.externalUserId },
        signal,
      );
      if (person.itemId !== reference.itemId) throw new MediaReferenceError();
      const [refreshedReferenceId] = this.#references.createOrRefresh(this.#referenceContext(row), [
        this.#personReferenceInput(person.itemId, person.name),
      ]);
      if (refreshedReferenceId !== referenceId) throw new MediaReferenceError();
      return libraryPersonProfileLinkResponseSchema.parse({
        generatedAt: this.#clock().toISOString(),
        name: person.name,
        tmdbId: person.tmdbId,
      });
    } catch (error) {
      if (error instanceof MediaLibraryError) throw error;
      throw new MediaLibraryError("unavailable", { cause: error });
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
      const personReferences = this.#personReferences(
        row,
        result.items.flatMap(({ credits }) => credits),
      );
      const items = result.items.map((item, index) => ({
        airDate: item.airDate,
        communityRating: item.communityRating,
        credits: item.credits.map((credit) => ({
          name: credit.name,
          personReferenceId:
            credit.person === null ? null : (personReferences.get(credit.person.itemId) ?? null),
          role: credit.role,
          type: credit.type,
        })),
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
      if (ownership !== null && (!ownership.hasFile || ownership.fileId === null)) {
        throw new LibraryRemovalPreviewError("unavailable");
      }
      const commonEffects = {
        organizedFiles: "deleted" as const,
        requestHistory: "retained" as const,
        seedingCopies: "unchanged" as const,
        storageReclamation: "may_be_delayed" as const,
      };
      const managed = ownership !== null;
      if (principal.userId === null) throw new LibraryRemovalPreviewError("unavailable");
      const previewId = this.#libraryRemovalPreviewId();
      const preview = libraryRemovalPreviewSchema.parse({
        confirmation: {
          expectedTitle: result.item.title,
          kind: "exact_title",
          recentAuthenticationRequired: true,
        },
        expiresAt: new Date(generatedAt.valueOf() + LIBRARY_REMOVAL_PREVIEW_TTL_MS).toISOString(),
        generatedAt: generatedAt.toISOString(),
        options: managed
          ? [
              ...(ownership?.monitored === true
                ? [
                    {
                      effects: {
                        ...commonEffects,
                        managerRecord: "retained" as const,
                        monitoring: "monitored" as const,
                        reacquisitionRisk: "possible" as const,
                      },
                      mode: "delete_files_keep_monitored" as const,
                    },
                  ]
                : []),
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
        previewId,
        referenceId,
        sizeBytes: ownership?.sizeBytes ?? result.removal.sizeBytes,
        source: managed
          ? {
              kind: "managed",
              monitored: ownership.monitored,
              service: "radarr",
            }
          : { kind: "unmanaged", monitored: null, service: "jellyfin" },
        title: result.item.title,
        year: result.item.year,
      });
      this.#storeLibraryRemovalPreview(
        preview,
        {
          itemId: result.item.externalId,
          linkId: row.linkId,
          linkRevision: row.linkRevision,
          referenceId,
          schemaVersion: 2,
          source:
            ownership === null
              ? { kind: "unmanaged" }
              : {
                  connectorId: ownership.connectorId,
                  fileId: ownership.fileId,
                  kind: "managed",
                  mediaId: ownership.mediaId,
                  monitored: ownership.monitored,
                },
          title: result.item.title,
          userId: principal.userId,
          year: result.item.year,
        },
        row,
        context,
        generatedAt.getTime(),
      );
      return preview;
    } catch (error) {
      if (error instanceof LibraryRemovalPreviewError) throw error;
      throw new LibraryRemovalPreviewError("unavailable", { cause: error });
    }
  }

  public async commitLibraryRemoval(
    referenceId: string,
    rawRequest: LibraryRemovalCommitRequest,
    rawIdempotencyKey: string,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<LibraryRemovalResult> {
    const principal = requirePermission(context.principal, "library.delete");
    if (principal.userId === null) throw new LibraryRemovalError("identity_changed");
    const request = libraryRemovalCommitRequestSchema.parse(rawRequest);
    const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(rawIdempotencyKey);
    const startedAt = this.#clock();
    const issuedAt = Date.parse(principal.issuedAt);
    if (
      !Number.isFinite(issuedAt) ||
      issuedAt > startedAt.getTime() ||
      issuedAt < startedAt.getTime() - LIBRARY_REMOVAL_RECENT_AUTH_MS
    ) {
      throw new LibraryRemovalError("authentication_stale");
    }

    let row: ContinueWatchingSourceRow;
    try {
      row = this.#source(principal);
    } catch (error) {
      throw new LibraryRemovalError("identity_changed", { cause: error });
    }
    const replay = this.#readLibraryRemovalIdempotency(
      principal.userId,
      row,
      referenceId,
      request,
      idempotencyKey,
      context,
    );
    if (replay !== null) return { operation: replay, replayed: true };
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new LibraryRemovalError("not_found", { cause: error });
    }
    if (reference.kind !== "movie") throw new LibraryRemovalError("not_found");

    const reservation = this.#reserveLibraryRemovalOperation(
      principal.userId,
      row,
      referenceId,
      request,
      idempotencyKey,
      context,
      startedAt,
    );
    if (reservation.kind === "replay") {
      return { operation: reservation.operation, replayed: true };
    }

    let operation = reservation.operation;
    const payload = reservation.payload;
    let titleResult: Awaited<ReturnType<JellyfinUserMediaClient["readLibraryTitle"]>>;
    let ownership: LibraryRemovalManagedMovie | null;
    let radarrAdapter: LibraryRemovalRadarrAdapter | null = null;
    try {
      const client = this.#client(row);
      if (!client.readLibraryTitle) throw new ContinueWatchingConfigurationError();
      titleResult = await client.readLibraryTitle(
        { itemId: payload.itemId, userId: row.externalUserId },
        signal,
      );
      if (
        titleResult.item.externalId !== payload.itemId ||
        titleResult.item.kind !== "movie" ||
        !constantTimeTextEqual(titleResult.item.title, payload.title) ||
        titleResult.item.year !== payload.year ||
        titleResult.removal === undefined ||
        titleResult.removal === null ||
        !titleResult.removal.canDelete
      ) {
        return {
          operation: this.#finishLibraryRemovalOperation(
            this.#setLibraryRemovalStage(operation, "source_revalidation", "failed"),
            "failed",
            "source_changed",
            context,
          ),
          replayed: false,
        };
      }
      if (payload.source.kind === "managed") {
        const resolution = await this.#resolveManagedMovieSnapshotFromConnectors(
          titleResult.removal.providerIds,
          signal,
        );
        ownership = resolution?.ownership ?? null;
        radarrAdapter = resolution?.adapter ?? null;
      } else {
        ownership = await this.#resolveManagedMovie(
          { providerIds: titleResult.removal.providerIds },
          signal,
        );
      }
    } catch (_error) {
      return {
        operation: this.#finishLibraryRemovalOperation(
          this.#setLibraryRemovalStage(operation, "source_revalidation", "failed"),
          "failed",
          "connector_unavailable",
          context,
        ),
        replayed: false,
      };
    }

    if (!this.#libraryRemovalSourceMatches(payload, ownership)) {
      return {
        operation: this.#finishLibraryRemovalOperation(
          this.#setLibraryRemovalStage(operation, "source_revalidation", "failed"),
          "failed",
          "source_changed",
          context,
        ),
        replayed: false,
      };
    }
    operation = this.#setLibraryRemovalStage(operation, "source_revalidation", "succeeded");
    this.#persistLibraryRemovalOperation(operation);

    let attemptedStage: "manager_record_removal" | "monitoring_change" | "organized_file_deletion" =
      "organized_file_deletion";
    try {
      if (payload.source.kind === "unmanaged") {
        operation = this.#setLibraryRemovalStage(operation, "organized_file_deletion", "uncertain");
        this.#persistLibraryRemovalOperation(operation);
        attemptedStage = "organized_file_deletion";
        const client = this.#client(row);
        if (!client.deleteLibraryItem) throw new ContinueWatchingConfigurationError();
        await client.deleteLibraryItem(payload.itemId, signal);
        operation = this.#setLibraryRemovalStage(operation, "organized_file_deletion", "succeeded");
      } else {
        if (payload.schemaVersion !== 2 || radarrAdapter === null) {
          throw new ContinueWatchingConfigurationError();
        }
        const adapter = radarrAdapter;
        if (request.mode === "delete_files_and_unmonitor" && payload.source.monitored) {
          attemptedStage = "monitoring_change";
          operation = this.#setLibraryRemovalStage(operation, "monitoring_change", "uncertain");
          this.#persistLibraryRemovalOperation(operation);
          const updated = await adapter.updateAcquisitionMonitoring(
            {
              expectedMonitored: payload.source.monitored,
              mediaId: payload.source.mediaId,
              monitored: false,
              service: "radarr",
            },
            signal,
          );
          if (
            updated.monitored ||
            updated.target.kind !== "movie" ||
            updated.target.mediaId !== payload.source.mediaId ||
            updated.target.service !== "radarr"
          ) {
            throw new ContinueWatchingConfigurationError();
          }
          operation = this.#setLibraryRemovalStage(operation, "monitoring_change", "succeeded");
          this.#persistLibraryRemovalOperation(operation);
        } else if (request.mode === "delete_files_and_unmonitor") {
          operation = this.#setLibraryRemovalStage(operation, "monitoring_change", "succeeded");
          this.#persistLibraryRemovalOperation(operation);
        }

        attemptedStage = "organized_file_deletion";
        operation = this.#setLibraryRemovalStage(operation, "organized_file_deletion", "uncertain");
        if (request.mode === "remove_from_radarr_and_delete_files") {
          operation = this.#setLibraryRemovalStage(
            operation,
            "manager_record_removal",
            "uncertain",
          );
        }
        this.#persistLibraryRemovalOperation(operation);
        if (request.mode === "remove_from_radarr_and_delete_files") {
          attemptedStage = "manager_record_removal";
          await adapter.deleteLibraryMovie(payload.source.mediaId, signal);
          operation = this.#setLibraryRemovalStage(
            operation,
            "manager_record_removal",
            "succeeded",
          );
        } else {
          await adapter.deleteLibraryMovieFile(payload.source.fileId, signal);
        }
        operation = this.#setLibraryRemovalStage(operation, "organized_file_deletion", "succeeded");
      }

      return {
        operation: this.#finishLibraryRemovalOperation(operation, "succeeded", undefined, context),
        replayed: false,
      };
    } catch (_error) {
      operation = this.#setLibraryRemovalStage(operation, attemptedStage, "uncertain");
      return {
        operation: this.#finishLibraryRemovalOperation(
          operation,
          "reconcile_required",
          "outcome_unknown",
          context,
        ),
        replayed: false,
      };
    }
  }

  public readLibraryRemovalOperation(
    rawOperationId: string,
    context: ContinueWatchingContext,
  ): LibraryRemovalOperation {
    const principal = requirePermission(context.principal, "library.delete");
    if (principal.userId === null) throw new LibraryRemovalError("identity_changed");
    const operationId = libraryRemovalOperationIdSchema.parse(rawOperationId);
    const row = this.#database.sqlite
      .prepare(
        `select response_json as responseJson, state, updated_at as updatedAt
           from library_removal_operations
          where id = ? and user_id = ?
          limit 1`,
      )
      .get(operationId, principal.userId) as
      Pick<LibraryRemovalOperationRow, "responseJson" | "state" | "updatedAt"> | undefined;
    if (!row) throw new LibraryRemovalError("not_found");
    try {
      const operation = libraryRemovalOperationSchema.parse(JSON.parse(row.responseJson));
      return row.state === "running"
        ? this.#recoverStaleLibraryRemovalOperation(operation, row.updatedAt, context)
        : operation;
    } catch (error) {
      throw new LibraryRemovalError("storage_failure", { cause: error });
    }
  }

  public async readPlaybackContext(
    referenceId: string,
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<PlaybackContextResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    let reference;
    try {
      reference = this.#references.resolve(this.#referenceContext(row), referenceId);
    } catch (error) {
      throw new MediaPlaybackContextError("not_found", { cause: error });
    }
    if (reference.kind !== "episode") throw new MediaPlaybackContextError("not_found");

    try {
      const client = this.#client(row);
      if (!client.readPlaybackContext) throw new ContinueWatchingConfigurationError();
      const result = await client.readPlaybackContext(
        { itemId: reference.itemId, userId: row.externalUserId },
        signal,
      );
      if (result.nextEpisode?.externalId === reference.itemId) {
        throw new MediaReferenceError();
      }
      const nextReferenceId = result.nextEpisode
        ? this.#references.createOrRefresh(this.#referenceContext(row), [
            {
              artwork: {
                backdropItemId: result.nextEpisode.artwork.backdrop?.itemId ?? null,
                posterItemId: result.nextEpisode.artwork.poster?.itemId ?? null,
              },
              episodeNumber: result.nextEpisode.episodeNumber,
              itemId: result.nextEpisode.externalId,
              kind: "episode",
              seasonNumber: result.nextEpisode.seasonNumber,
              title: result.nextEpisode.title,
              year: result.nextEpisode.year,
            },
          ])[0]!
        : null;
      const nextEpisode = result.nextEpisode
        ? {
            artworkPath: result.nextEpisode.artwork.backdrop
              ? `/v1/media/${nextReferenceId}/images/backdrop`
              : result.nextEpisode.artwork.poster
                ? `/v1/media/${nextReferenceId}/images/poster`
                : null,
            durationSeconds: result.nextEpisode.durationSeconds,
            episodeNumber: result.nextEpisode.episodeNumber,
            mediaReferenceId: nextReferenceId,
            seasonNumber: result.nextEpisode.seasonNumber,
            seriesTitle: result.nextEpisode.seriesTitle,
            title: result.nextEpisode.title,
          }
        : null;
      return playbackContextResponseSchema.parse({
        currentDurationSeconds: result.current.durationSeconds,
        generatedAt: occurredAt.toISOString(),
        mediaReferenceId: referenceId,
        nextEpisode,
        nextState: result.nextState,
        segments: result.segments,
        segmentsState: result.segmentsState,
      });
    } catch (error) {
      throw new MediaPlaybackContextError("unavailable", { cause: error });
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
        {
          linkId: row.linkId,
          linkRevision: row.linkRevision,
          userId: row.linkUserId,
        },
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
      if (reference.kind !== "movie" && reference.kind !== "series") {
        throw new MediaReferenceError();
      }
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
      {
        linkId: row.linkId,
        linkRevision: row.linkRevision,
        userId: row.linkUserId,
      },
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
      {
        linkId: row.linkId,
        linkRevision: row.linkRevision,
        userId: row.linkUserId,
      },
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
      totalResults: result.totalResults,
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

  #personReferenceInput(itemId: string, name: string) {
    return {
      artwork: { backdropItemId: null, posterItemId: null },
      episodeNumber: null,
      itemId,
      kind: "person" as const,
      seasonNumber: null,
      title: name,
      year: null,
    };
  }

  #personReferences(
    row: ContinueWatchingSourceRow,
    credits: readonly {
      name: string;
      person: { itemId: string; tmdbId: number } | null;
    }[],
  ) {
    const eligible = new Map<string, string>();
    for (const credit of credits) {
      if (credit.person !== null && !eligible.has(credit.person.itemId)) {
        eligible.set(credit.person.itemId, credit.name);
      }
    }
    const entries = [...eligible.entries()];
    const references = new Map<string, string>();
    for (let offset = 0; offset < entries.length; offset += 50) {
      const batch = entries.slice(offset, offset + 50);
      const referenceIds = this.#references.createOrRefresh(
        this.#referenceContext(row),
        batch.map(([itemId, name]) => this.#personReferenceInput(itemId, name)),
      );
      for (const [index, [itemId]] of batch.entries()) {
        references.set(itemId, referenceIds[index]!);
      }
    }
    return references;
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
    return {
      linkId: row.linkId,
      linkRevision: row.linkRevision,
      userId: row.linkUserId,
    };
  }

  async #resolveManagedMovieFromConnectors(
    providerIds: { imdb: string | null; tmdb: number | null },
    signal?: AbortSignal,
  ): Promise<LibraryRemovalManagedMovie | null> {
    return (
      (await this.#resolveManagedMovieSnapshotFromConnectors(providerIds, signal))?.ownership ??
      null
    );
  }

  async #resolveManagedMovieSnapshotFromConnectors(
    providerIds: { imdb: string | null; tmdb: number | null },
    signal?: AbortSignal,
  ): Promise<LibraryRemovalManagedResolution | null> {
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
        const { apiKey, tlsCaCertificatePem } = this.#apiKeySecrets(row, "radarr");
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
        const ownership = await adapter.resolveLibraryMovie(providerIds, signal);
        return ownership === null
          ? null
          : { adapter, ownership: { ...ownership, connectorId: row.id } };
      }),
    );
    const owned = matches.filter(
      (match): match is LibraryRemovalManagedResolution => match !== null,
    );
    if (owned.length > 1) throw new ContinueWatchingConfigurationError("invalid");
    return owned[0] ?? null;
  }

  async #availableConnectedActions(
    identity: JellyfinLibraryTitleResult["managementIdentity"],
    referenceId: string,
    signal?: AbortSignal,
  ): Promise<LibraryConnectedAction[]> {
    const service = identity.kind === "movie" ? "radarr" : "sonarr";
    try {
      const target = await this.#resolveConnectedAction({ identity, service }, signal);
      if (target === null) return [];
      return [
        {
          href: `/v1/media/library/${referenceId}/actions/${service}`,
          kind: "service_navigation",
          label: service === "radarr" ? "Open in Radarr" : "Open in Sonarr",
          service,
        },
      ];
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  }

  async #resolveConnectedActionFromConnectors(
    identity: JellyfinLibraryTitleResult["managementIdentity"],
    service: LibraryConnectedActionService,
    signal?: AbortSignal,
  ): Promise<LibraryConnectedActionTarget | null> {
    if (identity.kind === "movie" ? service !== "radarr" : service !== "sonarr") {
      throw new ContinueWatchingConfigurationError("invalid");
    }
    if (
      (identity.kind === "movie" &&
        identity.providerIds.imdb === null &&
        identity.providerIds.tmdb === null) ||
      (identity.kind === "series" &&
        identity.providerIds.tvdb === null &&
        identity.providerIds.tmdb === null)
    ) {
      return null;
    }
    const rows = this.#connectedServiceRows(service);
    if (rows.length === 0) return null;
    if (rows.length > 10) throw new ContinueWatchingConfigurationError("invalid");

    const resolutionController = new AbortController();
    const resolutionSignal =
      signal === undefined
        ? resolutionController.signal
        : AbortSignal.any([signal, resolutionController.signal]);
    try {
      const matches = await Promise.all(
        rows.map(async (row) => {
          try {
            if (row.type !== service) throw new ContinueWatchingConfigurationError("invalid");
            const { apiKey, tlsCaCertificatePem } = this.#apiKeySecrets(row, service);
            const config = {
              apiKey,
              baseUrl: row.baseUrl,
              clock: {
                monotonicNow: () => performance.now(),
                now: this.#clock,
              },
              connectorId: row.id,
              displayName: row.displayName,
              insecureHttpApproved: row.insecureHttpApproved === 1,
              tlsPolicy: row.tlsPolicy,
              ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
            } satisfies ApiKeyConnectorConfig;
            let navigation;
            if (identity.kind === "movie") {
              navigation = await this.#createRadarrNavigationAdapter(
                config,
              ).resolveLibraryMovieNavigation(identity.providerIds, resolutionSignal);
            } else {
              navigation = await this.#createSonarrAdapter(config).resolveLibrarySeriesNavigation(
                identity.providerIds,
                resolutionSignal,
              );
            }
            return navigation === null
              ? null
              : { connectorId: row.id, titleSlug: navigation.titleSlug };
          } catch (error) {
            resolutionController.abort();
            throw error;
          }
        }),
      );
      const resolved = matches.filter(
        (match): match is NonNullable<(typeof matches)[number]> => match !== null,
      );
      if (resolved.length > 1) throw new ContinueWatchingConfigurationError("invalid");
      const selected = resolved[0];
      if (selected === undefined) return null;

      const currentRows = this.#connectedServiceRows(service);
      if (
        currentRows.length !== rows.length ||
        rows.some((row, index) =>
          this.#connectedServiceConfigurationChanged(row, currentRows[index]),
        )
      ) {
        throw new ContinueWatchingConfigurationError("invalid");
      }
      const current = currentRows.find((row) => row.id === selected.connectorId);
      if (current === undefined || current.type !== service) {
        throw new ContinueWatchingConfigurationError("invalid");
      }
      return {
        publicUiUrl: current.publicUiUrl,
        titleSlug: selected.titleSlug,
      };
    } finally {
      resolutionController.abort();
    }
  }

  #connectedServiceRows(service: LibraryConnectedActionService) {
    return (
      this.#database.sqlite
        .prepare(
          `select id, type, display_name as displayName, base_url as baseUrl, enabled,
                  encrypted_credentials as encryptedCredentials,
                  tls_policy as tlsPolicy, insecure_http_approved as insecureHttpApproved,
                  public_ui_url as publicUiUrl, updated_at as updatedAt
             from connector_configs
            where type = ? and enabled = 1 and public_ui_url is not null
            order by id asc
            limit 11`,
        )
        .all(service) as unknown[]
    ).map((row) => libraryConnectedServiceRowSchema.parse(row));
  }

  #connectedServiceConfigurationChanged(
    previous: LibraryConnectedServiceRow,
    current: LibraryConnectedServiceRow | undefined,
  ) {
    return current === undefined || JSON.stringify(previous) !== JSON.stringify(current);
  }

  #connectedActionUrl(
    target: LibraryConnectedActionTarget,
    service: LibraryConnectedActionService,
  ) {
    const base = new URL(connectorPublicUiUrlSchema.parse(target.publicUiUrl));
    if (!SERVARR_TITLE_SLUG_PATTERN.test(target.titleSlug)) {
      throw new ContinueWatchingConfigurationError("invalid");
    }
    const destination = new URL(
      `${service === "radarr" ? "movie" : "series"}/${encodeURIComponent(target.titleSlug)}`,
      base,
    );
    if (destination.href.length > 2_304) {
      throw new ContinueWatchingConfigurationError("invalid");
    }
    return destination;
  }

  #libraryRemovalPreviewId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `library_removal_preview_${this.#createRemovalPreviewToken()}`;
      if (!/^library_removal_preview_[A-Za-z0-9_-]{22}$/u.test(candidate)) {
        throw new LibraryRemovalPreviewError("unavailable");
      }
      const exists = this.#database.sqlite
        .prepare("select 1 from library_removal_previews where id = ? limit 1")
        .get(candidate);
      if (!exists) return candidate;
    }
    throw new LibraryRemovalPreviewError("unavailable");
  }

  #storeLibraryRemovalPreview(
    preview: LibraryRemovalPreview,
    rawPayload: z.input<typeof storedLibraryRemovalPreviewV2Schema>,
    row: ContinueWatchingSourceRow,
    context: ContinueWatchingContext,
    now: number,
  ) {
    const payload = storedLibraryRemovalPreviewSchema.parse(rawPayload);
    if (context.principal.userId !== payload.userId) {
      throw new LibraryRemovalPreviewError("unavailable");
    }
    const encryptedPayload = this.#cipher.encrypt(
      JSON.stringify(payload),
      `library_removal_preview:${preview.previewId}`,
    );
    if (Buffer.byteLength(encryptedPayload, "utf8") > MAX_LIBRARY_REMOVAL_PREVIEW_BYTES) {
      throw new LibraryRemovalPreviewError("unavailable");
    }
    try {
      this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare("delete from library_removal_previews where expires_at <= ?")
            .run(now);
          const { count } = this.#database.sqlite
            .prepare(
              `select count(*) as count
                 from library_removal_previews
                where user_id = ? and consumed_at is null`,
            )
            .get(payload.userId) as { count: number };
          if (count >= MAX_LIBRARY_REMOVAL_PREVIEWS_PER_USER) {
            throw new LibraryRemovalPreviewError("unavailable");
          }
          this.#database.sqlite
            .prepare(
              `insert into library_removal_previews (
                 id, user_id, session_id, service_identity_link_id, link_revision,
                 media_reference_id, encrypted_payload, expires_at, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              preview.previewId,
              payload.userId,
              context.principal.sessionId,
              row.linkId,
              row.linkRevision,
              preview.referenceId,
              encryptedPayload,
              Date.parse(preview.expiresAt),
              now,
              now,
            );
          this.#database.sqlite
            .prepare(
              `insert into audit_events (
                 id, actor_user_id, actor_session_id, actor_auth_method,
                 event_type, outcome, target_type, target_id, request_id,
                 metadata_json, ip_hash, created_at
               ) values (?, ?, ?, ?, 'library.removal.preview.created', 'success',
                         'library_removal_preview', ?, ?, ?, ?, ?)`,
            )
            .run(
              this.#userMediaStateAuditId(),
              payload.userId,
              context.principal.sessionId,
              context.principal.authenticationMethod.kind,
              preview.previewId,
              context.requestId ?? null,
              JSON.stringify({
                optionCount: preview.options.length,
                source: preview.source.service,
              }),
              context.ipAddress
                ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
                : null,
              now,
            );
        })
        .immediate();
    } catch (error) {
      if (error instanceof LibraryRemovalPreviewError) throw error;
      throw new LibraryRemovalPreviewError("unavailable", { cause: error });
    }
  }

  #libraryRemovalFingerprint(
    row: ContinueWatchingSourceRow,
    referenceId: string,
    request: LibraryRemovalCommitRequest,
  ) {
    return hashToken(
      JSON.stringify({
        linkId: row.linkId,
        linkRevision: row.linkRevision,
        referenceId,
        request,
        version: 1,
      }),
    );
  }

  #readLibraryRemovalIdempotency(
    userId: string,
    row: ContinueWatchingSourceRow,
    referenceId: string,
    request: LibraryRemovalCommitRequest,
    idempotencyKey: string,
    context: ContinueWatchingContext,
  ) {
    const keyHash = hashToken(`${userId}\0library_removal\0${idempotencyKey}`);
    const fingerprintHash = this.#libraryRemovalFingerprint(row, referenceId, request);
    const existing = this.#database.sqlite
      .prepare(
        `select fingerprint_hash as fingerprintHash, response_json as responseJson, state,
                updated_at as updatedAt
           from library_removal_operations
          where user_id = ? and idempotency_key_hash = ?
          limit 1`,
      )
      .get(userId, keyHash) as LibraryRemovalOperationRow | undefined;
    if (!existing) return null;
    if (!constantTimeTextEqual(existing.fingerprintHash, fingerprintHash)) {
      throw new LibraryRemovalError("idempotency_conflict");
    }
    try {
      const operation = libraryRemovalOperationSchema.parse(JSON.parse(existing.responseJson));
      if (existing.state !== "running") return operation;
      const recovered = this.#recoverStaleLibraryRemovalOperation(
        operation,
        existing.updatedAt,
        context,
      );
      if (recovered.state === "running") {
        throw new LibraryRemovalError("idempotency_in_progress");
      }
      return recovered;
    } catch (error) {
      if (error instanceof LibraryRemovalError) throw error;
      throw new LibraryRemovalError("storage_failure", { cause: error });
    }
  }

  #reserveLibraryRemovalOperation(
    userId: string,
    row: ContinueWatchingSourceRow,
    referenceId: string,
    request: LibraryRemovalCommitRequest,
    idempotencyKey: string,
    context: ContinueWatchingContext,
    startedAt: Date,
  ): LibraryRemovalReservation {
    const now = startedAt.getTime();
    const keyHash = hashToken(`${userId}\0library_removal\0${idempotencyKey}`);
    const fingerprintHash = this.#libraryRemovalFingerprint(row, referenceId, request);
    try {
      return this.#database.sqlite
        .transaction((): LibraryRemovalReservation => {
          const existing = this.#database.sqlite
            .prepare(
              `select fingerprint_hash as fingerprintHash, response_json as responseJson, state
                 from library_removal_operations
                where user_id = ? and idempotency_key_hash = ?
                limit 1`,
            )
            .get(userId, keyHash) as
            | Pick<LibraryRemovalOperationRow, "fingerprintHash" | "responseJson" | "state">
            | undefined;
          if (existing) {
            if (!constantTimeTextEqual(existing.fingerprintHash, fingerprintHash)) {
              throw new LibraryRemovalError("idempotency_conflict");
            }
            if (existing.state === "running") {
              throw new LibraryRemovalError("idempotency_in_progress");
            }
            return {
              kind: "replay",
              operation: libraryRemovalOperationSchema.parse(JSON.parse(existing.responseJson)),
            };
          }

          this.#database.sqlite
            .prepare(
              `delete from library_removal_operations
                where completed_at is not null and completed_at < ?`,
            )
            .run(now - LIBRARY_REMOVAL_OPERATION_RETENTION_MS);
          const { count } = this.#database.sqlite
            .prepare("select count(*) as count from library_removal_operations where user_id = ?")
            .get(userId) as { count: number };
          if (count >= MAX_LIBRARY_REMOVAL_OPERATIONS_PER_USER) {
            throw new LibraryRemovalError("operation_limit_reached");
          }

          const previewRow = this.#database.sqlite
            .prepare(
              `select user_id as userId, session_id as sessionId,
                      service_identity_link_id as serviceIdentityLinkId,
                      link_revision as linkRevision, media_reference_id as mediaReferenceId,
                      encrypted_payload as encryptedPayload, expires_at as expiresAt,
                      consumed_at as consumedAt
                 from library_removal_previews
                where id = ?
                limit 1`,
            )
            .get(request.previewId) as LibraryRemovalPreviewRow | undefined;
          if (!previewRow || previewRow.userId !== userId) {
            throw new LibraryRemovalError("not_found");
          }
          if (previewRow.expiresAt <= now) throw new LibraryRemovalError("preview_expired");
          if (previewRow.consumedAt !== null) throw new LibraryRemovalError("not_found");
          if (
            previewRow.sessionId !== context.principal.sessionId ||
            previewRow.serviceIdentityLinkId !== row.linkId ||
            previewRow.linkRevision !== row.linkRevision ||
            previewRow.mediaReferenceId !== referenceId
          ) {
            throw new LibraryRemovalError("identity_changed");
          }

          let payload: StoredLibraryRemovalPreview;
          try {
            payload = storedLibraryRemovalPreviewSchema.parse(
              JSON.parse(
                this.#cipher.decrypt(
                  previewRow.encryptedPayload,
                  `library_removal_preview:${request.previewId}`,
                ),
              ),
            );
          } catch (error) {
            throw new LibraryRemovalError("storage_failure", { cause: error });
          }
          if (
            payload.userId !== userId ||
            payload.linkId !== row.linkId ||
            payload.linkRevision !== row.linkRevision ||
            payload.referenceId !== referenceId
          ) {
            throw new LibraryRemovalError("identity_changed");
          }
          if (payload.schemaVersion === 1 && payload.source.kind === "managed") {
            throw new LibraryRemovalError("source_changed");
          }
          if (!constantTimeTextEqual(request.confirmationTitle, payload.title)) {
            throw new LibraryRemovalError("confirmation_mismatch");
          }
          if (
            (payload.source.kind === "managed" && request.mode === "delete_unmanaged_files") ||
            (payload.source.kind === "unmanaged" && request.mode !== "delete_unmanaged_files") ||
            (payload.source.kind === "managed" &&
              !payload.source.monitored &&
              request.mode === "delete_files_keep_monitored")
          ) {
            throw new LibraryRemovalError("invalid_mode");
          }

          const targetDigest = this.#libraryRemovalTargetDigest(payload, row.connectorId);
          const runningTarget = this.#database.sqlite
            .prepare(
              `select response_json as responseJson, updated_at as updatedAt, user_id as userId
                 from library_removal_operations
                where target_digest = ? and state = 'running'
                limit 1`,
            )
            .get(targetDigest) as
            { responseJson: string; updatedAt: number; userId: string } | undefined;
          if (runningTarget) {
            const runningOperation = libraryRemovalOperationSchema.parse(
              JSON.parse(runningTarget.responseJson),
            );
            const recovered = this.#recoverStaleLibraryRemovalOperationInTransaction(
              runningOperation,
              runningTarget.updatedAt,
              runningTarget.userId === userId ? context : undefined,
            );
            if (recovered.state === "running") {
              throw new LibraryRemovalError("idempotency_in_progress");
            }
          }

          const operationId = this.#libraryRemovalOperationId();
          const operation = this.#initialLibraryRemovalOperation(
            operationId,
            referenceId,
            request,
            startedAt,
          );
          const encryptedPayload = this.#cipher.encrypt(
            JSON.stringify(payload),
            `library_removal_operation:${operationId}`,
          );
          if (Buffer.byteLength(encryptedPayload, "utf8") > MAX_LIBRARY_REMOVAL_PREVIEW_BYTES) {
            throw new LibraryRemovalError("storage_failure");
          }
          this.#database.sqlite
            .prepare(
              `insert into library_removal_operations (
                 id, user_id, session_id, service_identity_link_id, link_revision,
                 media_reference_id, preview_id, mode, idempotency_key_hash,
                 fingerprint_hash, target_digest, state, response_json, encrypted_payload,
                 started_at, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
            )
            .run(
              operationId,
              userId,
              context.principal.sessionId,
              row.linkId,
              row.linkRevision,
              referenceId,
              request.previewId,
              request.mode,
              keyHash,
              fingerprintHash,
              targetDigest,
              JSON.stringify(operation),
              encryptedPayload,
              now,
              now,
              now,
            );
          const consumed = this.#database.sqlite
            .prepare(
              `update library_removal_previews
                  set consumed_at = ?, updated_at = ?
                where id = ? and consumed_at is null and expires_at > ?`,
            )
            .run(now, now, request.previewId, now);
          if (consumed.changes !== 1) throw new LibraryRemovalError("preview_expired");
          this.#insertLibraryRemovalAudit(
            "library.removal.requested",
            "success",
            operation,
            context,
            now,
          );
          return { kind: "new", operation, payload };
        })
        .immediate();
    } catch (error) {
      if (error instanceof LibraryRemovalError) throw error;
      throw new LibraryRemovalError("storage_failure", { cause: error });
    }
  }

  #initialLibraryRemovalOperation(
    operationId: string,
    referenceId: string,
    request: LibraryRemovalCommitRequest,
    startedAt: Date,
  ) {
    return libraryRemovalOperationSchema.parse({
      completedAt: null,
      mode: request.mode,
      operationId,
      previewId: request.previewId,
      referenceId,
      stages: [
        { kind: "authorization_recheck", state: "succeeded" },
        { kind: "source_revalidation", state: "pending" },
        {
          kind: "monitoring_change",
          state: request.mode === "delete_files_and_unmonitor" ? "pending" : "not_applicable",
        },
        { kind: "organized_file_deletion", state: "pending" },
        {
          kind: "manager_record_removal",
          state:
            request.mode === "remove_from_radarr_and_delete_files" ? "pending" : "not_applicable",
        },
        { kind: "jellyfin_reconciliation", state: "not_applicable" },
      ],
      startedAt: startedAt.toISOString(),
      state: "running",
    });
  }

  #setLibraryRemovalStage(
    operation: LibraryRemovalOperation,
    kind: LibraryRemovalOperation["stages"][number]["kind"],
    state: LibraryRemovalOperation["stages"][number]["state"],
  ) {
    return libraryRemovalOperationSchema.parse({
      ...operation,
      stages: operation.stages.map((stage) => (stage.kind === kind ? { ...stage, state } : stage)),
    });
  }

  #persistLibraryRemovalOperation(operation: LibraryRemovalOperation) {
    const now = this.#clock().getTime();
    try {
      const updated = this.#database.sqlite
        .prepare(
          `update library_removal_operations
              set response_json = ?, updated_at = ?
            where id = ? and state = 'running'`,
        )
        .run(
          JSON.stringify(libraryRemovalOperationSchema.parse(operation)),
          now,
          operation.operationId,
        );
      if (updated.changes !== 1) throw new Error("operation_not_running");
    } catch (error) {
      throw new LibraryRemovalError("storage_failure", { cause: error });
    }
  }

  #finishLibraryRemovalOperation(
    operation: LibraryRemovalOperation,
    state: "failed" | "reconcile_required" | "succeeded",
    rawFailureCode: z.input<typeof libraryRemovalFailureCodeSchema> | undefined,
    context: ContinueWatchingContext,
  ) {
    const completedAt = this.#clock();
    const failureCode =
      rawFailureCode === undefined
        ? undefined
        : libraryRemovalFailureCodeSchema.parse(rawFailureCode);
    const terminal = libraryRemovalOperationSchema.parse({
      ...operation,
      completedAt: completedAt.toISOString(),
      ...(failureCode === undefined ? {} : { failureCode }),
      state,
    });
    const clearedEncryptedPayload =
      state === "reconcile_required"
        ? null
        : this.#cipher.encrypt(
            JSON.stringify({ schemaVersion: 1, state: "cleared" }),
            `library_removal_operation:${terminal.operationId}`,
          );
    try {
      this.#database.sqlite
        .transaction(() => {
          if (state === "succeeded") {
            this.#invalidateSavedOwnershipAfterLibraryRemoval(
              context.principal.userId!,
              terminal.referenceId,
              completedAt.getTime(),
            );
          }
          const updated = this.#database.sqlite
            .prepare(
              `update library_removal_operations
                  set state = ?, response_json = ?, failure_code = ?, completed_at = ?, updated_at = ?,
                      encrypted_payload = coalesce(?, encrypted_payload)
                where id = ? and state = 'running'`,
            )
            .run(
              state,
              JSON.stringify(terminal),
              failureCode ?? null,
              completedAt.getTime(),
              completedAt.getTime(),
              clearedEncryptedPayload,
              terminal.operationId,
            );
          if (updated.changes !== 1) throw new Error("operation_not_running");
          this.#insertLibraryRemovalAudit(
            state === "succeeded"
              ? "library.removal.completed"
              : state === "reconcile_required"
                ? "library.removal.reconciliation_required"
                : "library.removal.failed",
            state === "succeeded" ? "success" : "failure",
            terminal,
            context,
            completedAt.getTime(),
          );
        })
        .immediate();
      return terminal;
    } catch (error) {
      throw new LibraryRemovalError("storage_failure", { cause: error });
    }
  }

  #invalidateSavedOwnershipAfterLibraryRemoval(userId: string, referenceId: string, now: number) {
    const exhausted = this.#database.sqlite
      .prepare(
        `select 1
         from saved_lists
         join saved_list_items on saved_list_items.list_id = saved_lists.id
         join saved_catalog_items on saved_catalog_items.id = saved_list_items.catalog_item_id
         where saved_lists.user_id = ? and saved_lists.deleted_at is null
           and saved_catalog_items.user_id = ?
           and saved_catalog_items.library_reference_id = ?
           and saved_lists.revision >= 2147483647
         limit 1`,
      )
      .get(userId, userId, referenceId);
    if (exhausted) throw new LibraryRemovalError("storage_failure");
    this.#database.sqlite
      .prepare(
        `update saved_lists set revision = revision + 1, updated_at = ?
         where user_id = ? and deleted_at is null and id in (
           select saved_list_items.list_id
           from saved_list_items
           join saved_catalog_items on saved_catalog_items.id = saved_list_items.catalog_item_id
           where saved_list_items.user_id = ? and saved_catalog_items.user_id = ?
             and saved_catalog_items.library_reference_id = ?
         )`,
      )
      .run(now, userId, userId, userId, referenceId);
    this.#database.sqlite
      .prepare(
        `delete from saved_targets
         where user_id = ? and identity_digest in (
           select identity_digest from saved_catalog_items
           where user_id = ? and library_reference_id = ?
         )`,
      )
      .run(userId, userId, referenceId);
    // Invalidate the reference only while it is still owned by a saved catalog
    // item (before the ownership link is cleared below), so removal of a title
    // that is not saved does not break later same-target removal commits.
    this.#database.sqlite
      .prepare(
        `update media_references
         set link_revision = case
               when link_revision < 2147483647 then link_revision + 1
               else link_revision - 1
             end,
             updated_at = ?
         where id = ? and user_id = ?
           and exists (
             select 1 from saved_catalog_items
             where user_id = ? and library_reference_id = media_references.id
           )`,
      )
      .run(now, referenceId, userId, userId);
    this.#database.sqlite
      .prepare(
        `update saved_catalog_items
         set library_reference_id = null, library_reference_user_id = null,
             last_resolved_at = null, updated_at = ?
         where user_id = ? and library_reference_id = ?`,
      )
      .run(now, userId, referenceId);
  }

  #recoverStaleLibraryRemovalOperation(
    operation: LibraryRemovalOperation,
    updatedAt: number,
    context: ContinueWatchingContext,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() =>
          this.#recoverStaleLibraryRemovalOperationInTransaction(operation, updatedAt, context),
        )
        .immediate();
    } catch (error) {
      if (error instanceof LibraryRemovalError) throw error;
      throw new LibraryRemovalError("storage_failure", { cause: error });
    }
  }

  #recoverStaleLibraryRemovalOperationInTransaction(
    operation: LibraryRemovalOperation,
    updatedAt: number,
    context?: ContinueWatchingContext,
  ) {
    const completedAt = this.#clock();
    const cutoff = completedAt.getTime() - LIBRARY_REMOVAL_STALE_OPERATION_MS;
    if (operation.state !== "running" || updatedAt > cutoff) return operation;
    const terminal = libraryRemovalOperationSchema.parse({
      ...operation,
      completedAt: completedAt.toISOString(),
      failureCode: "outcome_unknown",
      state: "reconcile_required",
    });
    const updated = this.#database.sqlite
      .prepare(
        `update library_removal_operations
            set state = 'reconcile_required', response_json = ?,
                failure_code = 'outcome_unknown', completed_at = ?, updated_at = ?
          where id = ? and state = 'running' and updated_at <= ?`,
      )
      .run(
        JSON.stringify(terminal),
        completedAt.getTime(),
        completedAt.getTime(),
        operation.operationId,
        cutoff,
      );
    if (updated.changes === 1) {
      this.#insertLibraryRemovalAudit(
        "library.removal.reconciliation_required",
        "failure",
        terminal,
        context,
        completedAt.getTime(),
      );
      return terminal;
    }
    const current = this.#database.sqlite
      .prepare(
        "select response_json as responseJson from library_removal_operations where id = ? limit 1",
      )
      .get(operation.operationId) as Pick<LibraryRemovalOperationRow, "responseJson"> | undefined;
    if (!current) throw new LibraryRemovalError("not_found");
    return libraryRemovalOperationSchema.parse(JSON.parse(current.responseJson));
  }

  #insertLibraryRemovalAudit(
    eventType: string,
    outcome: "failure" | "success",
    operation: LibraryRemovalOperation,
    context: ContinueWatchingContext | undefined,
    now: number,
  ) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method,
           event_type, outcome, target_type, target_id, request_id,
           metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, ?, ?, 'library_removal_operation', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#userMediaStateAuditId(),
        context?.principal.userId ?? null,
        context?.principal.sessionId ?? null,
        context?.principal.authenticationMethod.kind ?? null,
        eventType,
        outcome,
        operation.operationId,
        context?.requestId ?? null,
        JSON.stringify({
          failureCode: operation.failureCode ?? null,
          mode: operation.mode,
          state: operation.state,
        }),
        context?.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        now,
      );
  }

  #libraryRemovalSourceMatches(
    payload: StoredLibraryRemovalPreview,
    ownership: LibraryRemovalManagedMovie | null,
  ) {
    if (payload.source.kind === "unmanaged") return ownership === null;
    if (payload.schemaVersion !== 2) return false;
    return (
      ownership !== null &&
      ownership.hasFile &&
      ownership.connectorId === payload.source.connectorId &&
      ownership.fileId === payload.source.fileId &&
      ownership.mediaId === payload.source.mediaId &&
      ownership.monitored === payload.source.monitored
    );
  }

  #libraryRemovalTargetDigest(payload: StoredLibraryRemovalPreview, connectorId: string) {
    const target =
      payload.source.kind === "unmanaged"
        ? { connectorId, itemId: payload.itemId, kind: "unmanaged", version: 1 }
        : payload.schemaVersion === 2
          ? {
              connectorId: payload.source.connectorId,
              kind: "managed",
              mediaId: payload.source.mediaId,
              version: 1,
            }
          : null;
    if (target === null) throw new LibraryRemovalError("source_changed");
    return privacyHash(
      "library_removal_target",
      JSON.stringify(target),
      this.#config.encryptionKey,
    );
  }

  #libraryRemovalOperationId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `library_removal_operation_${this.#createRemovalOperationToken()}`;
      if (!/^library_removal_operation_[A-Za-z0-9_-]{22}$/u.test(candidate)) {
        throw new LibraryRemovalError("storage_failure");
      }
      const exists = this.#database.sqlite
        .prepare("select 1 from library_removal_operations where id = ? limit 1")
        .get(candidate);
      if (!exists) return candidate;
    }
    throw new LibraryRemovalError("storage_failure");
  }

  #apiKeySecrets(row: LibraryRemovalRadarrRow, service: LibraryConnectedActionService) {
    try {
      const decoded = JSON.parse(
        this.#cipher.decrypt(
          row.encryptedCredentials,
          `connector_credentials:${service}:${row.id}`,
        ),
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
        : ({
            credentials: decoded,
            schemaVersion: 1,
          } satisfies StoredConnectorSecrets);
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
