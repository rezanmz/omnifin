import {
  JellyfinPlaybackClient,
  JellyfinPlaybackUnavailableError,
  type JellyfinPlaybackResult,
  type JellyfinPlaybackReportingSession,
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
import { EnvelopeCipher, randomToken } from "../security/crypto.js";
import {
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "./media-reference-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PLAYBACK_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const STOPPED_SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_PLAYBACK_SESSIONS_PER_USER = 32;
const MAX_CREATION_ATTEMPTS = 8;
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
const storedPlaybackSchema = z
  .strictObject({
    audioStreamIndex: z.int().nonnegative().max(4_095).nullable(),
    durationSeconds: z.int().positive().max(10_000_000),
    itemId: identifierSchema,
    liveStreamId: identifierSchema.nullable(),
    mediaSourceId: identifierSchema,
    playMethod: z.enum(["DirectPlay", "Transcode"]),
    playSessionId: identifierSchema,
    schemaVersion: z.literal(1),
    subtitleStreamIndex: z.int().nonnegative().max(4_095).nullable(),
    upstreamTarget: z.strictObject({
      path: z
        .string()
        .regex(/^Videos\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\/(?:master\.m3u8|stream)$/iu),
      query: z.string().max(32_768),
    }),
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

interface PlaybackSourceRow {
  baseUrl: string;
  connectorDisplayName: string;
  connectorEnabled: number;
  connectorId: string;
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

export interface PlaybackSessionContext {
  principal: SessionPrincipal;
}

export interface PlaybackClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

export interface PlaybackSessionDependencies {
  clock?: () => Date;
  createClient?: (
    input: PlaybackClientFactoryInput,
  ) => Pick<JellyfinPlaybackClient, "negotiate" | "reportPlaybackEvent">;
  createToken?: () => string;
  mediaReferences?: MediaReferenceDependencies;
}

export type PlaybackSessionErrorReason = "not_found" | "transition_invalid" | "unavailable";

export class PlaybackSessionError extends Error {
  public readonly code = "playback_session_unavailable";
  public readonly reason: PlaybackSessionErrorReason;

  public constructor(reason: PlaybackSessionErrorReason, options?: ErrorOptions) {
    super(
      reason === "transition_invalid"
        ? "The playback session cannot accept that state transition."
        : reason === "not_found"
          ? "The playback session is no longer available."
          : "Playback is temporarily unavailable.",
      options,
    );
    this.name = "PlaybackSessionError";
    this.reason = reason;
  }
}

class PlaybackConfigurationError extends Error {}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function playbackContext(sessionId: string) {
  return `playback_session:jellyfin:${sessionId}`;
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
    schemaVersion: 1,
    subtitleStreamIndex: selectedTrackIndex(result.subtitleTracks),
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

export class PlaybackSessionService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createClient: NonNullable<PlaybackSessionDependencies["createClient"]>;
  readonly #createToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #references: MediaReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: PlaybackSessionDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#createToken = dependencies.createToken ?? (() => randomToken(16));
    this.#references = new MediaReferenceService(database, config, dependencies.mediaReferences);
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

    let result: JellyfinPlaybackResult;
    try {
      result = await this.#client(source).negotiate(
        { ...request, itemId: reference.itemId },
        signal,
      );
    } catch (error) {
      if (error instanceof JellyfinPlaybackUnavailableError) {
        throw new PlaybackSessionError("unavailable", { cause: error });
      }
      throw new PlaybackSessionError("unavailable", { cause: error });
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
        media: result.media,
        mediaReferenceId,
        positionSeconds: result.positionSeconds,
        sessionId: session.id,
        streamPath: `/v1/playback/${session.id}/${result.delivery === "hls" ? "master.m3u8" : "stream"}`,
        subtitleTracks: result.subtitleTracks,
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
    const now = validTime(this.#clock());
    const session = this.#session(source, sessionId, now);
    const state = nextState(session.state, request.event);
    let payload: StoredPlayback;
    try {
      payload = storedPlaybackSchema.parse(
        JSON.parse(this.#cipher.decrypt(session.encryptedPayload, playbackContext(session.id))),
      );
    } catch (error) {
      throw new PlaybackSessionError("not_found", { cause: error });
    }
    const positionSeconds = Math.min(request.positionSeconds, payload.durationSeconds);
    try {
      await this.#client(source).reportPlaybackEvent(
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
      throw new PlaybackSessionError("unavailable", { cause: error });
    }

    const expiresAt =
      state === "stopped"
        ? Math.min(session.expiresAt, now + STOPPED_SESSION_TTL_MS)
        : session.expiresAt;
    try {
      const updated = this.#database.sqlite
        .prepare(
          `update playback_sessions
           set state = ?, position_seconds = ?, revision = revision + 1,
               last_reported_at = ?, expires_at = ?, updated_at = ?
           where id = ? and user_id = ? and revision = ? and state = ? and expires_at > ?`,
        )
        .run(
          state,
          positionSeconds,
          now,
          expiresAt,
          now,
          session.id,
          source.linkUserId,
          session.revision,
          session.state,
          now,
        );
      if (updated.changes !== 1) throw new PlaybackSessionError("transition_invalid");
      return playbackProgressResponseSchema.parse({
        acceptedAt: new Date(now).toISOString(),
        positionSeconds,
        sessionId: session.id,
        state: publicState(state),
      });
    } catch (error) {
      if (error instanceof PlaybackSessionError) throw error;
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  #client(source: PlaybackSourceRow) {
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
        tlsPolicy,
        ...connectorSecrets(source, this.#cipher),
      });
    } catch (error) {
      throw new PlaybackConfigurationError("invalid", { cause: error });
    }
  }

  #createSession(
    source: PlaybackSourceRow,
    mediaReferenceId: string,
    result: JellyfinPlaybackResult,
  ) {
    const now = validTime(this.#clock());
    const expiresAt = now + PLAYBACK_SESSION_TTL_MS;
    const payload = storedPlayback(result);
    try {
      return this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare(
              `delete from playback_sessions
               where user_id = ?
                 and (expires_at <= ? or service_identity_link_id <> ? or link_revision <> ?)`,
            )
            .run(source.linkUserId, now, source.linkId, source.linkRevision);
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
      throw new PlaybackSessionError("unavailable", { cause: error });
    }
  }

  #enforceUserLimit(userId: string, protectedId: string) {
    const row = this.#database.sqlite
      .prepare("select count(*) as count from playback_sessions where user_id = ?")
      .get(userId) as { count: number };
    if (row.count <= MAX_PLAYBACK_SESSIONS_PER_USER) return;
    this.#database.sqlite
      .prepare(
        `delete from playback_sessions
         where id in (
           select id from playback_sessions
           where user_id = ? and id <> ?
           order by case when state = 'stopped' then 0 else 1 end, updated_at asc, id asc
           limit ?
         )`,
      )
      .run(userId, protectedId, row.count - MAX_PLAYBACK_SESSIONS_PER_USER);
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
      (row.insecureHttpApproved !== 0 && row.insecureHttpApproved !== 1)
    ) {
      throw new PlaybackSessionError("not_found");
    }
    return row;
  }
}
