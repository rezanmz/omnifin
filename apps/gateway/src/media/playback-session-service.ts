import {
  JellyfinPlaybackClient,
  JellyfinPlaybackUnavailableError,
  isJellyfinPlaybackTargetPath,
  isTextSubtitleCodec,
  type JellyfinPlaybackBytesResult,
  type JellyfinPlaybackResult,
  type JellyfinPlaybackReportingSession,
  type JellyfinPlaybackStreamResult,
  type JellyfinPlaybackTarget,
} from "@omnifin/connectors/media/jellyfin-playback-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { connectorCredentialInputSchema } from "@omnifin/contracts/connectors";
import {
  playbackNegotiationRequestSchema,
  playbackNegotiationResponseSchema,
  playbackProgressRequestSchema,
  playbackProgressResponseSchema,
  playbackSessionIdSchema,
  type PlaybackNegotiationRequest,
  type PlaybackNegotiationResponse,
  type PlaybackProgressRequest,
  type PlaybackProgressResponse,
} from "@omnifin/contracts/playback";
import { X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  privacyHash,
  randomToken,
} from "../security/crypto.js";
import {
  ExternalMutationJournal,
  ExternalMutationJournalError,
  type ExternalMutationRecord,
} from "../operations/external-mutation-journal.js";
import {
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "./media-reference-service.js";
import { matchesPlaybackSourceReference } from "./playback-source-reference.js";
import {
  MAX_PLAYBACK_ASSET_TOKEN_LENGTH,
  MAX_PLAYBACK_MANIFEST_BYTES,
  MAX_PLAYBACK_MANIFEST_REFERENCES,
  PlaybackTransferLeaseManager,
  type PlaybackTransferLimitOverrides,
} from "./playback-limits.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PLAYBACK_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const STOPPED_SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_PLAYBACK_SESSIONS_PER_USER = 32;
const MAX_CREATION_ATTEMPTS = 8;
const DIRECT_RANGE_BYTES = 8 * 1_024 * 1_024;
const HLS_ASSET_MAX_BYTES = 512 * 1_024 * 1_024;
const SUBTITLE_MAX_BYTES = 8 * 1_024 * 1_024;
const MAX_MANIFEST_LINES = 20_000;
const MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION = 20_000;
const MAX_PLAYBACK_ASSET_HANDLES_GLOBAL = 250_000;
const PLAYBACK_PROGRESS_LEASE_MS = 30_000;
const PLAYBACK_LIFECYCLE_BATCH_SIZE = 100;
const MAX_PLAYBACK_REVISION = 2_147_483_647;
const PLAYBACK_ASSET_HANDLE_PATTERN = /^asset_h1\.[A-Za-z0-9_-]{22}$/u;
const LEGACY_PLAYBACK_ASSET_PATTERN = /^asset_v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
type PlaybackAssetPathPrefix = "./" | "hls/";
const SENSITIVE_QUERY_NAMES = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "token",
  "x-emby-token",
  "x-mediabrowser-token",
]);

const identifierSchema = z.string().regex(IDENTIFIER_PATTERN);

const playbackTargetSchema = z.strictObject({
  path: z.string().refine(isJellyfinPlaybackTargetPath),
  query: z.string().max(32_768),
});

const playbackProgressEvidenceSchema = z.strictObject({
  event: z.enum(["started", "progress", "paused", "stopped"]),
  playbackSessionId: playbackSessionIdSchema,
  positionSeconds: z.int().nonnegative().max(10_000_000),
  schemaVersion: z.literal(1),
  sessionRevision: z.int().nonnegative().max(MAX_PLAYBACK_REVISION),
});

const storedPlaybackSchema = z
  .strictObject({
    audioStreamIndex: z.int().nonnegative().max(4_095).nullable(),
    durationSeconds: z.int().positive().max(10_000_000),
    itemId: identifierSchema,
    liveStreamId: identifierSchema.nullable(),
    mediaSourceId: identifierSchema,
    playMethod: z.enum(["DirectPlay", "DirectStream", "Transcode"]),
    playSessionId: identifierSchema,
    schemaVersion: z.literal(2),
    subtitleStreamIndex: z.int().nonnegative().max(4_095).nullable(),
    textSubtitleIndexes: z.array(z.int().nonnegative().max(4_095)).max(128),
    upstreamTarget: playbackTargetSchema,
  })
  .superRefine((payload, context) => {
    let query: URLSearchParams;
    try {
      query = new URLSearchParams(payload.upstreamTarget.query);
    } catch {
      context.addIssue({ code: "custom", path: ["upstreamTarget", "query"] });
      return;
    }
    for (const name of query.keys()) {
      if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase())) {
        context.addIssue({ code: "custom", path: ["upstreamTarget", "query"] });
        return;
      }
    }
  });
type StoredPlayback = z.infer<typeof storedPlaybackSchema>;

const storedPlaybackAssetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  target: playbackTargetSchema,
});
type StoredPlaybackAsset = z.infer<typeof storedPlaybackAssetSchema>;

interface PlaybackSourceRow {
  baseUrl: string;
  connectorConfigGeneration: number;
  connectorDisplayName: string;
  connectorEnabled: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  connectorType: string;
  deviceId: string;
  encryptedAccessToken: string;
  encryptedCredentials: string;
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

interface PlaybackSessionRow {
  encryptedPayload: string;
  expiresAt: number;
  id: string;
  lastReportedAt: number | null;
  linkRevision: number;
  mediaReferenceId: string;
  positionSeconds: number;
  revision: number;
  serviceIdentityLinkId: string;
  state: string;
  updatedAt: number;
  userId: string;
}

interface PlaybackAssetHandleRow {
  encryptedTarget: string;
  id: string;
  targetDigest: string;
}

interface PlaybackAssetHandleAllocation {
  globalCount: number;
  handlesByDigest: Map<string, string>;
  now: number;
  sessionCount: number;
}

type PlaybackProgressOperationState =
  "pending" | "reconcile_required" | "uncertain" | "succeeded" | "failed";

interface PlaybackProgressOperationRow {
  completedAt: number | null;
  connectorConfigGeneration: number;
  connectorId: string;
  connectorInstanceGeneration: number;
  failureCode: string | null;
  id: string;
  playbackSessionId: string;
  positionSeconds: number;
  sessionRevision: number;
  state: PlaybackProgressOperationState;
  updatedAt: number;
  userId: string;
}

interface PlaybackProgressEvidence {
  event: PlaybackProgressRequest["event"];
  playbackSessionId: string;
  positionSeconds: number;
  schemaVersion: 1;
  sessionRevision: number;
}

interface PlaybackProgressReservation {
  dispatch: ExternalMutationRecord;
  evidence: PlaybackProgressEvidence;
  leaseOwner: string | null;
  operation: PlaybackProgressOperationRow;
}

const PLAYBACK_PROGRESS_OPERATION_SELECT = `
  select id, playback_session_id as playbackSessionId,
    session_revision as sessionRevision, user_id as userId,
    connector_id as connectorId,
    connector_instance_generation as connectorInstanceGeneration,
    connector_config_generation as connectorConfigGeneration,
    position_seconds as positionSeconds, state, failure_code as failureCode,
    completed_at as completedAt, updated_at as updatedAt
  from playback_progress_operations`;

export interface PlaybackSessionContext {
  principal: SessionPrincipal;
}

export interface PlaybackClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

export interface PlaybackSessionDependencies {
  beforeProgressCompletion?: (state: "succeeded" | "uncertain") => void;
  clock?: () => Date;
  createAssetToken?: () => string;
  createClient?: (
    input: PlaybackClientFactoryInput,
  ) => Pick<
    JellyfinPlaybackClient,
    | "negotiate"
    | "readPlaybackTarget"
    | "readSubtitleStream"
    | "reportPlaybackEvent"
    | "resolvePlaybackTarget"
    | "streamPlaybackTarget"
  >;
  createToken?: () => string;
  mediaReferences?: MediaReferenceDependencies;
  playbackTransferLimits?: PlaybackTransferLimitOverrides;
}

export type PlaybackSessionErrorReason =
  "not_found" | "range_invalid" | "transition_invalid" | "unavailable";
export type PlaybackFailureStage =
  "connector_negotiation" | "session_payload_validation" | "session_persistence";

export class PlaybackSessionError extends Error {
  public readonly code = "playback_session_unavailable";
  public readonly reason: PlaybackSessionErrorReason;
  public readonly stage: PlaybackFailureStage | undefined;

  public constructor(
    reason: PlaybackSessionErrorReason,
    options?: ErrorOptions & { stage?: PlaybackFailureStage },
  ) {
    super(
      reason === "transition_invalid"
        ? "The playback session cannot accept that state transition."
        : reason === "range_invalid"
          ? "The requested media range is invalid."
          : reason === "not_found"
            ? "The playback session is no longer available."
            : "Playback is temporarily unavailable.",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "PlaybackSessionError";
    this.reason = reason;
    this.stage = options?.stage;
  }
}

class PlaybackConfigurationError extends Error {}

class PlaybackProgressPreDispatchError extends Error {
  public readonly failureCode: "connector_generation_changed";

  public constructor(failureCode: "connector_generation_changed") {
    super(failureCode);
    this.name = "PlaybackProgressPreDispatchError";
    this.failureCode = failureCode;
  }
}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function playbackContext(sessionId: string) {
  return `playback_session:jellyfin:${sessionId}`;
}

function playbackAssetContext(sessionId: string) {
  return `playback_asset:jellyfin:${sessionId}`;
}

function playbackAssetHandleContext(sessionId: string, handleId: string) {
  return `playback_asset_handle:jellyfin:${sessionId}:${handleId}`;
}

function validTime(now: Date) {
  const value = now.getTime();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new PlaybackSessionError("unavailable");
  }
  return value;
}

function accessToken(row: PlaybackSourceRow, cipher: EnvelopeCipher) {
  try {
    return cipher.decrypt(row.encryptedAccessToken, accessTokenContext(row.linkId));
  } catch (error) {
    throw new PlaybackConfigurationError("invalid", { cause: error });
  }
}

function connectorSecrets(row: PlaybackSourceRow, cipher: EnvelopeCipher) {
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
    throw new PlaybackConfigurationError("invalid", { cause: error });
  }
}

function defaultClient(input: PlaybackClientFactoryInput) {
  const { accessToken: token, deviceId, ...target } = input;
  return new JellyfinPlaybackClient({ accessToken: token, deviceId, target });
}

function selectedTrackIndex(tracks: readonly { index: number; selected: boolean }[]) {
  return tracks.find((track) => track.selected)?.index ?? null;
}

function storedPlayback(result: JellyfinPlaybackResult): StoredPlayback {
  return storedPlaybackSchema.parse({
    audioStreamIndex: selectedTrackIndex(result.audioTracks),
    durationSeconds: result.media.durationSeconds,
    itemId: result.itemId,
    liveStreamId: result.liveStreamId,
    mediaSourceId: result.mediaSourceId,
    playMethod: result.playMethod,
    playSessionId: result.playSessionId,
    schemaVersion: 2,
    subtitleStreamIndex: selectedTrackIndex(result.subtitleTracks),
    textSubtitleIndexes: result.subtitleTracks
      .filter((track) => isTextSubtitleCodec(track.codec) && track.delivery !== "hls")
      .map((track) => track.index),
    upstreamTarget: result.upstreamTarget,
  });
}

function nextState(current: PlaybackSessionRow["state"], event: PlaybackProgressRequest["event"]) {
  if (current === "stopped") throw new PlaybackSessionError("transition_invalid");
  if (event === "stopped") return "stopped" as const;
  if (event === "started" && ["negotiated", "paused", "playing"].includes(current)) {
    return "playing" as const;
  }
  if (event === "progress" && current === "playing") return "playing" as const;
  if (event === "paused" && current === "playing") return "paused" as const;
  throw new PlaybackSessionError("transition_invalid");
}

function publicState(state: string): PlaybackProgressResponse["state"] {
  if (state === "playing" || state === "paused" || state === "stopped") return state;
  throw new PlaybackSessionError("unavailable");
}

function publicPlayMethod(
  playMethod: JellyfinPlaybackResult["playMethod"],
): PlaybackNegotiationResponse["playMethod"] {
  return playMethod === "DirectPlay"
    ? "direct_play"
    : playMethod === "DirectStream"
      ? "direct_stream"
      : "transcode";
}

function parseRange(value: string | undefined) {
  if (value === undefined) return `bytes=0-${DIRECT_RANGE_BYTES - 1}`;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value.trim());
  if (!match?.[1]) throw new PlaybackSessionError("range_invalid");
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : start + DIRECT_RANGE_BYTES - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start
  ) {
    throw new PlaybackSessionError("range_invalid");
  }
  return `bytes=${start}-${Math.min(requestedEnd, start + DIRECT_RANGE_BYTES - 1)}`;
}

function contentType(headers: Headers, fallback: string) {
  const value = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)
    ? value
    : fallback;
}

function contentRange(headers: Headers) {
  const value = headers.get("content-range");
  return value && /^bytes (?:\d+-\d+|\*)\/\d+$/u.test(value) ? value : null;
}

function decodeManifest(body: Uint8Array) {
  if (body.byteLength > MAX_PLAYBACK_MANIFEST_BYTES) {
    throw new PlaybackSessionError("unavailable");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    throw new PlaybackSessionError("unavailable", { cause: error });
  }
  if (/[\u0000\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new PlaybackSessionError("unavailable");
  }
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines.length > MAX_MANIFEST_LINES || lines[0]?.trim() !== "#EXTM3U") {
    throw new PlaybackSessionError("unavailable");
  }
  return lines;
}

function enforceManifestReferenceLimit(lines: readonly string[]) {
  let references = 0;
  for (const line of lines) {
    const compacted = line.trim();
    if (!compacted || compacted === "#EXTM3U") continue;
    if (!compacted.startsWith("#")) {
      references += 1;
    } else {
      const remainder = line.replace(/URI="([^"\r\n]{1,16384})"/gu, () => {
        references += 1;
        if (references > MAX_PLAYBACK_MANIFEST_REFERENCES) {
          throw new PlaybackSessionError("unavailable");
        }
        return "";
      });
      if (/\bURI\s*=/iu.test(remainder)) throw new PlaybackSessionError("unavailable");
    }
    if (references > MAX_PLAYBACK_MANIFEST_REFERENCES) {
      throw new PlaybackSessionError("unavailable");
    }
  }
}

function isManifestTarget(target: JellyfinPlaybackTarget) {
  return target.path.toLowerCase().endsWith(".m3u8");
}

function leasedPlaybackStream(body: ReadableStream<Uint8Array>, release: () => void) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    release();
  };
  const releaseReader = () => {
    reader?.releaseLock();
    reader = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start() {
      try {
        reader = body.getReader();
      } catch (error) {
        finish();
        throw error;
      }
    },
    async pull(controller) {
      const activeReader = reader;
      if (!activeReader) {
        controller.close();
        return;
      }
      try {
        const result = await activeReader.read();
        if (result.done) {
          releaseReader();
          finish();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        releaseReader();
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        releaseReader();
        finish();
      }
    },
  });
}

export class PlaybackSessionService {
  readonly #beforeProgressCompletion:
    NonNullable<PlaybackSessionDependencies["beforeProgressCompletion"]> | undefined;
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAssetToken: () => string;
  readonly #createClient: NonNullable<PlaybackSessionDependencies["createClient"]>;
  readonly #createToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #journal: ExternalMutationJournal;
  readonly #transfers: PlaybackTransferLeaseManager;
  readonly #reportPipelineTails = new Map<string, Promise<void>>();
  readonly #references: MediaReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: PlaybackSessionDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#beforeProgressCompletion = dependencies.beforeProgressCompletion;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAssetToken = dependencies.createAssetToken ?? (() => randomToken(16));
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#createToken = dependencies.createToken ?? (() => randomToken(16));
    this.#journal = new ExternalMutationJournal(database.sqlite, config.encryptionKey);
    this.#transfers = new PlaybackTransferLeaseManager(dependencies.playbackTransferLimits);
    this.#references = new MediaReferenceService(database, config, {
      ...dependencies.mediaReferences,
      clock: dependencies.mediaReferences?.clock ?? this.#clock,
    });
  }

  public async negotiate(
    context: PlaybackSessionContext,
    mediaReferenceId: string,
    rawRequest: PlaybackNegotiationRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackNegotiationResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const request = playbackNegotiationRequestSchema.parse(rawRequest);
    const source = this.#source(principal);
    let reference;
    try {
      reference = this.#references.resolve(
        {
          linkId: source.linkId,
          linkRevision: source.linkRevision,
          userId: source.linkUserId,
        },
        mediaReferenceId,
      );
    } catch (error) {
      throw new PlaybackSessionError("not_found", { cause: error });
    }
    if (reference.kind !== "movie" && reference.kind !== "episode" && reference.kind !== "extra") {
      throw new PlaybackSessionError("not_found");
    }

    let result: JellyfinPlaybackResult;
    try {
      const { sourceReferenceId, ...connectorRequest } = request;
      const client = this.#client(source);
      const connectorInput = { ...connectorRequest, itemId: reference.itemId };
      result =
        sourceReferenceId === undefined || sourceReferenceId === null
          ? await client.negotiate(connectorInput, signal)
          : await client.negotiate(connectorInput, signal, {
              matchesSourceId: (sourceId) =>
                matchesPlaybackSourceReference(
                  this.#config.encryptionKey,
                  mediaReferenceId,
                  sourceReferenceId,
                  sourceId,
                ),
            });
    } catch (error) {
      if (error instanceof JellyfinPlaybackUnavailableError) {
        throw new PlaybackSessionError("unavailable", {
          cause: error,
          stage: "connector_negotiation",
        });
      }
      throw new PlaybackSessionError("unavailable", {
        cause: error,
        stage: "connector_negotiation",
      });
    }
    if (result.itemId !== reference.itemId) {
      throw new PlaybackSessionError("unavailable");
    }

    try {
      const session = this.#createSession(source, mediaReferenceId, result);
      return playbackNegotiationResponseSchema.parse({
        audioTracks: result.audioTracks,
        delivery: result.delivery,
        expiresAt: new Date(session.expiresAt).toISOString(),
        media: {
          ...result.media,
          streamBitrate: result.media.bitrate,
        },
        mediaReferenceId,
        playMethod: publicPlayMethod(result.playMethod),
        positionSeconds: result.positionSeconds,
        sessionId: session.id,
        ...(request.sourceReferenceId === undefined
          ? {}
          : { sourceReferenceId: request.sourceReferenceId }),
        streamPath: `/v1/playback/${session.id}/${result.delivery === "hls" ? "master.m3u8" : "stream"}`,
        subtitleTracks: result.subtitleTracks.map((track) => ({
          ...track,
          ...(isTextSubtitleCodec(track.codec) && track.delivery !== "hls"
            ? { subtitlePath: `/v1/playback/${session.id}/subtitle/${track.index}` }
            : {}),
        })),
      });
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  public async report(
    context: PlaybackSessionContext,
    sessionId: string,
    rawRequest: PlaybackProgressRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackProgressResponse> {
    const principal = requirePermission(context.principal, "media.view");
    playbackSessionIdSchema.parse(sessionId);
    const request = playbackProgressRequestSchema.parse(rawRequest);
    const source = this.#source(principal);
    return this.#enqueueReport(sessionId, async () => {
      const now = validTime(this.#clock());
      this.#cleanupPlaybackLifecycle(now);
      const session = this.#session(source, sessionId, now);
      const payload = this.#payload(session);
      const positionSeconds = Math.min(request.positionSeconds, payload.durationSeconds);
      const priorReplay = this.#priorProgressReplay(
        session,
        source,
        request.event,
        positionSeconds,
      );
      if (priorReplay) return priorReplay;
      const state = nextState(session.state, request.event);

      let reservation = this.#progressReservation(session, source, request.event, positionSeconds);
      if (!reservation) {
        reservation = this.#reserveProgress(session, source, request.event, positionSeconds, now);
      }

      if (reservation.dispatch.state === "succeeded") {
        return this.#completeProgress(context, session, state, reservation, "succeeded", null);
      }
      if (
        reservation.dispatch.state === "dispatched" ||
        reservation.dispatch.state === "reconcile_required" ||
        reservation.dispatch.state === "uncertain"
      ) {
        return this.#completeUncertainProgress(
          context,
          session,
          state,
          reservation,
          reservation.dispatch.failureCode ?? "interrupted_after_dispatch",
        );
      }
      if (reservation.dispatch.state === "failed") {
        throw new PlaybackSessionError("unavailable");
      }

      if (reservation.dispatch.leaseExpiresAt === null) {
        throw new PlaybackSessionError("unavailable");
      }
      if (reservation.dispatch.leaseExpiresAt < now) {
        reservation = this.#claimProgressReservation(reservation, now);
      } else if (reservation.leaseOwner === null) {
        throw new PlaybackSessionError("unavailable");
      }

      let client: ReturnType<NonNullable<PlaybackSessionDependencies["createClient"]>>;
      try {
        client = this.#client(source);
      } catch (error) {
        this.#failProgressBeforeDispatch(reservation, "connector_unavailable");
        throw new PlaybackSessionError("unavailable", { cause: error });
      }

      try {
        this.#markProgressDispatched(reservation, validTime(this.#clock()));
      } catch (error) {
        const dispatch = this.#journal.read(reservation.dispatch.id);
        if (
          dispatch?.state === "dispatched" ||
          dispatch?.state === "reconcile_required" ||
          dispatch?.state === "uncertain"
        ) {
          return this.#completeUncertainProgress(
            context,
            session,
            state,
            { ...reservation, dispatch },
            dispatch.failureCode ?? "dispatch_boundary_uncertain",
          );
        }
        this.#failProgressBeforeDispatch(
          reservation,
          error instanceof PlaybackProgressPreDispatchError
            ? error.failureCode
            : "dispatch_precondition_failed",
        );
        throw new PlaybackSessionError("unavailable", { cause: error });
      }

      try {
        await client.reportPlaybackEvent(
          {
            event: request.event,
            positionSeconds,
            session: {
              audioStreamIndex: payload.audioStreamIndex,
              itemId: payload.itemId,
              mediaSourceId: payload.mediaSourceId,
              playMethod: payload.playMethod,
              playSessionId: payload.playSessionId,
              subtitleStreamIndex: payload.subtitleStreamIndex,
            } satisfies JellyfinPlaybackReportingSession,
          },
          signal,
        );
      } catch (error) {
        try {
          return this.#completeUncertainProgress(
            context,
            session,
            state,
            { ...reservation, dispatch: this.#journal.read(reservation.dispatch.id)! },
            "upstream_outcome_uncertain",
          );
        } catch (completionError) {
          throw new PlaybackSessionError("unavailable", {
            cause: new AggregateError([error, completionError]),
          });
        }
      }

      try {
        return this.#completeProgress(
          context,
          session,
          state,
          { ...reservation, dispatch: this.#journal.read(reservation.dispatch.id)! },
          "succeeded",
          null,
        );
      } catch (error) {
        try {
          return this.#completeUncertainProgress(
            context,
            session,
            state,
            { ...reservation, dispatch: this.#journal.read(reservation.dispatch.id)! },
            "local_completion_failed",
          );
        } catch (completionError) {
          this.#terminalizeProgressUncertainty(reservation, "local_completion_failed");
          throw new PlaybackSessionError("unavailable", {
            cause: new AggregateError([error, completionError]),
          });
        }
      }
    });
  }

  public async readDirect(
    context: PlaybackSessionContext,
    sessionId: string,
    range: string | undefined,
    signal?: AbortSignal,
  ) {
    const { client, payload, userId } = this.#stream(context, sessionId, DIRECT_RANGE_BYTES);
    if (
      !["DirectPlay", "DirectStream"].includes(payload.playMethod) ||
      payload.upstreamTarget.path.endsWith(".m3u8")
    ) {
      throw new PlaybackSessionError("not_found");
    }
    const normalizedRange = parseRange(range);
    const release = this.#acquireTransfer(userId);
    let response: JellyfinPlaybackBytesResult;
    try {
      response = await client.readPlaybackTarget({
        accept: "video/*,audio/*,application/octet-stream",
        range: normalizedRange,
        ...(signal === undefined ? {} : { signal }),
        target: payload.upstreamTarget,
      });
      return {
        body: response.status === 416 ? new Uint8Array() : response.body,
        contentRange: contentRange(response.headers),
        contentType: contentType(response.headers, "application/octet-stream"),
        status: response.status === 206 ? 206 : response.status === 416 ? 416 : 200,
      } as const;
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", { cause: error });
    } finally {
      release();
    }
  }

  public async readManifest(
    context: PlaybackSessionContext,
    sessionId: string,
    signal?: AbortSignal,
  ) {
    const { client, payload, session, userId } = this.#stream(
      context,
      sessionId,
      MAX_PLAYBACK_MANIFEST_BYTES,
    );
    if (payload.playMethod !== "Transcode" || !isManifestTarget(payload.upstreamTarget)) {
      throw new PlaybackSessionError("not_found");
    }
    const release = this.#acquireTransfer(userId);
    try {
      return await this.#manifest(client, session, payload.upstreamTarget, "hls/", signal);
    } finally {
      release();
    }
  }

  public async readAsset(
    context: PlaybackSessionContext,
    sessionId: string,
    token: string,
    signal?: AbortSignal,
  ) {
    if (
      token.length > MAX_PLAYBACK_ASSET_TOKEN_LENGTH ||
      (!PLAYBACK_ASSET_HANDLE_PATTERN.test(token) && !LEGACY_PLAYBACK_ASSET_PATTERN.test(token))
    ) {
      throw new PlaybackSessionError("not_found");
    }
    const { client, now, payload, session, userId } = this.#stream(
      context,
      sessionId,
      MAX_PLAYBACK_MANIFEST_BYTES,
    );
    if (payload.playMethod !== "Transcode" || !isManifestTarget(payload.upstreamTarget)) {
      throw new PlaybackSessionError("not_found");
    }
    let target: JellyfinPlaybackTarget;
    try {
      target = PLAYBACK_ASSET_HANDLE_PATTERN.test(token)
        ? this.#assetHandleTarget(session, token, now)
        : storedPlaybackAssetSchema.parse(
            JSON.parse(
              this.#cipher.decrypt(token.slice("asset_".length), playbackAssetContext(session.id)),
            ),
          ).target;
    } catch (error) {
      throw new PlaybackSessionError("not_found", { cause: error });
    }
    if (isManifestTarget(target)) {
      const release = this.#acquireTransfer(userId);
      try {
        return await this.#manifest(client, session, target, "./", signal);
      } finally {
        release();
      }
    }

    const release = this.#acquireTransfer(userId);
    let response: JellyfinPlaybackStreamResult;
    try {
      response = await client.streamPlaybackTarget({
        accept: "video/*,audio/*,text/vtt,application/octet-stream",
        maxResponseBytes: HLS_ASSET_MAX_BYTES,
        ...(signal === undefined ? {} : { signal }),
        target,
      });
    } catch (error) {
      release();
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
    try {
      return {
        body: leasedPlaybackStream(response.body, release),
        contentType: contentType(response.headers, "application/octet-stream"),
        kind: "asset" as const,
        status: response.status === 206 ? 206 : 200,
      };
    } catch (error) {
      release();
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  public async readSubtitle(
    context: PlaybackSessionContext,
    sessionId: string,
    subtitleIndex: number,
    signal?: AbortSignal,
  ) {
    const specificIndexSchema = z.int().nonnegative().max(4_095);
    const index = specificIndexSchema.parse(subtitleIndex);
    const { client, payload, userId } = this.#stream(context, sessionId, SUBTITLE_MAX_BYTES);
    if (!payload.textSubtitleIndexes.includes(index)) {
      throw new PlaybackSessionError("not_found");
    }
    const release = this.#acquireTransfer(userId);
    let response: JellyfinPlaybackBytesResult;
    try {
      response = await client.readSubtitleStream({
        itemId: payload.itemId,
        mediaSourceId: payload.mediaSourceId,
        subtitleIndex: index,
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200 && response.status !== 206) {
        throw new PlaybackSessionError("unavailable");
      }
      return {
        body: response.body,
        contentType: contentType(response.headers, "text/vtt"),
        status: response.status === 206 ? 206 : 200,
      } as const;
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", { cause: error });
    } finally {
      release();
    }
  }

  #client(source: PlaybackSourceRow, maxResponseBytes?: number) {
    const tlsPolicy =
      source.tlsPolicy === "strict" || source.tlsPolicy === "allow_self_signed"
        ? source.tlsPolicy
        : undefined;
    if (!tlsPolicy) throw new PlaybackConfigurationError();
    try {
      return this.#createClient({
        accessToken: accessToken(source, this.#cipher),
        baseUrl: source.baseUrl,
        connectorId: source.connectorId,
        deviceId: source.deviceId,
        displayName: source.connectorDisplayName,
        insecureHttpApproved: source.insecureHttpApproved === 1,
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
        tlsPolicy,
        ...connectorSecrets(source, this.#cipher),
      });
    } catch (error) {
      throw new PlaybackConfigurationError("invalid", { cause: error });
    }
  }

  #payload(session: PlaybackSessionRow) {
    try {
      return storedPlaybackSchema.parse(
        JSON.parse(this.#cipher.decrypt(session.encryptedPayload, playbackContext(session.id))),
      );
    } catch (error) {
      throw new PlaybackSessionError("not_found", { cause: error });
    }
  }

  #priorProgressReplay(
    session: PlaybackSessionRow,
    source: PlaybackSourceRow,
    event: PlaybackProgressRequest["event"],
    positionSeconds: number,
  ) {
    if (session.revision === 0) return null;
    const operation = this.#progressOperation(session.id, session.revision - 1);
    if (!operation) return null;
    const reservation = this.#progressReservationFromOperation(operation, source);
    if (
      reservation.evidence.event !== event ||
      reservation.evidence.positionSeconds !== positionSeconds
    ) {
      return null;
    }
    if (
      (reservation.dispatch.state !== "succeeded" || operation.state !== "succeeded") &&
      (reservation.dispatch.state !== "uncertain" || operation.state !== "uncertain")
    ) {
      throw new PlaybackSessionError("unavailable");
    }
    if (operation.completedAt === null) throw new PlaybackSessionError("unavailable");
    return playbackProgressResponseSchema.parse({
      acceptedAt: new Date(operation.completedAt).toISOString(),
      positionSeconds: operation.positionSeconds,
      sessionId: operation.playbackSessionId,
      state: publicState(
        event === "paused" ? "paused" : event === "stopped" ? "stopped" : "playing",
      ),
    });
  }

  #progressReservation(
    session: PlaybackSessionRow,
    source: PlaybackSourceRow,
    event: PlaybackProgressRequest["event"],
    positionSeconds: number,
  ) {
    const operation = this.#progressOperation(session.id, session.revision);
    if (!operation) return null;
    const reservation = this.#progressReservationFromOperation(operation, source);
    if (
      reservation.evidence.event !== event ||
      reservation.evidence.positionSeconds !== positionSeconds
    ) {
      throw new PlaybackSessionError("transition_invalid");
    }
    return reservation;
  }

  #progressReservationFromOperation(
    operation: PlaybackProgressOperationRow,
    source: PlaybackSourceRow,
  ): PlaybackProgressReservation {
    try {
      const dispatch = this.#journal.replay({
        kind: "playback.progress",
        parentOperationId: operation.id,
        parentOperationType: "playback_progress_operation",
      });
      if (!dispatch) throw new Error("missing playback dispatch");
      const evidence = playbackProgressEvidenceSchema.parse(dispatch.normalizedRequest);
      if (
        operation.userId !== source.linkUserId ||
        operation.connectorId !== source.connectorId ||
        operation.connectorId !== dispatch.connectorId ||
        operation.connectorInstanceGeneration !== dispatch.connectorInstanceGeneration ||
        operation.connectorConfigGeneration !== dispatch.connectorConfigGeneration ||
        operation.playbackSessionId !== evidence.playbackSessionId ||
        operation.sessionRevision !== evidence.sessionRevision ||
        operation.positionSeconds !== evidence.positionSeconds ||
        operation.userId !== dispatch.userId ||
        dispatch.parentOperationId !== operation.id ||
        dispatch.parentOperationType !== "playback_progress_operation" ||
        dispatch.kind !== "playback.progress"
      ) {
        throw new Error("inconsistent playback dispatch");
      }
      return { dispatch, evidence, leaseOwner: null, operation };
    } catch (error) {
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  #reserveProgress(
    session: PlaybackSessionRow,
    source: PlaybackSourceRow,
    event: PlaybackProgressRequest["event"],
    positionSeconds: number,
    now: number,
  ): PlaybackProgressReservation {
    if (session.revision >= MAX_PLAYBACK_REVISION) {
      throw new PlaybackSessionError("unavailable");
    }
    const leaseExpiresAt = now + PLAYBACK_PROGRESS_LEASE_MS;
    if (leaseExpiresAt > 8_640_000_000_000_000) {
      throw new PlaybackSessionError("unavailable");
    }
    const operationId = this.#progressOperationId(session.id, session.revision);
    const dispatchId = this.#progressDispatchId(operationId);
    const leaseOwner = `playback-progress-${randomToken(16)}`;
    const evidence = playbackProgressEvidenceSchema.parse({
      event,
      playbackSessionId: session.id,
      positionSeconds,
      schemaVersion: 1,
      sessionRevision: session.revision,
    });
    try {
      const dispatch = this.#database.sqlite
        .transaction(() => {
          const targetDigest = this.#progressTargetDigest(session.id, session.revision);
          this.#database.sqlite
            .prepare(
              `insert into playback_progress_operations (
                 id, playback_session_id, session_revision, user_id, connector_id,
                 connector_instance_generation, connector_config_generation,
                 position_seconds, state, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
              operationId,
              session.id,
              session.revision,
              source.linkUserId,
              source.connectorId,
              source.connectorInstanceGeneration,
              source.connectorConfigGeneration,
              positionSeconds,
              now,
              now,
            );
          return this.#journal.reserve({
            connectorConfigGeneration: source.connectorConfigGeneration,
            connectorId: source.connectorId,
            connectorInstanceGeneration: source.connectorInstanceGeneration,
            id: dispatchId,
            kind: "playback.progress",
            leaseExpiresAt,
            leaseOwner,
            normalizedRequest: evidence,
            now,
            parentOperationId: operationId,
            parentOperationType: "playback_progress_operation",
            targetDigest,
            userId: source.linkUserId,
          });
        })
        .immediate();
      const operation = this.#progressOperation(session.id, session.revision);
      if (!operation) throw new Error("missing playback progress operation");
      return { dispatch, evidence, leaseOwner, operation };
    } catch (error) {
      if (
        error instanceof ExternalMutationJournalError &&
        (error.code === "reservation_conflict" || error.code === "target_locked")
      ) {
        const existing = this.#progressReservation(session, source, event, positionSeconds);
        if (existing) return existing;
      }
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  #claimProgressReservation(
    reservation: PlaybackProgressReservation,
    now: number,
  ): PlaybackProgressReservation {
    const expectedLeaseOwner = reservation.dispatch.leaseOwner;
    const expectedLeaseExpiresAt = reservation.dispatch.leaseExpiresAt;
    if (expectedLeaseOwner === null || expectedLeaseExpiresAt === null) {
      throw new PlaybackSessionError("unavailable");
    }
    const leaseExpiresAt = now + PLAYBACK_PROGRESS_LEASE_MS;
    if (leaseExpiresAt > 8_640_000_000_000_000) {
      throw new PlaybackSessionError("unavailable");
    }
    const leaseOwner = `playback-progress-${randomToken(16)}`;
    try {
      const dispatch = this.#journal.claimStaleReserved({
        expectedLeaseExpiresAt,
        expectedLeaseOwner,
        id: reservation.dispatch.id,
        leaseExpiresAt,
        leaseOwner,
        now,
      });
      return { ...reservation, dispatch, leaseOwner };
    } catch (error) {
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  #markProgressDispatched(reservation: PlaybackProgressReservation, now: number) {
    if (reservation.leaseOwner === null) throw new PlaybackSessionError("unavailable");
    const leaseOwner = reservation.leaseOwner;
    this.#database.sqlite
      .transaction(() => {
        const generation = this.#database.sqlite
          .prepare(
            `select instance_generation as instanceGeneration,
                    config_generation as configGeneration
             from connector_configs
             where id = ? and type = 'jellyfin' and enabled = 1`,
          )
          .get(reservation.operation.connectorId) as
          { configGeneration: number; instanceGeneration: number } | undefined;
        if (
          !generation ||
          generation.instanceGeneration !== reservation.operation.connectorInstanceGeneration ||
          generation.configGeneration !== reservation.operation.connectorConfigGeneration
        ) {
          throw new PlaybackProgressPreDispatchError("connector_generation_changed");
        }
        this.#journal.markDispatched({
          id: reservation.dispatch.id,
          leaseOwner,
          now,
        });
      })
      .immediate();
  }

  #failProgressBeforeDispatch(
    reservation: PlaybackProgressReservation,
    failureCode:
      "connector_generation_changed" | "connector_unavailable" | "dispatch_precondition_failed",
  ) {
    try {
      const now = validTime(this.#clock());
      this.#database.sqlite
        .transaction(() => {
          const dispatch = this.#journal.read(reservation.dispatch.id);
          if (dispatch?.state === "reserved") {
            this.#journal.completeFailed({ failureCode, id: dispatch.id, now });
          }
          this.#database.sqlite
            .prepare(
              `update playback_progress_operations
               set state = 'failed', failure_code = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(failureCode, now, now, reservation.operation.id);
        })
        .immediate();
    } catch {
      // A durable reservation still prevents an unsafe duplicate dispatch.
    }
  }

  #completeProgress(
    context: PlaybackSessionContext,
    session: PlaybackSessionRow,
    state: "playing" | "paused" | "stopped",
    reservation: PlaybackProgressReservation,
    outcome: "succeeded" | "uncertain",
    failureCode: string | null,
  ) {
    const now = validTime(this.#clock());
    const expiresAt =
      state === "stopped"
        ? Math.min(session.expiresAt, now + STOPPED_SESSION_TTL_MS)
        : session.expiresAt;
    this.#database.sqlite
      .transaction(() => {
        this.#beforeProgressCompletion?.(outcome);
        const dispatch = this.#journal.read(reservation.dispatch.id);
        if (!dispatch) throw new PlaybackSessionError("unavailable");
        if (outcome === "succeeded") {
          if (dispatch.state === "dispatched" || dispatch.state === "reconcile_required") {
            this.#journal.completeSucceeded({ id: dispatch.id, now });
          } else if (dispatch.state !== "succeeded") {
            throw new PlaybackSessionError("unavailable");
          }
        } else {
          if (!failureCode) throw new PlaybackSessionError("unavailable");
          if (dispatch.state === "dispatched" || dispatch.state === "reconcile_required") {
            this.#journal.completeUncertain({ failureCode, id: dispatch.id, now });
          } else if (dispatch.state !== "uncertain") {
            throw new PlaybackSessionError("unavailable");
          }
        }

        const operationUpdate = this.#database.sqlite
          .prepare(
            `update playback_progress_operations
             set state = ?, failure_code = ?, completed_at = ?, updated_at = ?
             where id = ? and state = 'pending'`,
          )
          .run(outcome, failureCode, now, now, reservation.operation.id);
        if (operationUpdate.changes !== 1) {
          const operation = this.#progressOperation(
            reservation.operation.playbackSessionId,
            reservation.operation.sessionRevision,
          );
          if (!operation || operation.state !== outcome || operation.failureCode !== failureCode) {
            throw new PlaybackSessionError("unavailable");
          }
        }

        const current = this.#database.sqlite
          .prepare(
            `select state, position_seconds as positionSeconds, revision
             from playback_sessions where id = ? and user_id = ?`,
          )
          .get(session.id, reservation.operation.userId) as
          { positionSeconds: number; revision: number; state: string } | undefined;
        if (!current) throw new PlaybackSessionError("not_found");
        if (current.revision === session.revision) {
          const updated = this.#database.sqlite
            .prepare(
              `update playback_sessions
               set state = ?, position_seconds = ?, revision = revision + 1,
                   last_reported_at = ?, expires_at = ?, updated_at = ?
               where id = ? and user_id = ? and revision = ? and state = ?`,
            )
            .run(
              state,
              reservation.operation.positionSeconds,
              now,
              expiresAt,
              now,
              session.id,
              reservation.operation.userId,
              session.revision,
              session.state,
            );
          if (updated.changes !== 1) throw new PlaybackSessionError("transition_invalid");
        } else if (
          current.revision !== session.revision + 1 ||
          current.state !== state ||
          current.positionSeconds !== reservation.operation.positionSeconds
        ) {
          throw new PlaybackSessionError("transition_invalid");
        }
        if (state === "stopped") {
          this.#database.sqlite
            .prepare("delete from playback_asset_handles where playback_session_id = ?")
            .run(session.id);
        }
        if (outcome === "uncertain") {
          this.#auditProgressUncertainty(context, reservation, failureCode!, now);
        }
      })
      .immediate();
    return playbackProgressResponseSchema.parse({
      acceptedAt: new Date(now).toISOString(),
      positionSeconds: reservation.operation.positionSeconds,
      sessionId: session.id,
      state: publicState(state),
    });
  }

  #completeUncertainProgress(
    context: PlaybackSessionContext,
    session: PlaybackSessionRow,
    state: "playing" | "paused" | "stopped",
    reservation: PlaybackProgressReservation,
    failureCode: string,
  ) {
    try {
      return this.#completeProgress(context, session, state, reservation, "uncertain", failureCode);
    } catch (error) {
      this.#terminalizeProgressUncertainty(reservation, failureCode);
      throw error;
    }
  }

  #terminalizeProgressUncertainty(reservation: PlaybackProgressReservation, failureCode: string) {
    try {
      const now = validTime(this.#clock());
      this.#database.sqlite
        .transaction(() => {
          const dispatch = this.#journal.read(reservation.dispatch.id);
          if (dispatch?.state === "dispatched" || dispatch?.state === "reconcile_required") {
            this.#journal.completeUncertain({ failureCode, id: dispatch.id, now });
          }
          this.#database.sqlite
            .prepare(
              `update playback_progress_operations
               set state = 'uncertain', failure_code = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(failureCode, now, now, reservation.operation.id);
        })
        .immediate();
    } catch {
      // The dispatched journal row remains nonredispatchable even if completion storage is impaired.
    }
  }

  #auditProgressUncertainty(
    context: PlaybackSessionContext,
    reservation: PlaybackProgressReservation,
    failureCode: string,
    now: number,
  ) {
    const auditId = `audit_${hashToken(
      `playback-progress-uncertain\0${reservation.operation.id}`,
    ).slice(0, 22)}`;
    this.#database.sqlite
      .prepare(
        `insert or ignore into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method,
           event_type, outcome, target_type, target_id, request_id,
           metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, 'playback.progress.delivery_uncertain', 'failure',
           'playback_session', ?, null, ?, null, ?)`,
      )
      .run(
        auditId,
        reservation.operation.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        reservation.operation.playbackSessionId,
        JSON.stringify({
          event: reservation.evidence.event,
          failureCode,
          locallyAccepted: true,
          sessionRevision: reservation.operation.sessionRevision,
        }),
        now,
      );
  }

  #progressOperation(sessionId: string, revision: number) {
    return this.#database.sqlite
      .prepare(
        `${PLAYBACK_PROGRESS_OPERATION_SELECT}
         where playback_session_id = ? and session_revision = ?`,
      )
      .get(sessionId, revision) as PlaybackProgressOperationRow | undefined;
  }

  #progressOperationId(sessionId: string, revision: number) {
    return `playback_progress_operation_${hashToken(
      `playback-progress-operation\0${sessionId}\0${revision}`,
    ).slice(0, 22)}`;
  }

  #progressDispatchId(operationId: string) {
    return `mutation_dispatch_${hashToken(`playback-progress-dispatch\0${operationId}`).slice(0, 22)}`;
  }

  #progressTargetDigest(sessionId: string, revision: number) {
    return hashToken(`playback-progress-target\0${sessionId}\0${revision}`).slice(0, 22);
  }

  async #enqueueReport<T>(sessionId: string, report: () => Promise<T>) {
    const predecessor = this.#reportPipelineTails.get(sessionId) ?? Promise.resolve();
    const operation = predecessor.then(report);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#reportPipelineTails.set(sessionId, tail);
    try {
      return await operation;
    } finally {
      if (this.#reportPipelineTails.get(sessionId) === tail) {
        this.#reportPipelineTails.delete(sessionId);
      }
    }
  }

  #stream(context: PlaybackSessionContext, sessionId: string, maxResponseBytes: number) {
    const principal = requirePermission(context.principal, "media.view");
    playbackSessionIdSchema.parse(sessionId);
    const source = this.#source(principal);
    const now = validTime(this.#clock());
    const session = this.#session(source, sessionId, now);
    if (session.state === "stopped") throw new PlaybackSessionError("not_found");
    return {
      client: this.#client(source, maxResponseBytes),
      now,
      payload: this.#payload(session),
      session,
      userId: source.linkUserId,
    };
  }

  #acquireTransfer(userId: string) {
    const releaseLease = this.#transfers.acquire(userId);
    if (!releaseLease) throw new PlaybackSessionError("unavailable");
    return releaseLease;
  }

  async #manifest(
    client: Pick<JellyfinPlaybackClient, "readPlaybackTarget" | "resolvePlaybackTarget">,
    session: PlaybackSessionRow,
    target: JellyfinPlaybackTarget,
    assetPathPrefix: PlaybackAssetPathPrefix,
    signal?: AbortSignal,
  ) {
    let response: JellyfinPlaybackBytesResult;
    try {
      response = await client.readPlaybackTarget({
        accept: "application/vnd.apple.mpegurl,application/x-mpegURL,audio/mpegurl",
        ...(signal === undefined ? {} : { signal }),
        target,
      });
    } catch (error) {
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
    if (response.status !== 200) throw new PlaybackSessionError("unavailable");
    const lines = decodeManifest(response.body);
    enforceManifestReferenceLimit(lines);
    let rewritten: string[];
    try {
      rewritten = this.#database.sqlite
        .transaction(() => {
          const allocation = this.#assetHandleAllocation(session);
          return lines.map((line) =>
            this.#rewriteManifestLine(client, session, target, assetPathPrefix, line, allocation),
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
    return {
      body: `${rewritten.join("\n").replace(/\n+$/u, "")}\n`,
      contentType: "application/vnd.apple.mpegurl" as const,
      kind: "manifest" as const,
      status: 200 as const,
    };
  }

  #rewriteManifestLine(
    client: Pick<JellyfinPlaybackClient, "resolvePlaybackTarget">,
    session: PlaybackSessionRow,
    parent: JellyfinPlaybackTarget,
    assetPathPrefix: PlaybackAssetPathPrefix,
    line: string,
    allocation: PlaybackAssetHandleAllocation,
  ) {
    const compacted = line.trim();
    if (!compacted || compacted === "#EXTM3U") return line;
    if (!compacted.startsWith("#")) {
      return this.#assetPath(client, session, parent, assetPathPrefix, compacted, allocation);
    }

    let replacements = 0;
    const rewritten = line.replace(/URI="([^"\r\n]{1,16384})"/gu, (_match, uri: string) => {
      replacements += 1;
      return `URI="${this.#assetPath(client, session, parent, assetPathPrefix, uri, allocation)}"`;
    });
    if (/\bURI\s*=/iu.test(line) && replacements === 0) {
      throw new PlaybackSessionError("unavailable");
    }
    return rewritten;
  }

  #assetPath(
    client: Pick<JellyfinPlaybackClient, "resolvePlaybackTarget">,
    session: PlaybackSessionRow,
    parent: JellyfinPlaybackTarget,
    assetPathPrefix: PlaybackAssetPathPrefix,
    uri: string,
    allocation: PlaybackAssetHandleAllocation,
  ) {
    let target: JellyfinPlaybackTarget;
    try {
      target = client.resolvePlaybackTarget(parent, uri);
    } catch (error) {
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
    return `${assetPathPrefix}${this.#assetHandle(session, target, allocation)}`;
  }

  #assetHandleAllocation(session: PlaybackSessionRow): PlaybackAssetHandleAllocation {
    const now = validTime(this.#clock());
    if (session.expiresAt <= now || session.state === "stopped") {
      throw new PlaybackSessionError("not_found");
    }
    this.#cleanupPlaybackLifecycle(now);
    const sessionCount = this.#database.sqlite
      .prepare("select count(*) as count from playback_asset_handles where playback_session_id = ?")
      .get(session.id) as { count: number };
    const globalCount = this.#database.sqlite
      .prepare("select count(*) as count from playback_asset_handles")
      .get() as { count: number };
    return {
      globalCount: globalCount.count,
      handlesByDigest: new Map(),
      now,
      sessionCount: sessionCount.count,
    };
  }

  #assetHandle(
    session: PlaybackSessionRow,
    target: JellyfinPlaybackTarget,
    allocation: PlaybackAssetHandleAllocation,
  ) {
    const stored = storedPlaybackAssetSchema.parse({ schemaVersion: 1, target });
    const encoded = JSON.stringify(stored);
    const targetDigest = privacyHash(
      "playback_asset",
      `${session.id}\u0000${encoded}`,
      this.#config.encryptionKey,
    );
    const allocated = allocation.handlesByDigest.get(targetDigest);
    if (allocated) return allocated;

    try {
      const existing = this.#database.sqlite
        .prepare(
          `select id, target_digest as targetDigest, encrypted_target as encryptedTarget
           from playback_asset_handles
           where playback_session_id = ? and target_digest = ? and expires_at > ?`,
        )
        .get(session.id, targetDigest, allocation.now) as PlaybackAssetHandleRow | undefined;
      if (existing) {
        this.#assertAssetHandleTarget(session.id, existing, stored);
        this.#touchAssetHandle(existing.id, allocation.now);
        allocation.handlesByDigest.set(targetDigest, existing.id);
        return existing.id;
      }

      if (allocation.sessionCount >= MAX_PLAYBACK_ASSET_HANDLES_PER_SESSION) {
        throw new PlaybackSessionError("unavailable");
      }
      if (allocation.globalCount >= MAX_PLAYBACK_ASSET_HANDLES_GLOBAL) {
        throw new PlaybackSessionError("unavailable");
      }

      for (let attempt = 0; attempt < MAX_CREATION_ATTEMPTS; attempt += 1) {
        const handleId = `asset_h1.${this.#createAssetToken()}`;
        if (!PLAYBACK_ASSET_HANDLE_PATTERN.test(handleId)) {
          throw new PlaybackSessionError("unavailable");
        }
        try {
          this.#database.sqlite
            .prepare(
              `insert into playback_asset_handles (
                id, playback_session_id, target_digest, encrypted_target,
                expires_at, last_used_at, created_at, updated_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              handleId,
              session.id,
              targetDigest,
              this.#cipher.encrypt(encoded, playbackAssetHandleContext(session.id, handleId)),
              session.expiresAt,
              allocation.now,
              allocation.now,
              allocation.now,
            );
          allocation.globalCount += 1;
          allocation.sessionCount += 1;
          allocation.handlesByDigest.set(targetDigest, handleId);
          return handleId;
        } catch (error) {
          const concurrent = this.#database.sqlite
            .prepare(
              `select id, target_digest as targetDigest, encrypted_target as encryptedTarget
               from playback_asset_handles
               where playback_session_id = ? and target_digest = ? and expires_at > ?`,
            )
            .get(session.id, targetDigest, allocation.now) as PlaybackAssetHandleRow | undefined;
          if (concurrent) {
            this.#assertAssetHandleTarget(session.id, concurrent, stored);
            this.#touchAssetHandle(concurrent.id, allocation.now);
            allocation.handlesByDigest.set(targetDigest, concurrent.id);
            return concurrent.id;
          }
          const collision = this.#database.sqlite
            .prepare("select 1 from playback_asset_handles where id = ?")
            .get(handleId);
          if (!collision) throw error;
        }
      }
      throw new PlaybackSessionError("unavailable");
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  #assetHandleTarget(session: PlaybackSessionRow, handleId: string, now: number) {
    try {
      const row = this.#database.sqlite
        .prepare(
          `select id, target_digest as targetDigest, encrypted_target as encryptedTarget
           from playback_asset_handles
           where id = ? and playback_session_id = ? and expires_at > ?`,
        )
        .get(handleId, session.id, now) as PlaybackAssetHandleRow | undefined;
      if (!row) throw new PlaybackSessionError("not_found");
      const stored = this.#storedAssetHandleTarget(session.id, row);
      const encoded = JSON.stringify(stored);
      const expectedDigest = privacyHash(
        "playback_asset",
        `${session.id}\u0000${encoded}`,
        this.#config.encryptionKey,
      );
      if (!constantTimeTextEqual(expectedDigest, row.targetDigest)) {
        throw new PlaybackSessionError("not_found");
      }
      return stored.target;
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("not_found", { cause: error });
    }
  }

  #assertAssetHandleTarget(
    sessionId: string,
    row: PlaybackAssetHandleRow,
    expected: StoredPlaybackAsset,
  ) {
    const stored = this.#storedAssetHandleTarget(sessionId, row);
    if (JSON.stringify(stored) !== JSON.stringify(expected)) {
      throw new PlaybackSessionError("unavailable");
    }
  }

  #storedAssetHandleTarget(sessionId: string, row: PlaybackAssetHandleRow) {
    return storedPlaybackAssetSchema.parse(
      JSON.parse(
        this.#cipher.decrypt(row.encryptedTarget, playbackAssetHandleContext(sessionId, row.id)),
      ),
    );
  }

  #touchAssetHandle(handleId: string, now: number) {
    const updated = this.#database.sqlite
      .prepare(
        `update playback_asset_handles
         set last_used_at = ?, updated_at = ?
         where id = ? and expires_at > ?`,
      )
      .run(now, now, handleId, now);
    if (updated.changes !== 1) throw new PlaybackSessionError("not_found");
  }

  #createSession(
    source: PlaybackSourceRow,
    mediaReferenceId: string,
    result: JellyfinPlaybackResult,
  ) {
    const now = validTime(this.#clock());
    const expiresAt = now + PLAYBACK_SESSION_TTL_MS;
    let payload: StoredPlayback;
    try {
      payload = storedPlayback(result);
    } catch (error) {
      throw new PlaybackSessionError("unavailable", {
        cause: error,
        stage: "session_payload_validation",
      });
    }
    try {
      return this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare(
              `update playback_sessions
               set expires_at = min(expires_at, ?), updated_at = max(updated_at, ?)
               where user_id = ?
                 and (service_identity_link_id <> ? or link_revision <> ?)`,
            )
            .run(now, now, source.linkUserId, source.linkId, source.linkRevision);
          this.#cleanupPlaybackLifecycle(now);
          let id: string | null = null;
          for (let attempt = 0; attempt < MAX_CREATION_ATTEMPTS; attempt += 1) {
            const candidate = `playback_${this.#createToken()}`;
            if (!playbackSessionIdSchema.safeParse(candidate).success) {
              throw new PlaybackSessionError("unavailable");
            }
            try {
              this.#database.sqlite
                .prepare(
                  `insert into playback_sessions (
                    id, user_id, service_identity_link_id, link_revision, media_reference_id,
                    encrypted_payload, state, position_seconds, revision, last_reported_at,
                    expires_at, created_at, updated_at
                  ) values (?, ?, ?, ?, ?, ?, 'negotiated', ?, 0, null, ?, ?, ?)`,
                )
                .run(
                  candidate,
                  source.linkUserId,
                  source.linkId,
                  source.linkRevision,
                  mediaReferenceId,
                  this.#cipher.encrypt(JSON.stringify(payload), playbackContext(candidate)),
                  result.positionSeconds,
                  expiresAt,
                  now,
                  now,
                );
              id = candidate;
              break;
            } catch (error) {
              const collision = this.#database.sqlite
                .prepare("select 1 from playback_sessions where id = ?")
                .get(candidate);
              if (!collision) throw error;
            }
          }
          if (!id) throw new PlaybackSessionError("unavailable");
          this.#enforceUserLimit(source.linkUserId, id);
          return { expiresAt, id };
        })
        .immediate();
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", {
        cause: error,
        stage: "session_persistence",
      });
    }
  }

  #enforceUserLimit(userId: string, protectedId: string) {
    const now = validTime(this.#clock());
    const row = this.#database.sqlite
      .prepare(
        "select count(*) as count from playback_sessions where user_id = ? and expires_at > ?",
      )
      .get(userId, now) as { count: number };
    if (row.count <= MAX_PLAYBACK_SESSIONS_PER_USER) return;
    this.#database.sqlite
      .prepare(
        `update playback_sessions set expires_at = min(expires_at, ?), updated_at = max(updated_at, ?)
         where id in (
           select id from playback_sessions
           where user_id = ? and id <> ? and expires_at > ?
           order by case when state = 'stopped' then 0 else 1 end, updated_at asc, id asc
           limit ?
         )`,
      )
      .run(now, now, userId, protectedId, now, row.count - MAX_PLAYBACK_SESSIONS_PER_USER);
    this.#cleanupPlaybackLifecycle(now);
    const remaining = this.#database.sqlite
      .prepare(
        "select count(*) as count from playback_sessions where user_id = ? and expires_at > ?",
      )
      .get(userId, now) as { count: number };
    if (remaining.count > MAX_PLAYBACK_SESSIONS_PER_USER) {
      throw new PlaybackSessionError("unavailable");
    }
  }

  #cleanupPlaybackLifecycle(now: number) {
    const terminalIds = this.#database.sqlite
      .prepare(
        `select operation.id
         from playback_progress_operations operation
         left join playback_sessions session on session.id = operation.playback_session_id
         where operation.state in ('succeeded', 'failed')
           and (
             session.id is null
             or session.expires_at <= ?
             or operation.session_revision < max(0, session.revision - 1)
           )
         order by operation.completed_at asc, operation.id asc
         limit ?`,
      )
      .all(now, PLAYBACK_LIFECYCLE_BATCH_SIZE) as Array<{ id: string }>;
    if (terminalIds.length > 0) {
      const cleanup = this.#journal.cleanupTerminalParents({
        completedBefore: now,
        limit: PLAYBACK_LIFECYCLE_BATCH_SIZE,
        parentIds: terminalIds.map(({ id }) => id),
        parentOperationType: "playback_progress_operation",
      });
      if (cleanup.mismatchedParents > 0) throw new PlaybackSessionError("unavailable");
    }
    this.#database.sqlite
      .prepare(
        `delete from playback_sessions where id in (
           select session.id from playback_sessions session
           where session.expires_at <= ?
             and not exists (
               select 1 from playback_progress_operations operation
               where operation.playback_session_id = session.id
             )
           order by session.expires_at asc, session.id asc
           limit ?
         )`,
      )
      .run(now, PLAYBACK_LIFECYCLE_BATCH_SIZE);
  }

  #session(source: PlaybackSourceRow, sessionId: string, now: number) {
    try {
      const row = this.#database.sqlite
        .prepare(
          `select
            id,
            user_id as userId,
            service_identity_link_id as serviceIdentityLinkId,
            link_revision as linkRevision,
            media_reference_id as mediaReferenceId,
            encrypted_payload as encryptedPayload,
            state,
            position_seconds as positionSeconds,
            revision,
            last_reported_at as lastReportedAt,
            expires_at as expiresAt,
            updated_at as updatedAt
           from playback_sessions
           where id = ? and user_id = ? and service_identity_link_id = ?
             and link_revision = ? and expires_at > ?`,
        )
        .get(sessionId, source.linkUserId, source.linkId, source.linkRevision, now) as
        PlaybackSessionRow | undefined;
      if (
        !row ||
        !playbackSessionIdSchema.safeParse(row.id).success ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        row.revision > 2_147_483_647
      ) {
        throw new PlaybackSessionError("not_found");
      }
      return row;
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("not_found", { cause: error });
    }
  }

  #source(principal: SessionPrincipal) {
    const userId = principal.userId;
    const linkedService = principal.linkedServices.find(({ service }) => service === "jellyfin");
    if (!userId || !linkedService) throw new PlaybackSessionError("not_found");
    const row = this.#database.sqlite
      .prepare(
        `select
          l.id as linkId,
          l.user_id as linkUserId,
          l.service as linkService,
          l.device_id as deviceId,
          l.encrypted_access_token as encryptedAccessToken,
          l.health_state as linkHealthState,
          l.revision as linkRevision,
          c.id as connectorId,
          c.type as connectorType,
          c.display_name as connectorDisplayName,
          c.base_url as baseUrl,
          c.instance_generation as connectorInstanceGeneration,
          c.config_generation as connectorConfigGeneration,
          c.encrypted_credentials as encryptedCredentials,
          c.tls_policy as tlsPolicy,
          c.insecure_http_approved as insecureHttpApproved,
          c.enabled as connectorEnabled
         from service_identity_links l
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.id = ? and l.user_id = ?`,
      )
      .get(linkedService.id, userId) as PlaybackSourceRow | undefined;
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
      !Number.isSafeInteger(row.linkRevision) ||
      row.linkRevision < 0 ||
      !Number.isSafeInteger(row.connectorInstanceGeneration) ||
      row.connectorInstanceGeneration < 0 ||
      !Number.isSafeInteger(row.connectorConfigGeneration) ||
      row.connectorConfigGeneration < 0 ||
      (row.insecureHttpApproved !== 0 && row.insecureHttpApproved !== 1)
    ) {
      throw new PlaybackSessionError("not_found");
    }
    return row;
  }
}
