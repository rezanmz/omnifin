import { z } from "zod";

import {
  jellyfinAuthorization,
  jellyfinClientMetadata,
  type JellyfinClientMetadata,
} from "../auth/jellyfin-authorization.js";
import { SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

export const JELLYFIN_CONTINUE_WATCHING_LIMIT = 50;
const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
const MAX_RUNTIME_TICKS = 60_000_000_000_000;
const BLUR_HASH_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

const imageTagsSchema = z.record(z.string().trim().min(1).max(80), z.string().min(1).max(256));

const jellyfinResumeItemSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).optional(),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.optional(),
  IndexNumber: z.int().nonnegative().max(100_000).optional(),
  Name: z.string().trim().min(1).max(300),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ParentBackdropImageTags: z.array(z.string().min(1).max(256)).max(32).optional(),
  ParentBackdropItemId: z.string().trim().min(1).max(256).optional(),
  ParentIndexNumber: z.int().nonnegative().max(100_000).optional(),
  ProductionYear: z.int().min(1870).max(2200).nullish(),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  SeriesId: z.string().trim().min(1).max(256).optional(),
  SeriesName: z.string().trim().min(1).max(300).optional(),
  SeriesPrimaryImageTag: z.string().min(1).max(256).optional(),
  Type: z.string().trim().min(1).max(80),
  UserData: z.object({
    LastPlayedDate: z.iso.datetime({ offset: true }),
    PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS),
  }),
});

const jellyfinResumeResponseSchema = z.object({
  Items: z.array(jellyfinResumeItemSchema).max(JELLYFIN_CONTINUE_WATCHING_LIMIT + 1),
  StartIndex: z.int().nonnegative().optional(),
  TotalRecordCount: z.int().nonnegative().optional(),
});

export interface JellyfinArtworkSource {
  itemId: string;
  type: "Backdrop" | "Primary";
}

export interface JellyfinContinueWatchingItem {
  artwork: {
    accentColor: string | null;
    backdrop: JellyfinArtworkSource | null;
    blurHash: string | null;
    poster: JellyfinArtworkSource | null;
  };
  contentRating: string | null;
  episodeNumber: number | null;
  externalId: string;
  kind: "episode" | "movie" | "other";
  lastPlayedAt: string;
  overview: string | null;
  positionSeconds: number;
  runtimeSeconds: number;
  seasonNumber: number | null;
  subtitle: string | null;
  title: string;
  year: number | null;
}

export interface JellyfinContinueWatchingResult {
  items: JellyfinContinueWatchingItem[];
  truncated: boolean;
}

export interface JellyfinImageResult {
  body: Uint8Array;
  contentType: "image/avif" | "image/jpeg" | "image/png" | "image/webp";
}

export interface JellyfinUserMediaClientOptions {
  accessToken: string;
  deviceId: string;
  metadata?: JellyfinClientMetadata;
  target: ConnectorTargetConfig;
}

function compactText(value: string | null | undefined, maxLength: number) {
  if (!value) return null;
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (!compacted) return null;
  return compacted.length <= maxLength ? compacted : compacted.slice(0, maxLength).trimEnd();
}

function secondsFromTicks(ticks: number) {
  return Math.floor(ticks / JELLYFIN_TICKS_PER_SECOND);
}

function decodeBase83(value: string) {
  let decoded = 0;
  for (const character of value) {
    const digit = BLUR_HASH_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    decoded = decoded * 83 + digit;
  }
  return decoded;
}

function toneMappedAccent(rgb: number) {
  const red = ((rgb >> 16) & 0xff) / 255;
  const green = ((rgb >> 8) & 0xff) / 255;
  const blue = (rgb & 0xff) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta < 1 / 255) return null;

  let hue =
    maximum === red
      ? ((green - blue) / delta) % 6
      : maximum === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  if (hue < 0) hue += 6;

  const sourceLightness = (maximum + minimum) / 2;
  const sourceSaturation = delta / (1 - Math.abs(2 * sourceLightness - 1));
  const saturation = Math.min(0.72, Math.max(0.38, sourceSaturation));
  const lightness = Math.min(0.62, Math.max(0.4, sourceLightness));
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const intermediate = chroma * (1 - Math.abs((hue % 2) - 1));
  const offset = lightness - chroma / 2;
  const [hueRed, hueGreen, hueBlue] =
    hue < 1
      ? [chroma, intermediate, 0]
      : hue < 2
        ? [intermediate, chroma, 0]
        : hue < 3
          ? [0, chroma, intermediate]
          : hue < 4
            ? [0, intermediate, chroma]
            : hue < 5
              ? [intermediate, 0, chroma]
              : [chroma, 0, intermediate];
  return `#${[hueRed, hueGreen, hueBlue]
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function paletteFromBlurHash(blurHash: string) {
  if (blurHash.length < 6 || blurHash.length > 166) return null;
  if ([...blurHash].some((character) => !BLUR_HASH_ALPHABET.includes(character))) return null;
  const sizeFlag = decodeBase83(blurHash[0]!);
  const dc = decodeBase83(blurHash.slice(2, 6));
  if (sizeFlag === null || sizeFlag > 80 || dc === null || dc > 0xff_ffff) return null;
  const componentColumns = (sizeFlag % 9) + 1;
  const componentRows = Math.floor(sizeFlag / 9) + 1;
  if (blurHash.length !== 4 + 2 * componentColumns * componentRows) return null;
  return { accentColor: toneMappedAccent(dc), blurHash };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedBlurHash(imageBlurHashes: unknown, type: "Backdrop" | "Primary", tag: string) {
  if (!isUnknownRecord(imageBlurHashes)) return null;
  const hashesForType = imageBlurHashes[type];
  if (!isUnknownRecord(hashesForType) || !Object.hasOwn(hashesForType, tag)) return null;
  const blurHash = hashesForType[tag];
  return typeof blurHash === "string" && blurHash.length <= 256 ? blurHash : null;
}

function artworkPalette(
  item: z.infer<typeof jellyfinResumeItemSchema>,
  posterTag: string | undefined,
  backdropTag: string | undefined,
) {
  for (const [type, tag] of [
    ["Primary", posterTag],
    ["Backdrop", backdropTag],
  ] as const) {
    if (!tag) continue;
    const blurHash = selectedBlurHash(item.ImageBlurHashes, type, tag);
    if (!blurHash) continue;
    const palette = paletteFromBlurHash(blurHash);
    if (palette) return palette;
  }
  return { accentColor: null, blurHash: null };
}

function episodeLabel(item: z.infer<typeof jellyfinResumeItemSchema>) {
  const season = item.ParentIndexNumber;
  const episode = item.IndexNumber;
  const index =
    season === undefined || episode === undefined
      ? null
      : `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return [index, item.Name].filter(Boolean).join(" · ") || null;
}

function normalizeResumeItem(
  item: z.infer<typeof jellyfinResumeItemSchema>,
): JellyfinContinueWatchingItem | null {
  const runtimeSeconds = secondsFromTicks(item.RunTimeTicks);
  if (runtimeSeconds < 1) return null;
  const positionSeconds = Math.min(
    runtimeSeconds,
    secondsFromTicks(item.UserData.PlaybackPositionTicks),
  );
  if (positionSeconds < 1 || positionSeconds >= runtimeSeconds) return null;

  const isEpisode = item.Type === "Episode";
  const isMovie = item.Type === "Movie";
  const posterTag =
    isEpisode && item.SeriesId && item.SeriesPrimaryImageTag
      ? item.SeriesPrimaryImageTag
      : item.ImageTags?.Primary;
  const poster =
    isEpisode && item.SeriesId && posterTag
      ? { itemId: item.SeriesId, type: "Primary" as const }
      : posterTag
        ? { itemId: item.Id, type: "Primary" as const }
        : null;
  const backdropTag = item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0];
  const backdropItemId = item.ParentBackdropImageTags?.length
    ? (item.ParentBackdropItemId ?? item.SeriesId)
    : item.BackdropImageTags?.length
      ? item.Id
      : undefined;
  const palette = artworkPalette(item, posterTag, backdropTag);

  return {
    artwork: {
      ...palette,
      backdrop: backdropItemId ? { itemId: backdropItemId, type: "Backdrop" } : null,
      poster,
    },
    contentRating: compactText(item.OfficialRating, 32),
    episodeNumber: isEpisode ? (item.IndexNumber ?? null) : null,
    externalId: item.Id,
    kind: isEpisode ? "episode" : isMovie ? "movie" : "other",
    lastPlayedAt: item.UserData.LastPlayedDate,
    overview: compactText(item.Overview, 2_000),
    positionSeconds,
    runtimeSeconds,
    seasonNumber: isEpisode ? (item.ParentIndexNumber ?? null) : null,
    subtitle: isEpisode ? episodeLabel(item) : null,
    title: isEpisode ? (item.SeriesName ?? item.Name) : item.Name,
    year: item.ProductionYear ?? null,
  };
}

export class JellyfinUserMediaClient {
  readonly #authorization: string;
  readonly #client: SafeHttpClient;

  public constructor(options: JellyfinUserMediaClientOptions) {
    const metadata = jellyfinClientMetadata(options.metadata);
    this.#authorization = jellyfinAuthorization({
      accessToken: options.accessToken,
      deviceId: options.deviceId,
      metadata,
    });
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

  public async readContinueWatching(signal?: AbortSignal): Promise<JellyfinContinueWatchingResult> {
    const response = await this.#client.requestJson(
      "UserItems/Resume",
      jellyfinResumeResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.continue_watching",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableUserData: "true",
          ExcludeActiveSessions: "true",
          Fields: "Overview,ProductionYear,OfficialRating,ImageBlurHashes",
          ImageTypeLimit: "1",
          Limit: String(JELLYFIN_CONTINUE_WATCHING_LIMIT + 1),
          MediaTypes: "Video",
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );

    const items = response.Items.slice(0, JELLYFIN_CONTINUE_WATCHING_LIMIT)
      .map(normalizeResumeItem)
      .filter((item): item is JellyfinContinueWatchingItem => item !== null);
    return {
      items,
      truncated:
        response.Items.length > JELLYFIN_CONTINUE_WATCHING_LIMIT ||
        (response.TotalRecordCount ?? 0) > JELLYFIN_CONTINUE_WATCHING_LIMIT,
    };
  }

  public async readImage(input: {
    itemId: string;
    maxWidth: number;
    signal?: AbortSignal;
    type: "Backdrop" | "Primary";
  }): Promise<JellyfinImageResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.itemId)) {
      throw this.#client.invalidResponse("media.image");
    }
    if (!Number.isInteger(input.maxWidth) || input.maxWidth < 64 || input.maxWidth > 3_840) {
      throw this.#client.invalidResponse("media.image");
    }
    const response = await this.#client.requestBytes(`Items/${input.itemId}/Images/${input.type}`, {
      headers: {
        accept: "image/avif,image/webp,image/jpeg,image/png",
        authorization: this.#authorization,
      },
      operation: "media.image",
      query: { maxWidth: String(input.maxWidth), quality: "90" },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType !== "image/avif" &&
      contentType !== "image/jpeg" &&
      contentType !== "image/png" &&
      contentType !== "image/webp"
    ) {
      throw this.#client.invalidResponse("media.image");
    }
    if (response.body.byteLength === 0) throw this.#client.invalidResponse("media.image");
    return { body: response.body, contentType };
  }
}
