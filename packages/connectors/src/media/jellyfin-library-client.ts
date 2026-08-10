import type { LibraryAttentionIssue, LibraryArtworkKind } from "@omnifin/contracts/library";
import {
  LIBRARY_ARTWORK_MAX_RESULTS,
  LIBRARY_ATTENTION_MAX_ITEMS,
} from "@omnifin/contracts/library";
import { z } from "zod";

import {
  jellyfinAuthorization,
  jellyfinClientMetadata,
  type JellyfinClientMetadata,
} from "../auth/jellyfin-authorization.js";
import { SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

const MAX_LIBRARY_SCAN_OFFSET = 1_000_000;
const MAX_UPSTREAM_ITEM_BYTES = 2 * 1_024 * 1_024;
const MAX_REMOTE_IMAGE_BYTES = 8 * 1_024 * 1_024;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const identifierSchema = z.string().trim().regex(identifierPattern);
const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const nullableTextSchema = z.string().max(8_000).nullish();
const imageTagsSchema = z.record(z.string().trim().min(1).max(80), z.string().min(1).max(256));
const providerIdsSchema = z.record(z.string().trim().min(1).max(80), z.string().max(512).nullish());

const attentionItemSchema = z.object({
  Id: identifierSchema,
  ImageTags: imageTagsSchema.optional(),
  Name: safeTextSchema.max(300),
  Overview: nullableTextSchema,
  ProductionYear: z.int().min(1870).max(2200).nullish(),
  ProviderIds: providerIdsSchema.optional(),
  Type: z.enum(["Movie", "Series"]),
});

const attentionResponseSchema = z.object({
  Items: z.array(attentionItemSchema).max(LIBRARY_ATTENTION_MAX_ITEMS + 1),
  StartIndex: z.int().nonnegative().optional(),
  TotalRecordCount: z.int().nonnegative().max(MAX_LIBRARY_SCAN_OFFSET).optional(),
});

const editableItemSchema = z
  .object({
    Id: identifierSchema,
    Name: safeTextSchema.max(300),
    Overview: nullableTextSchema,
    ProductionYear: z.int().min(1870).max(2200).nullish(),
    Type: z.string().trim().min(1).max(80),
  })
  .loose();

const remoteImageSchema = z.object({
  CommunityRating: z.number().finite().min(0).max(10).nullish(),
  Height: z.int().positive().max(32_768).nullish(),
  Language: safeTextSchema.max(80).nullish(),
  ProviderName: safeTextSchema.max(120),
  ThumbnailUrl: z.string().max(8_192).nullish(),
  Type: z.enum(["Backdrop", "Primary"]),
  Url: z.string().min(1).max(8_192),
  VoteCount: z.int().nonnegative().max(2_147_483_647).nullish(),
  Width: z.int().positive().max(32_768).nullish(),
});

const remoteImageResponseSchema = z.object({
  Images: z.array(remoteImageSchema).max(LIBRARY_ARTWORK_MAX_RESULTS + 1),
  TotalRecordCount: z.int().nonnegative().optional(),
});

const attentionInputSchema = z.strictObject({
  limit: z.int().positive().max(LIBRARY_ATTENTION_MAX_ITEMS),
  startIndex: z.int().nonnegative().max(MAX_LIBRARY_SCAN_OFFSET),
});

const metadataPatchSchema = z
  .strictObject({
    overview: z.union([safeTextSchema.max(2_000), z.null()]).optional(),
    title: safeTextSchema.max(300).optional(),
    year: z.int().min(1870).max(2200).nullable().optional(),
  })
  .refine(
    (patch) =>
      patch.overview !== undefined || patch.title !== undefined || patch.year !== undefined,
  );

const refreshInputSchema = z.strictObject({
  imageMode: z.enum(["missing", "replace"]),
  itemId: identifierSchema,
  metadataMode: z.enum(["missing", "replace"]),
});

export interface JellyfinLibraryAttentionItem {
  artwork: { poster: { itemId: string; type: "Primary" } | null };
  externalId: string;
  identityState: "identified" | "unmatched";
  issues: LibraryAttentionIssue[];
  kind: "movie" | "series";
  overview: string | null;
  title: string;
  year: number | null;
}

export interface JellyfinLibraryAttentionResult {
  items: JellyfinLibraryAttentionItem[];
  nextStartIndex: number | null;
  scanned: number;
  truncated: boolean;
}

export interface JellyfinRemoteArtworkCandidate {
  communityRating: number | null;
  height: number | null;
  imageUrl: string;
  language: string | null;
  previewUrl: string;
  providerName: string;
  voteCount: number | null;
  width: number | null;
}

export interface JellyfinRemoteImageResult {
  body: Uint8Array;
  contentType: "image/avif" | "image/jpeg" | "image/png" | "image/webp";
}

export interface JellyfinLibraryMetadataState {
  overview: string | null;
  title: string;
  year: number | null;
}

export interface JellyfinLibraryClientOptions {
  accessToken: string;
  deviceId: string;
  metadata?: JellyfinClientMetadata;
  target: ConnectorTargetConfig;
}

function compactText(value: string | null | undefined, maxLength: number) {
  if (!value) return null;
  const compacted = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (!compacted) return null;
  return compacted.length <= maxLength ? compacted : compacted.slice(0, maxLength).trimEnd();
}

function safeRemoteUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    url.pathname === "/"
  ) {
    return null;
  }
  return url;
}

function attentionIssues(item: z.infer<typeof attentionItemSchema>): LibraryAttentionIssue[] {
  const hasIdentity = Object.values(item.ProviderIds ?? {}).some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  return [
    hasIdentity ? null : "missing_identity",
    compactText(item.Overview, 2_000) ? null : "missing_overview",
    item.ImageTags?.Primary ? null : "missing_poster",
    item.ProductionYear ? null : "missing_year",
  ].filter((issue): issue is LibraryAttentionIssue => issue !== null);
}

function imageType(kind: LibraryArtworkKind) {
  return kind === "poster" ? "Primary" : "Backdrop";
}

export class JellyfinLibraryClient {
  readonly #authorization: string;
  readonly #client: SafeHttpClient;
  readonly #target: ConnectorTargetConfig;

  public constructor(options: JellyfinLibraryClientOptions) {
    const metadata = jellyfinClientMetadata(options.metadata);
    this.#authorization = jellyfinAuthorization({
      accessToken: options.accessToken,
      deviceId: options.deviceId,
      metadata,
    });
    this.#target = options.target;
    const target = options.target;
    this.#client = new SafeHttpClient({
      allowInsecureHttp: target.insecureHttpApproved ?? false,
      baseUrl: target.baseUrl,
      maxResponseBytes: MAX_UPSTREAM_ITEM_BYTES,
      ...(target.resolveHost === undefined ? {} : { resolveHost: target.resolveHost }),
      service: "jellyfin",
      ...(target.timeoutMs === undefined ? {} : { timeoutMs: target.timeoutMs }),
      ...(target.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: target.tlsCaCertificatePem }),
      ...(target.tlsPolicy === undefined ? {} : { tlsPolicy: target.tlsPolicy }),
      ...(target.transport === undefined ? {} : { transport: target.transport }),
      ...(target.lane === undefined ? {} : { lane: target.lane }),
    });
  }

  public async listAttentionItems(
    input: { limit: number; startIndex: number },
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryAttentionResult> {
    const parsedInput = attentionInputSchema.parse(input);
    const response = await this.#client.requestJson("Items", attentionResponseSchema, {
      headers: { authorization: this.#authorization },
      operation: "library.attention",
      query: {
        enableImageTypes: "Primary",
        enableTotalRecordCount: "true",
        fields: "Overview,ProviderIds,ProductionYear",
        imageTypeLimit: "1",
        includeItemTypes: "Movie,Series",
        limit: String(parsedInput.limit + 1),
        recursive: "true",
        sortBy: "DateCreated,SortName",
        sortOrder: "Descending,Ascending",
        startIndex: String(parsedInput.startIndex),
      },
      ...(signal === undefined ? {} : { signal }),
    });

    const scannedItems = response.Items.slice(0, parsedInput.limit);
    const nextStartIndex = parsedInput.startIndex + scannedItems.length;
    const truncated =
      response.Items.length > parsedInput.limit ||
      nextStartIndex < (response.TotalRecordCount ?? nextStartIndex);
    const items = scannedItems.flatMap((item) => {
      const issues = attentionIssues(item);
      if (issues.length === 0) return [];
      return [
        {
          artwork: {
            poster: item.ImageTags?.Primary
              ? ({ itemId: item.Id, type: "Primary" } as const)
              : null,
          },
          externalId: item.Id,
          identityState: issues.includes("missing_identity")
            ? ("unmatched" as const)
            : ("identified" as const),
          issues,
          kind: item.Type === "Movie" ? ("movie" as const) : ("series" as const),
          overview: compactText(item.Overview, 2_000),
          title: item.Name,
          year: item.ProductionYear ?? null,
        },
      ];
    });
    return {
      items,
      nextStartIndex: truncated ? nextStartIndex : null,
      scanned: scannedItems.length,
      truncated,
    };
  }

  public async scanLibrary(signal?: AbortSignal): Promise<void> {
    await this.#client.requestBytes("Library/Refresh", {
      acceptedStatuses: [204],
      headers: { authorization: this.#authorization },
      method: "POST",
      operation: "library.scan",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async refreshItem(
    input: {
      imageMode: "missing" | "replace";
      itemId: string;
      metadataMode: "missing" | "replace";
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const parsedInput = refreshInputSchema.parse(input);
    await this.#client.requestBytes(`Items/${parsedInput.itemId}/Refresh`, {
      acceptedStatuses: [204],
      headers: { authorization: this.#authorization },
      method: "POST",
      operation: "library.item.refresh",
      query: {
        imageRefreshMode: parsedInput.imageMode === "replace" ? "FullRefresh" : "Default",
        metadataRefreshMode: parsedInput.metadataMode === "replace" ? "FullRefresh" : "Default",
        regenerateTrickplay: "false",
        replaceAllImages: String(parsedInput.imageMode === "replace"),
        replaceAllMetadata: String(parsedInput.metadataMode === "replace"),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async updateMetadata(
    itemId: string,
    patch: { overview?: string | null; title?: string; year?: number | null },
    signal?: AbortSignal,
  ): Promise<void> {
    const safeItemId = identifierSchema.parse(itemId);
    const safePatch = metadataPatchSchema.parse(patch);
    const current = await this.#client.requestJson(`Items/${safeItemId}`, editableItemSchema, {
      headers: { authorization: this.#authorization },
      operation: "library.item.read",
      ...(signal === undefined ? {} : { signal }),
    });
    if (current.Id !== safeItemId) throw this.#client.invalidResponse("library.item.read");
    const next = {
      ...current,
      ...(safePatch.overview === undefined ? {} : { Overview: safePatch.overview }),
      ...(safePatch.title === undefined ? {} : { Name: safePatch.title }),
      ...(safePatch.year === undefined ? {} : { ProductionYear: safePatch.year }),
    };
    await this.#client.requestBytes(`Items/${safeItemId}`, {
      acceptedStatuses: [204],
      body: JSON.stringify(next),
      headers: {
        authorization: this.#authorization,
        "content-type": "application/json",
      },
      method: "POST",
      operation: "library.item.update",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async readMetadata(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<JellyfinLibraryMetadataState> {
    const safeItemId = identifierSchema.parse(itemId);
    const current = await this.#client.requestJson(`Items/${safeItemId}`, editableItemSchema, {
      headers: { authorization: this.#authorization },
      operation: "library.item.read",
      ...(signal === undefined ? {} : { signal }),
    });
    if (current.Id !== safeItemId) throw this.#client.invalidResponse("library.item.read");
    return {
      overview: current.Overview ?? null,
      title: current.Name,
      year: current.ProductionYear ?? null,
    };
  }

  public async searchRemoteArtwork(
    itemId: string,
    input: { includeAllLanguages: boolean; kind: LibraryArtworkKind },
    signal?: AbortSignal,
  ): Promise<JellyfinRemoteArtworkCandidate[]> {
    const safeItemId = identifierSchema.parse(itemId);
    const type = imageType(input.kind);
    const response = await this.#client.requestJson(
      `Items/${safeItemId}/RemoteImages`,
      remoteImageResponseSchema,
      {
        headers: { authorization: this.#authorization },
        operation: "library.artwork.search",
        query: {
          includeAllLanguages: String(input.includeAllLanguages),
          limit: String(LIBRARY_ARTWORK_MAX_RESULTS + 1),
          startIndex: "0",
          type,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.Images.length > LIBRARY_ARTWORK_MAX_RESULTS) {
      throw this.#client.invalidResponse("library.artwork.search");
    }
    return response.Images.flatMap((image) => {
      if (image.Type !== type) return [];
      const imageUrl = safeRemoteUrl(image.Url);
      const previewUrl = safeRemoteUrl(image.ThumbnailUrl ?? image.Url);
      if (!imageUrl || !previewUrl) return [];
      return [
        {
          communityRating: image.CommunityRating ?? null,
          height: image.Height ?? null,
          imageUrl: imageUrl.href,
          language: compactText(image.Language, 80),
          previewUrl: previewUrl.href,
          providerName: image.ProviderName,
          voteCount: image.VoteCount ?? null,
          width: image.Width ?? null,
        },
      ];
    });
  }

  public async readRemoteArtwork(
    previewUrl: string,
    signal?: AbortSignal,
  ): Promise<JellyfinRemoteImageResult> {
    const url = safeRemoteUrl(previewUrl);
    if (!url) throw this.#client.invalidResponse("library.artwork.preview");
    const remoteClient = new SafeHttpClient({
      baseUrl: `${url.origin}/`,
      maxResponseBytes: MAX_REMOTE_IMAGE_BYTES,
      ...(this.#target.resolveHost === undefined ? {} : { resolveHost: this.#target.resolveHost }),
      service: "jellyfin",
      ...(this.#target.timeoutMs === undefined ? {} : { timeoutMs: this.#target.timeoutMs }),
      ...(this.#target.transport === undefined ? {} : { transport: this.#target.transport }),
      ...(this.#target.lane === undefined ? {} : { lane: this.#target.lane }),
    });
    const response = await remoteClient.requestBytes(url.pathname.slice(1), {
      headers: { accept: "image/avif,image/webp,image/jpeg,image/png" },
      operation: "library.artwork.preview",
      query: url.searchParams,
      ...(signal === undefined ? {} : { signal }),
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
      throw remoteClient.invalidResponse("library.artwork.preview");
    }
    if (response.body.byteLength === 0) {
      throw remoteClient.invalidResponse("library.artwork.preview");
    }
    return { body: response.body, contentType };
  }

  public async applyRemoteArtwork(
    itemId: string,
    kind: LibraryArtworkKind,
    imageUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const safeItemId = identifierSchema.parse(itemId);
    const url = safeRemoteUrl(imageUrl);
    if (!url) throw this.#client.invalidResponse("library.artwork.apply");
    await this.#client.requestBytes(`Items/${safeItemId}/RemoteImages/Download`, {
      acceptedStatuses: [204],
      headers: { authorization: this.#authorization },
      method: "POST",
      operation: "library.artwork.apply",
      query: { imageUrl: url.href, type: imageType(kind) },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
