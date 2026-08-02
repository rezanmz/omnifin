import { z } from "zod";

import {
  jellyfinAuthorization,
  jellyfinClientMetadata,
  type JellyfinClientMetadata,
} from "../auth/jellyfin-authorization.js";
import { SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
const MAX_RUNTIME_TICKS = 100_000_000_000_000;
const MAX_STREAM_INDEX = 4_095;
const MAX_PLAYBACK_BITRATE = 200_000_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const playbackTargetSegmentPattern = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/u;
const MAX_PLAYBACK_TARGET_PATH_LENGTH = 4_096;
const sensitiveQueryNames = new Set([
  "access_token",
  "api_key",
  "apikey",
  "token",
  "x-emby-token",
  "x-mediabrowser-token",
]);

export function isJellyfinPlaybackTargetPath(value: string) {
  if (
    !value ||
    value.length > MAX_PLAYBACK_TARGET_PATH_LENGTH ||
    value.startsWith("/") ||
    /[?#\\\p{Cc}\p{Cf}\s]/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  if (
    segments.length < 3 ||
    !/^videos$/iu.test(segments[0] ?? "") ||
    !identifierPattern.test(segments[1] ?? "")
  ) {
    return false;
  }
  return segments.slice(2).every((rawSegment) => {
    if (!playbackTargetSegmentPattern.test(rawSegment)) return false;
    let segment = rawSegment;
    try {
      for (let pass = 0; pass < 2; pass += 1) segment = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return (
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("/") &&
      !segment.includes("\\") &&
      !/[\p{Cc}\p{Cf}\s]/u.test(segment)
    );
  });
}

const identifierSchema = z.string().trim().regex(identifierPattern);
const nullableIdentifierSchema = identifierSchema.nullable().optional();
const optionalIndexSchema = z.int().nonnegative().max(MAX_STREAM_INDEX).optional();
const nullableBoundedTextSchema = z.string().max(512).nullish();

const mediaStreamSchema = z.object({
  BitRate: z.int().positive().max(MAX_PLAYBACK_BITRATE).nullish(),
  Channels: z.int().positive().max(64).nullish(),
  Codec: z.string().trim().min(1).max(64).nullish(),
  DeliveryMethod: z.enum(["Encode", "Embed", "External", "Hls"]).optional(),
  DisplayTitle: nullableBoundedTextSchema,
  Height: z.int().nonnegative().max(16_384).nullish(),
  Index: optionalIndexSchema,
  IsDefault: z.boolean().optional(),
  IsExternal: z.boolean().optional(),
  IsForced: z.boolean().optional(),
  Language: z.string().trim().min(1).max(64).nullish(),
  Title: nullableBoundedTextSchema,
  Type: z.enum(["Audio", "Subtitle", "Video"]),
  Width: z.int().nonnegative().max(16_384).nullish(),
});

function playbackMediaStreams(value: unknown) {
  if (!Array.isArray(value) || value.length > 512) return value;
  return value.filter((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return true;
    }
    const type = Object.getOwnPropertyDescriptor(candidate, "Type")?.value;
    if (typeof type !== "string") return true;
    return type === "Audio" || type === "Subtitle" || type === "Video";
  });
}

const mediaSourceSchema = z.object({
  Bitrate: z.int().positive().max(MAX_PLAYBACK_BITRATE).nullish(),
  Container: z.string().trim().min(1).max(64).nullish(),
  DefaultAudioStreamIndex: z.int().nonnegative().max(MAX_STREAM_INDEX).nullish(),
  DefaultSubtitleStreamIndex: z.int().nonnegative().max(MAX_STREAM_INDEX).nullish(),
  Id: identifierSchema,
  LiveStreamId: nullableIdentifierSchema,
  MediaStreams: z.preprocess(playbackMediaStreams, z.array(mediaStreamSchema).max(256).nullish()),
  RequiredHttpHeaders: z.record(z.string(), z.string().nullable()).nullish(),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  SupportsDirectPlay: z.boolean().optional(),
  SupportsTranscoding: z.boolean().optional(),
  TranscodingContainer: z.string().trim().min(1).max(64).nullish(),
  TranscodingSubProtocol: z.string().trim().min(1).max(32).nullish(),
  TranscodingUrl: z.string().min(1).max(16_384).nullish(),
});

const playbackInfoResponseSchema = z.object({
  ErrorCode: z.unknown().optional(),
  MediaSources: z.array(mediaSourceSchema).max(16).optional(),
  PlaySessionId: identifierSchema,
});

const negotiationInputSchema = z
  .strictObject({
    audioStreamIndex: z.int().nonnegative().max(MAX_STREAM_INDEX).nullable(),
    itemId: identifierSchema,
    maxStreamingBitrate: z.int().min(64_000).max(MAX_PLAYBACK_BITRATE),
    mode: z.enum(["auto", "direct", "transcode"]),
    positionSeconds: z.int().nonnegative().max(10_000_000),
    subtitleStreamIndex: z.int().nonnegative().max(MAX_STREAM_INDEX).nullable(),
  })
  .refine(
    (input) =>
      input.audioStreamIndex === null || input.audioStreamIndex !== input.subtitleStreamIndex,
    { path: ["subtitleStreamIndex"] },
  );

const reportingSessionSchema = z.strictObject({
  audioStreamIndex: z.int().nonnegative().max(MAX_STREAM_INDEX).nullable(),
  itemId: identifierSchema,
  mediaSourceId: identifierSchema,
  playMethod: z.enum(["DirectPlay", "Transcode"]),
  playSessionId: identifierSchema,
  subtitleStreamIndex: z.int().nonnegative().max(MAX_STREAM_INDEX).nullable(),
});

const reportingInputSchema = z.strictObject({
  event: z.enum(["started", "progress", "paused", "stopped"]),
  positionSeconds: z.int().nonnegative().max(10_000_000),
  session: reportingSessionSchema,
});

const browserDeviceProfile = Object.freeze({
  DirectPlayProfiles: [
    {
      AudioCodec: "aac,mp3",
      Container: "mp4,m4v",
      Type: "Video",
      VideoCodec: "h264",
    },
    {
      AudioCodec: "opus,vorbis",
      Container: "webm",
      Type: "Video",
      VideoCodec: "vp8,vp9,av1",
    },
  ],
  MaxStreamingBitrate: MAX_PLAYBACK_BITRATE,
  SubtitleProfiles: [
    { Format: "vtt", Method: "External" },
    { Format: "ass,ssa,subrip", Method: "Encode" },
    { Format: "pgssub,dvdsub", Method: "Encode" },
  ],
  TranscodingProfiles: [
    {
      AudioCodec: "aac",
      BreakOnNonKeyFrames: true,
      Container: "mp4",
      Context: "Streaming",
      EnableSubtitlesInManifest: true,
      MaxAudioChannels: "2",
      MinSegments: 1,
      Protocol: "hls",
      Type: "Video",
      VideoCodec: "h264",
    },
  ],
});

export interface JellyfinPlaybackClientOptions {
  accessToken: string;
  deviceId: string;
  metadata?: JellyfinClientMetadata;
  target: ConnectorTargetConfig;
}

export interface JellyfinPlaybackNegotiationInput {
  audioStreamIndex: number | null;
  itemId: string;
  maxStreamingBitrate: number;
  mode: "auto" | "direct" | "transcode";
  positionSeconds: number;
  subtitleStreamIndex: number | null;
}

export interface JellyfinPlaybackTrack {
  codec: string | null;
  default: boolean;
  index: number;
  language: string | null;
  selected: boolean;
  title: string | null;
}

export interface JellyfinPlaybackResult {
  audioTracks: Array<
    JellyfinPlaybackTrack & {
      channels: number | null;
    }
  >;
  delivery: "direct" | "hls";
  itemId: string;
  liveStreamId: string | null;
  media: {
    audioCodec: string | null;
    bitrate: number | null;
    container: string | null;
    durationSeconds: number;
    height: number | null;
    videoCodec: string | null;
    width: number | null;
  };
  mediaSourceId: string;
  playMethod: "DirectPlay" | "Transcode";
  playSessionId: string;
  positionSeconds: number;
  subtitleTracks: Array<
    JellyfinPlaybackTrack & {
      delivery: "external" | "hls" | "video";
      forced: boolean;
    }
  >;
  upstreamTarget: {
    path: string;
    query: string;
  };
}

export interface JellyfinPlaybackReportingSession {
  audioStreamIndex: number | null;
  itemId: string;
  mediaSourceId: string;
  playMethod: "DirectPlay" | "Transcode";
  playSessionId: string;
  subtitleStreamIndex: number | null;
}

export interface JellyfinPlaybackTarget {
  path: string;
  query: string;
}

export interface JellyfinPlaybackBytesResult {
  body: Uint8Array;
  headers: Headers;
  status: number;
}

export interface JellyfinPlaybackStreamResult {
  body: ReadableStream<Uint8Array>;
  headers: Headers;
  status: number;
}

export class JellyfinPlaybackUnavailableError extends Error {
  public readonly code = "playback_unavailable";

  public constructor(options?: ErrorOptions) {
    super("Jellyfin could not provide the requested playback source.", options);
    this.name = "JellyfinPlaybackUnavailableError";
  }
}

function compactText(value: string | null | undefined, maxLength: number) {
  if (!value) return null;
  const compacted = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (!compacted) return null;
  return compacted.length <= maxLength ? compacted : compacted.slice(0, maxLength).trimEnd();
}

function codec(value: string | null | undefined) {
  const compacted = compactText(value, 32)?.toLowerCase() ?? null;
  return compacted && /^[a-z0-9._+-]+$/u.test(compacted) ? compacted : null;
}

function language(value: string | null | undefined) {
  const compacted = compactText(value, 35);
  return compacted && /^[A-Za-z0-9-]+$/u.test(compacted) ? compacted : null;
}

function title(stream: z.infer<typeof mediaStreamSchema>) {
  return compactText(stream.DisplayTitle ?? stream.Title, 160);
}

function secondsFromTicks(ticks: number) {
  return Math.max(1, Math.floor(ticks / JELLYFIN_TICKS_PER_SECOND));
}

function ticksFromSeconds(seconds: number) {
  return seconds * JELLYFIN_TICKS_PER_SECOND;
}

function audioTracks(source: z.infer<typeof mediaSourceSchema>, selectedIndex: number | null) {
  const selected = selectedIndex ?? source.DefaultAudioStreamIndex ?? null;
  return (source.MediaStreams ?? [])
    .filter(
      (stream): stream is z.infer<typeof mediaStreamSchema> & { Index: number } =>
        stream.Type === "Audio" && stream.Index !== undefined,
    )
    .slice(0, 64)
    .map((stream) => ({
      channels: stream.Channels ?? null,
      codec: codec(stream.Codec),
      default: stream.IsDefault ?? false,
      index: stream.Index,
      language: language(stream.Language),
      selected: stream.Index === selected,
      title: title(stream),
    }));
}

function subtitleDelivery(method: string | undefined): "external" | "hls" | "video" {
  if (method === "External") return "external";
  if (method === "Hls") return "hls";
  return "video";
}

function subtitleTracks(source: z.infer<typeof mediaSourceSchema>, selectedIndex: number | null) {
  return (source.MediaStreams ?? [])
    .filter(
      (stream): stream is z.infer<typeof mediaStreamSchema> & { Index: number } =>
        stream.Type === "Subtitle" && stream.Index !== undefined,
    )
    .slice(0, 128)
    .map((stream) => ({
      codec: codec(stream.Codec),
      default: stream.IsDefault ?? false,
      delivery: subtitleDelivery(stream.DeliveryMethod),
      forced: stream.IsForced ?? false,
      index: stream.Index,
      language: language(stream.Language),
      selected: stream.Index === selectedIndex,
      title: title(stream),
    }));
}

function selectedMediaStream(
  source: z.infer<typeof mediaSourceSchema>,
  type: "Audio" | "Video",
  selectedIndex: number | null,
) {
  const streams = (source.MediaStreams ?? []).filter((stream) => stream.Type === type);
  return streams.find((stream) => stream.Index === selectedIndex) ?? streams[0];
}

function requiresUnsupportedHeaders(source: z.infer<typeof mediaSourceSchema>) {
  return Object.values(source.RequiredHttpHeaders ?? {}).some((value) => value !== null);
}

export class JellyfinPlaybackClient {
  readonly #authorization: string;
  readonly #baseUrl: URL;
  readonly #client: SafeHttpClient;
  readonly #deviceId: string;

  public constructor(options: JellyfinPlaybackClientOptions) {
    const metadata = jellyfinClientMetadata(options.metadata);
    this.#authorization = jellyfinAuthorization({
      accessToken: options.accessToken,
      deviceId: options.deviceId,
      metadata,
    });
    this.#deviceId = options.deviceId;
    this.#baseUrl = new URL(options.target.baseUrl);
    if (!this.#baseUrl.pathname.endsWith("/")) this.#baseUrl.pathname += "/";
    this.#baseUrl.search = "";
    this.#baseUrl.hash = "";
    const target = options.target;
    this.#client = new SafeHttpClient({
      allowInsecureHttp: target.insecureHttpApproved ?? false,
      baseUrl: target.baseUrl,
      ...(target.maxResponseBytes === undefined
        ? { maxResponseBytes: 1_048_576 }
        : { maxResponseBytes: target.maxResponseBytes }),
      ...(target.resolveHost === undefined ? {} : { resolveHost: target.resolveHost }),
      service: "jellyfin",
      ...(target.timeoutMs === undefined ? {} : { timeoutMs: target.timeoutMs }),
      ...(target.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: target.tlsCaCertificatePem }),
      ...(target.tlsPolicy === undefined ? {} : { tlsPolicy: target.tlsPolicy }),
      ...(target.transport === undefined ? {} : { transport: target.transport }),
    });
  }

  public async negotiate(
    rawInput: JellyfinPlaybackNegotiationInput,
    signal?: AbortSignal,
  ): Promise<JellyfinPlaybackResult> {
    const input = negotiationInputSchema.parse(rawInput);
    const body = {
      AllowAudioStreamCopy: true,
      AllowVideoStreamCopy: true,
      AudioStreamIndex: input.audioStreamIndex,
      DeviceProfile: browserDeviceProfile,
      EnableDirectPlay: input.mode !== "transcode",
      EnableDirectStream: false,
      EnableTranscoding: input.mode !== "direct",
      MaxAudioChannels: 2,
      MaxStreamingBitrate: input.maxStreamingBitrate,
      StartTimeTicks: ticksFromSeconds(input.positionSeconds),
      SubtitleStreamIndex: input.subtitleStreamIndex,
    };
    const response = await this.#client.requestJson(
      `Items/${input.itemId}/PlaybackInfo`,
      playbackInfoResponseSchema,
      {
        body: JSON.stringify(body),
        headers: {
          authorization: this.#authorization,
          "content-type": "application/json",
        },
        method: "POST",
        operation: "media.playback.negotiate",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.ErrorCode !== undefined && response.ErrorCode !== null) {
      throw new JellyfinPlaybackUnavailableError();
    }

    const candidates = (response.MediaSources ?? []).filter(
      (source) => !requiresUnsupportedHeaders(source),
    );
    const direct = candidates.find((source) => source.SupportsDirectPlay === true);
    const hls = candidates.find(
      (source) =>
        source.SupportsTranscoding === true &&
        source.TranscodingSubProtocol?.toLowerCase() === "hls" &&
        source.TranscodingUrl,
    );
    const delivery =
      input.mode === "direct"
        ? "direct"
        : input.mode === "transcode"
          ? "hls"
          : direct
            ? "direct"
            : "hls";
    const source = delivery === "direct" ? direct : hls;
    if (!source) throw new JellyfinPlaybackUnavailableError();

    const audio = audioTracks(source, input.audioStreamIndex);
    const subtitles = subtitleTracks(source, input.subtitleStreamIndex);
    if (
      (input.audioStreamIndex !== null && !audio.some((track) => track.selected)) ||
      (input.subtitleStreamIndex !== null && !subtitles.some((track) => track.selected))
    ) {
      throw new JellyfinPlaybackUnavailableError();
    }

    const upstreamTarget =
      delivery === "direct"
        ? this.#directTarget(input.itemId, source.Id, response.PlaySessionId)
        : this.#transcodingTarget(source.TranscodingUrl ?? "");
    const selectedAudioIndex =
      input.audioStreamIndex ?? source.DefaultAudioStreamIndex ?? audio[0]?.index ?? null;
    const video = selectedMediaStream(source, "Video", null);
    const selectedAudio = selectedMediaStream(source, "Audio", selectedAudioIndex);
    const durationSeconds = secondsFromTicks(source.RunTimeTicks);

    return {
      audioTracks: audio,
      delivery,
      itemId: input.itemId,
      liveStreamId: source.LiveStreamId ?? null,
      media: {
        audioCodec: codec(selectedAudio?.Codec),
        bitrate: source.Bitrate ?? null,
        container:
          codec(delivery === "hls" ? source.TranscodingContainer : source.Container) ?? null,
        durationSeconds,
        height: video?.Height ?? null,
        videoCodec: codec(video?.Codec),
        width: video?.Width ?? null,
      },
      mediaSourceId: source.Id,
      playMethod: delivery === "direct" ? "DirectPlay" : "Transcode",
      playSessionId: response.PlaySessionId,
      positionSeconds: Math.min(input.positionSeconds, durationSeconds),
      subtitleTracks: subtitles,
      upstreamTarget,
    };
  }

  public async reportPlaybackEvent(
    rawInput: {
      event: "started" | "progress" | "paused" | "stopped";
      positionSeconds: number;
      session: JellyfinPlaybackReportingSession;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const input = reportingInputSchema.parse(rawInput);
    const path =
      input.event === "started"
        ? "Sessions/Playing"
        : input.event === "stopped"
          ? "Sessions/Playing/Stopped"
          : "Sessions/Playing/Progress";
    await this.#client.requestBytes(path, {
      body: JSON.stringify({
        AudioStreamIndex: input.session.audioStreamIndex,
        CanSeek: true,
        IsPaused: input.event === "paused",
        ItemId: input.session.itemId,
        MediaSourceId: input.session.mediaSourceId,
        PlayMethod: input.session.playMethod,
        PlaySessionId: input.session.playSessionId,
        PositionTicks: ticksFromSeconds(input.positionSeconds),
        SubtitleStreamIndex: input.session.subtitleStreamIndex,
      }),
      headers: {
        authorization: this.#authorization,
        "content-type": "application/json",
      },
      method: "POST",
      operation: `media.playback.${input.event}`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async readPlaybackTarget(input: {
    accept?: string;
    range?: string;
    signal?: AbortSignal;
    target: JellyfinPlaybackTarget;
  }): Promise<JellyfinPlaybackBytesResult> {
    const target = this.#validatedTarget(input.target, "media.playback.stream");
    if (input.range !== undefined && !/^bytes=\d+-\d+$/u.test(input.range)) {
      throw this.#client.invalidResponse("media.playback.stream");
    }
    if (
      input.accept !== undefined &&
      (!/^[A-Za-z0-9*+./,;= -]{1,256}$/u.test(input.accept) || /[\r\n]/u.test(input.accept))
    ) {
      throw this.#client.invalidResponse("media.playback.stream");
    }
    return this.#client.requestBytes(target.path, {
      acceptedStatuses: [206, 416],
      headers: {
        ...(input.accept === undefined ? {} : { accept: input.accept }),
        authorization: this.#authorization,
        ...(input.range === undefined ? {} : { range: input.range }),
      },
      operation: "media.playback.stream",
      query: new URLSearchParams(target.query),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public async streamPlaybackTarget(input: {
    accept?: string;
    maxResponseBytes: number;
    signal?: AbortSignal;
    target: JellyfinPlaybackTarget;
  }): Promise<JellyfinPlaybackStreamResult> {
    const target = this.#validatedTarget(input.target, "media.playback.stream");
    if (
      input.accept !== undefined &&
      (!/^[A-Za-z0-9*+./,;= -]{1,256}$/u.test(input.accept) || /[\r\n]/u.test(input.accept))
    ) {
      throw this.#client.invalidResponse("media.playback.stream");
    }
    return this.#client.requestStream(
      target.path,
      {
        headers: {
          ...(input.accept === undefined ? {} : { accept: input.accept }),
          authorization: this.#authorization,
        },
        operation: "media.playback.stream",
        query: new URLSearchParams(target.query),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      input.maxResponseBytes,
    );
  }

  public resolvePlaybackTarget(
    parent: JellyfinPlaybackTarget,
    candidate: string,
  ): JellyfinPlaybackTarget {
    const normalizedParent = this.#validatedTarget(parent, "media.playback.manifest");
    if (!candidate || candidate.length > 16_384 || /[\p{Cc}\p{Cf}\\]/u.test(candidate)) {
      throw this.#client.invalidResponse("media.playback.manifest");
    }
    const parentUrl = new URL(normalizedParent.path, this.#baseUrl);
    parentUrl.search = normalizedParent.query;
    let target: URL;
    try {
      target = new URL(candidate, parentUrl);
    } catch {
      throw this.#client.invalidResponse("media.playback.manifest");
    }
    const normalized = this.#targetFromUrl(target, "media.playback.manifest");
    const parentScope = normalizedParent.path.split("/").slice(0, 2).join("/");
    if (!normalized.path.startsWith(`${parentScope}/`)) {
      throw this.#client.invalidResponse("media.playback.manifest");
    }
    return normalized;
  }

  #directTarget(itemId: string, mediaSourceId: string, playSessionId: string) {
    const query = new URLSearchParams({
      static: "true",
      mediaSourceId,
      playSessionId,
      deviceId: this.#deviceId,
    });
    return { path: `Videos/${itemId}/stream`, query: query.toString() };
  }

  #transcodingTarget(candidate: string) {
    let target: URL;
    try {
      target = new URL(candidate, this.#baseUrl);
    } catch {
      throw this.#client.invalidResponse("media.playback.negotiate");
    }
    const normalized = this.#targetFromUrl(target, "media.playback.negotiate");
    const path = normalized.path;
    if (!/^Videos\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\/master\.m3u8$/iu.test(path)) {
      throw this.#client.invalidResponse("media.playback.negotiate");
    }
    return normalized;
  }

  #validatedTarget(target: JellyfinPlaybackTarget, operation: string) {
    if (
      !target.path ||
      target.path.length > 4_096 ||
      target.query.length > 32_768 ||
      target.path.startsWith("/") ||
      /[?#\\\p{Cc}\p{Cf}\s]/u.test(target.path)
    ) {
      throw this.#client.invalidResponse(operation);
    }
    let url: URL;
    try {
      url = new URL(target.path, this.#baseUrl);
      url.search = target.query;
    } catch {
      throw this.#client.invalidResponse(operation);
    }
    const normalized = this.#targetFromUrl(url, operation);
    if (normalized.path !== target.path) throw this.#client.invalidResponse(operation);
    return normalized;
  }

  #targetFromUrl(target: URL, operation: string): JellyfinPlaybackTarget {
    if (
      target.origin !== this.#baseUrl.origin ||
      target.username ||
      target.password ||
      target.hash ||
      !target.pathname.startsWith(this.#baseUrl.pathname)
    ) {
      throw this.#client.invalidResponse(operation);
    }
    const path = target.pathname.slice(this.#baseUrl.pathname.length);
    if (!isJellyfinPlaybackTargetPath(path)) {
      throw this.#client.invalidResponse(operation);
    }
    for (const name of [...target.searchParams.keys()]) {
      if (sensitiveQueryNames.has(name.toLowerCase())) target.searchParams.delete(name);
    }
    return { path, query: target.searchParams.toString() };
  }
}
