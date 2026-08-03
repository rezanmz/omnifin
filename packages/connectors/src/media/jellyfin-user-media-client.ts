import { z } from "zod";
import {
  LIBRARY_EPISODE_MAX_CREDITS,
  LIBRARY_EPISODE_MAX_GENRES,
  LIBRARY_EPISODE_MAX_STUDIOS,
  type LibraryEpisodeCredit,
} from "@omnifin/contracts/library";

import {
  jellyfinAuthorization,
  jellyfinClientMetadata,
  type JellyfinClientMetadata,
} from "../auth/jellyfin-authorization.js";
import { SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

export const JELLYFIN_CONTINUE_WATCHING_LIMIT = 50;
export const JELLYFIN_LIBRARY_BROWSE_LIMIT = 50;
export const JELLYFIN_LIBRARY_EPISODE_LIMIT = 50;
export const JELLYFIN_LIBRARY_SEASON_LIMIT = 100;
const JELLYFIN_SEASON_COUNT_CONCURRENCY = 4;
const JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT = 50;
const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
const MAX_RUNTIME_TICKS = 60_000_000_000_000;
const BLUR_HASH_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

const imageTagsSchema = z.record(
  z.string().trim().min(1).max(80),
  z.string().min(1).max(256).nullable(),
);

const jellyfinResumeItemSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.nullish(),
  IndexNumber: z.int().nonnegative().max(100_000).nullish(),
  Name: z.string().trim().min(1).max(300),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ParentBackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  ParentBackdropItemId: z.string().trim().min(1).max(256).nullish(),
  ParentIndexNumber: z.int().nonnegative().max(100_000).nullish(),
  ProductionYear: z.int().min(1870).max(2200).nullish(),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  SeriesId: z.string().trim().min(1).max(256).nullish(),
  SeriesName: z.string().trim().min(1).max(300).nullish(),
  SeriesPrimaryImageTag: z.string().min(1).max(256).nullish(),
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

const jellyfinLibraryItemSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.nullish(),
  IndexNumber: z.int().nonnegative().max(100_000).nullish(),
  Name: z.string().trim().min(1).max(300).nullish(),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ParentBackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  ParentBackdropItemId: z.string().trim().min(1).max(256).nullish(),
  ParentIndexNumber: z.int().nonnegative().max(100_000).nullish(),
  ProductionYear: z.int().min(0).max(9_999).nullish(),
  RunTimeTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
  SeriesId: z.string().trim().min(1).max(256).nullish(),
  SeriesName: z.string().trim().min(1).max(300).nullish(),
  SeriesPrimaryImageTag: z.string().min(1).max(256).nullish(),
  Type: z.enum(["Movie", "Series"]),
  UserData: z
    .object({
      Played: z.boolean().nullish(),
      PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
    })
    .nullish(),
});

const jellyfinLibraryResponseSchema = z.object({
  Items: z.array(jellyfinLibraryItemSchema).max(JELLYFIN_LIBRARY_BROWSE_LIMIT + 1),
});

const jellyfinLibrarySeasonSchema = z.object({
  ChildCount: z.int().nonnegative().max(100_000).nullish(),
  Id: z.string().trim().min(1).max(256),
  IndexNumber: z.int().nonnegative().max(100_000),
  Name: z.string().trim().min(1).max(300),
  RecursiveItemCount: z.int().nonnegative().max(100_000).nullish(),
  Type: z.literal("Season"),
  UserData: z
    .object({
      Played: z.boolean().nullish(),
      UnplayedItemCount: z.int().nonnegative().max(100_000).nullish(),
    })
    .nullish(),
});

const jellyfinLibrarySeasonsResponseSchema = z.object({
  Items: z.array(jellyfinLibrarySeasonSchema).max(JELLYFIN_LIBRARY_SEASON_LIMIT + 1),
});

const jellyfinLibraryEpisodeSchema = z.object({
  BackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  CommunityRating: z.number().finite().nullish(),
  CriticRating: z.number().finite().nullish(),
  Genres: z.array(z.string().max(100)).max(128).nullish(),
  Id: z.string().trim().min(1).max(256),
  ImageBlurHashes: z.unknown().optional(),
  ImageTags: imageTagsSchema.nullish(),
  IndexNumber: z.int().nonnegative().max(100_000).nullish(),
  Name: z.string().trim().min(1).max(300),
  OfficialRating: z.string().trim().max(32).nullish(),
  Overview: z.string().max(8_000).nullish(),
  ParentBackdropImageTags: z.array(z.string().min(1).max(256)).max(32).nullish(),
  ParentBackdropItemId: z.string().trim().min(1).max(256).nullish(),
  ParentIndexNumber: z.int().nonnegative().max(100_000).nullish(),
  People: z
    .array(
      z.object({
        Name: z.string().max(160).nullish(),
        Role: z.string().max(200).nullish(),
        Type: z.string().max(64).nullish(),
      }),
    )
    .max(256)
    .nullish(),
  PremiereDate: z.string().trim().min(1).max(64).nullish(),
  ProductionYear: z.int().min(0).max(9_999).nullish(),
  RunTimeTicks: z.int().positive().max(MAX_RUNTIME_TICKS),
  SeriesId: z.string().trim().min(1).max(256),
  SeriesName: z.string().trim().min(1).max(300).nullish(),
  SeriesPrimaryImageTag: z.string().min(1).max(256).nullish(),
  Studios: z
    .array(z.object({ Name: z.string().max(160).nullish() }))
    .max(128)
    .nullish(),
  Type: z.literal("Episode"),
  UserData: z
    .object({
      Played: z.boolean().nullish(),
      PlaybackPositionTicks: z.int().nonnegative().max(MAX_RUNTIME_TICKS).nullish(),
    })
    .nullish(),
});

const jellyfinLibraryEpisodesResponseSchema = z.object({
  Items: z.array(jellyfinLibraryEpisodeSchema).max(JELLYFIN_LIBRARY_EPISODE_LIMIT + 1),
});

const jellyfinLibraryEpisodeCountResponseSchema = z.object({
  Items: z
    .array(
      z.object({
        Id: z.string().trim().min(1).max(256),
        Type: z.literal("Episode"),
        UserData: z
          .object({
            Played: z.boolean().nullish(),
          })
          .nullish(),
      }),
    )
    .max(JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT + 1),
  TotalRecordCount: z.int().nonnegative().max(100_000).optional(),
});

const jellyfinLibraryQuerySchema = z.strictObject({
  kind: z.enum(["all", "movies", "series"]),
  limit: z.int().positive().max(JELLYFIN_LIBRARY_BROWSE_LIMIT),
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .optional(),
  sort: z.enum(["recent", "title", "year"]),
  startIndex: z.int().nonnegative().max(1_000_000),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});

const jellyfinLibraryTitleQuerySchema = z.strictObject({
  itemId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});

const jellyfinLibrarySeasonEpisodesQuerySchema = z.strictObject({
  limit: z.int().positive().max(JELLYFIN_LIBRARY_EPISODE_LIMIT),
  seasonNumber: z.int().nonnegative().max(100_000),
  seriesId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  startIndex: z.int().nonnegative().max(1_000_000),
  userId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
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

export interface JellyfinLibraryBrowseInput {
  kind: "all" | "movies" | "series";
  limit: number;
  query?: string;
  sort: "recent" | "title" | "year";
  startIndex: number;
  userId: string;
}

export interface JellyfinLibraryItem {
  artwork: JellyfinContinueWatchingItem["artwork"];
  contentRating: string | null;
  externalId: string;
  kind: "movie" | "series";
  overview: string | null;
  played: boolean;
  positionSeconds: number;
  runtimeSeconds: number | null;
  title: string;
  year: number | null;
}

export interface JellyfinLibraryResult {
  items: JellyfinLibraryItem[];
  nextStartIndex: number | null;
  truncated: boolean;
}

export interface JellyfinLibrarySeason {
  episodeCount: number;
  playedEpisodeCount: number;
  seasonNumber: number;
  title: string;
}

export interface JellyfinLibraryTitleResult {
  item: JellyfinLibraryItem;
  seasons: JellyfinLibrarySeason[];
  seasonsTruncated: boolean;
}

export interface JellyfinLibrarySeasonEpisodesInput {
  limit: number;
  seasonNumber: number;
  seriesId: string;
  startIndex: number;
  userId: string;
}

export interface JellyfinLibrarySeasonEpisodesResult {
  items: JellyfinLibraryEpisode[];
  nextStartIndex: number | null;
  truncated: boolean;
}

export interface JellyfinLibraryEpisode extends Omit<
  JellyfinContinueWatchingItem,
  "lastPlayedAt" | "kind"
> {
  airDate: string | null;
  communityRating: number | null;
  credits: LibraryEpisodeCredit[];
  creditsTruncated: boolean;
  criticRating: number | null;
  genres: string[];
  kind: "episode";
  played: boolean;
  studios: string[];
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

function dateOnly(value: string | null | undefined) {
  const candidate = value?.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (!candidate) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate;
}

function boundedRating(value: number | null | undefined, maximum: number) {
  return value !== null && value !== undefined && value >= 0 && value <= maximum ? value : null;
}

function uniqueText(
  values: readonly string[] | null | undefined,
  limit: number,
  maxLength: number,
) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const text = compactText(value, maxLength);
    const key = text?.toLocaleLowerCase("en-US");
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
    if (normalized.length === limit) break;
  }
  return normalized;
}

function episodeCredits(
  people: z.infer<typeof jellyfinLibraryEpisodeSchema>["People"],
): Pick<JellyfinLibraryEpisode, "credits" | "creditsTruncated"> {
  const normalized: LibraryEpisodeCredit[] = [];
  const seen = new Set<string>();
  for (const person of people ?? []) {
    const upstreamType = person.Type?.toLocaleLowerCase("en-US").replace(/[\s_-]+/gu, "");
    const type =
      upstreamType === "actor" || upstreamType === "gueststar"
        ? ("cast" as const)
        : upstreamType === "director"
          ? ("director" as const)
          : upstreamType === "writer"
            ? ("writer" as const)
            : null;
    if (!type) continue;
    const name = compactText(person.Name, 160);
    if (!name) continue;
    const role = compactText(person.Role, 200);
    const key = `${type}:${name.toLocaleLowerCase("en-US")}:${role?.toLocaleLowerCase("en-US") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ name, role, type });
  }
  return {
    credits: normalized.slice(0, LIBRARY_EPISODE_MAX_CREDITS),
    creditsTruncated: normalized.length > LIBRARY_EPISODE_MAX_CREDITS,
  };
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
  item: { ImageBlurHashes?: unknown },
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

function episodeLabel(item: {
  IndexNumber?: number | null | undefined;
  Name?: string | null | undefined;
  ParentIndexNumber?: number | null | undefined;
}) {
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
      : (item.ImageTags?.Primary ?? undefined);
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

function normalizeLibraryItem(
  item: z.infer<typeof jellyfinLibraryItemSchema>,
): JellyfinLibraryItem | null {
  if (!item.Name) return null;
  const isMovie = item.Type === "Movie";
  const runtimeSeconds = item.RunTimeTicks ? secondsFromTicks(item.RunTimeTicks) : null;
  if (isMovie && (runtimeSeconds === null || runtimeSeconds < 1)) return null;
  const posterTag = item.ImageTags?.Primary ?? undefined;
  const poster = posterTag ? { itemId: item.Id, type: "Primary" as const } : null;
  const backdropTag = item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0];
  const backdropItemId = item.ParentBackdropImageTags?.length
    ? item.ParentBackdropItemId
    : item.BackdropImageTags?.length
      ? item.Id
      : undefined;
  const positionSeconds =
    runtimeSeconds === null
      ? 0
      : Math.min(runtimeSeconds, secondsFromTicks(item.UserData?.PlaybackPositionTicks ?? 0));

  return {
    artwork: {
      ...artworkPalette(item, posterTag, backdropTag),
      backdrop: backdropItemId ? { itemId: backdropItemId, type: "Backdrop" } : null,
      poster,
    },
    contentRating: compactText(item.OfficialRating, 32),
    externalId: item.Id,
    kind: isMovie ? "movie" : "series",
    overview: compactText(item.Overview, 2_000),
    played: item.UserData?.Played ?? false,
    positionSeconds,
    runtimeSeconds,
    title: item.Name,
    year:
      item.ProductionYear !== null &&
      item.ProductionYear !== undefined &&
      item.ProductionYear >= 1870 &&
      item.ProductionYear <= 2200
        ? item.ProductionYear
        : null,
  };
}

function normalizeLibraryEpisode(
  item: z.infer<typeof jellyfinLibraryEpisodeSchema>,
): JellyfinLibraryEpisode | null {
  const runtimeSeconds = secondsFromTicks(item.RunTimeTicks);
  if (runtimeSeconds < 1) return null;
  const posterTag = item.ImageTags?.Primary ?? item.SeriesPrimaryImageTag ?? undefined;
  const poster = posterTag
    ? {
        itemId: item.ImageTags?.Primary ? item.Id : item.SeriesId,
        type: "Primary" as const,
      }
    : null;
  const backdropTag = item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0];
  const backdropItemId = item.ParentBackdropImageTags?.length
    ? (item.ParentBackdropItemId ?? item.SeriesId)
    : item.BackdropImageTags?.length
      ? item.Id
      : undefined;
  return {
    airDate: dateOnly(item.PremiereDate),
    artwork: {
      ...artworkPalette(item, posterTag, backdropTag),
      backdrop: backdropItemId ? { itemId: backdropItemId, type: "Backdrop" } : null,
      poster,
    },
    contentRating: compactText(item.OfficialRating, 32),
    communityRating: boundedRating(item.CommunityRating, 10),
    criticRating: boundedRating(item.CriticRating, 100),
    ...episodeCredits(item.People),
    episodeNumber: item.IndexNumber ?? null,
    externalId: item.Id,
    kind: "episode",
    genres: uniqueText(item.Genres, LIBRARY_EPISODE_MAX_GENRES, 100),
    overview: compactText(item.Overview, 2_000),
    played: item.UserData?.Played ?? false,
    positionSeconds: Math.min(
      runtimeSeconds,
      secondsFromTicks(item.UserData?.PlaybackPositionTicks ?? 0),
    ),
    runtimeSeconds,
    seasonNumber: item.ParentIndexNumber ?? null,
    subtitle: episodeLabel(item),
    title: item.Name,
    studios: uniqueText(
      item.Studios?.flatMap(({ Name }) => (Name === null || Name === undefined ? [] : [Name])),
      LIBRARY_EPISODE_MAX_STUDIOS,
      160,
    ),
    year:
      item.ProductionYear !== null &&
      item.ProductionYear !== undefined &&
      item.ProductionYear >= 1870 &&
      item.ProductionYear <= 2200
        ? item.ProductionYear
        : null,
  };
}

interface JellyfinSeasonProgressFallback {
  episodeCount: number;
  playedEpisodeCount: number | null;
}

function normalizeLibrarySeason(
  item: z.infer<typeof jellyfinLibrarySeasonSchema>,
  fallback?: JellyfinSeasonProgressFallback,
): JellyfinLibrarySeason {
  const episodeCount = item.RecursiveItemCount ?? item.ChildCount ?? fallback?.episodeCount ?? 0;
  const unplayed = Math.min(episodeCount, item.UserData?.UnplayedItemCount ?? episodeCount);
  return {
    episodeCount,
    playedEpisodeCount: item.UserData?.Played
      ? episodeCount
      : item.UserData?.UnplayedItemCount !== null && item.UserData?.UnplayedItemCount !== undefined
        ? episodeCount - unplayed
        : (fallback?.playedEpisodeCount ?? 0),
    seasonNumber: item.IndexNumber,
    title: item.Name,
  };
}

function libraryItemTypes(kind: JellyfinLibraryBrowseInput["kind"]) {
  if (kind === "movies") return "Movie";
  if (kind === "series") return "Series";
  return "Movie,Series";
}

function librarySort(sort: JellyfinLibraryBrowseInput["sort"]) {
  if (sort === "title") return { SortBy: "SortName", SortOrder: "Ascending" };
  if (sort === "year") {
    return { SortBy: "ProductionYear,SortName", SortOrder: "Descending,Ascending" };
  }
  return { SortBy: "DateCreated", SortOrder: "Descending" };
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

  public async readLibrary(
    rawInput: JellyfinLibraryBrowseInput,
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryResult> {
    const input = jellyfinLibraryQuerySchema.parse(rawInput);
    const response = await this.#client.requestJson(
      `Users/${input.userId}/Items`,
      jellyfinLibraryResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableTotalRecordCount: "false",
          EnableUserData: "true",
          Fields: "Overview,ProductionYear,OfficialRating,ImageBlurHashes",
          ImageTypeLimit: "1",
          IncludeItemTypes: libraryItemTypes(input.kind),
          IsMissing: "false",
          IsVirtualItem: "false",
          Limit: String(input.limit + 1),
          Recursive: "true",
          ...(input.query === undefined ? {} : { SearchTerm: input.query }),
          ...librarySort(input.sort),
          StartIndex: String(input.startIndex),
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const truncated = response.Items.length > input.limit;
    return {
      items: response.Items.slice(0, input.limit)
        .map(normalizeLibraryItem)
        .filter((item): item is JellyfinLibraryItem => item !== null),
      nextStartIndex: truncated ? input.startIndex + input.limit : null,
      truncated,
    };
  }

  public async readLibraryTitle(
    rawInput: { itemId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryTitleResult> {
    const input = jellyfinLibraryTitleQuerySchema.parse(rawInput);
    const itemResponse = await this.#client.requestJson(
      `Items/${input.itemId}`,
      jellyfinLibraryItemSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: { UserId: input.userId },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const item = normalizeLibraryItem(itemResponse);
    if (!item || item.externalId !== input.itemId)
      throw this.#client.invalidResponse("media.library");
    if (item.kind === "movie") return { item, seasons: [], seasonsTruncated: false };

    const seasonsResponse = await this.#client.requestJson(
      `Shows/${input.itemId}/Seasons`,
      jellyfinLibrarySeasonsResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableUserData: "true",
          Fields: "ItemCounts",
          ImageTypeLimit: "1",
          IsMissing: "false",
          Limit: String(JELLYFIN_LIBRARY_SEASON_LIMIT + 1),
          SortBy: "IndexNumber",
          SortOrder: "Ascending",
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const seasonItems = seasonsResponse.Items.slice(0, JELLYFIN_LIBRARY_SEASON_LIMIT);
    const fallbackProgress = new Map<string, JellyfinSeasonProgressFallback>();
    const seasonsWithoutCounts = seasonItems.filter(
      (season) =>
        (season.RecursiveItemCount === null || season.RecursiveItemCount === undefined) &&
        (season.ChildCount === null || season.ChildCount === undefined),
    );
    for (
      let offset = 0;
      offset < seasonsWithoutCounts.length;
      offset += JELLYFIN_SEASON_COUNT_CONCURRENCY
    ) {
      const batch = seasonsWithoutCounts.slice(offset, offset + JELLYFIN_SEASON_COUNT_CONCURRENCY);
      const progress = await Promise.all(
        batch.map((season) =>
          this.#readSeasonProgress(
            {
              seasonNumber: season.IndexNumber,
              seriesId: input.itemId,
              userId: input.userId,
            },
            signal,
          ),
        ),
      );
      for (const [index, season] of batch.entries()) {
        fallbackProgress.set(season.Id, progress[index]!);
      }
    }
    return {
      item,
      seasons: seasonItems.map((season) =>
        normalizeLibrarySeason(season, fallbackProgress.get(season.Id)),
      ),
      seasonsTruncated: seasonsResponse.Items.length > JELLYFIN_LIBRARY_SEASON_LIMIT,
    };
  }

  async #readSeasonProgress(
    input: { seasonNumber: number; seriesId: string; userId: string },
    signal?: AbortSignal,
  ): Promise<JellyfinSeasonProgressFallback> {
    const response = await this.#client.requestJson(
      `Shows/${input.seriesId}/Episodes`,
      jellyfinLibraryEpisodeCountResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImages: "false",
          EnableUserData: "true",
          IsMissing: "false",
          Limit: String(JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT + 1),
          Season: String(input.seasonNumber),
          StartIndex: "0",
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (
      response.TotalRecordCount !== undefined &&
      response.TotalRecordCount < response.Items.length
    ) {
      throw this.#client.invalidResponse("media.library");
    }
    const pageIsComplete =
      response.TotalRecordCount === undefined
        ? response.Items.length <= JELLYFIN_SEASON_COUNT_FALLBACK_LIMIT
        : response.Items.length >= response.TotalRecordCount;
    const episodeCount =
      response.TotalRecordCount ?? (pageIsComplete ? response.Items.length : null);
    if (episodeCount === null) throw this.#client.invalidResponse("media.library");
    return {
      episodeCount,
      playedEpisodeCount: pageIsComplete
        ? response.Items.filter((episode) => episode.UserData?.Played).length
        : null,
    };
  }

  public async readLibrarySeasonEpisodes(
    rawInput: JellyfinLibrarySeasonEpisodesInput,
    signal?: AbortSignal,
  ): Promise<JellyfinLibrarySeasonEpisodesResult> {
    const input = jellyfinLibrarySeasonEpisodesQuerySchema.parse(rawInput);
    const response = await this.#client.requestJson(
      `Shows/${input.seriesId}/Episodes`,
      jellyfinLibraryEpisodesResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "media.library",
        query: {
          EnableImageTypes: "Primary,Backdrop",
          EnableUserData: "true",
          Fields:
            "Overview,ProductionYear,OfficialRating,CommunityRating,CriticRating,PremiereDate,Genres,Studios,People,ImageBlurHashes",
          ImageTypeLimit: "1",
          IsMissing: "false",
          Limit: String(input.limit + 1),
          Season: String(input.seasonNumber),
          SortBy: "IndexNumber",
          StartIndex: String(input.startIndex),
          UserId: input.userId,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const truncated = response.Items.length > input.limit;
    return {
      items: response.Items.slice(0, input.limit)
        .map(normalizeLibraryEpisode)
        .filter((item): item is JellyfinLibraryEpisode => item !== null),
      nextStartIndex: truncated ? input.startIndex + input.limit : null,
      truncated,
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
