import { describe, expect, it } from "vitest";

import {
  libraryArtworkSearchResponseSchema,
  libraryAttentionQuerySchema,
  libraryAttentionResponseJsonSchema,
  libraryAttentionResponseSchema,
  libraryBrowseQueryJsonSchema,
  libraryBrowseQuerySchema,
  libraryBrowseResponseJsonSchema,
  libraryBrowseResponseSchema,
  libraryDownloadPrepareRequestJsonSchema,
  libraryDownloadPrepareRequestSchema,
  libraryDownloadPrepareResponseJsonSchema,
  libraryDownloadPrepareResponseSchema,
  libraryExtrasQueryJsonSchema,
  libraryExtrasQuerySchema,
  libraryExtrasResponseJsonSchema,
  libraryExtrasResponseSchema,
  libraryItemRefreshRequestSchema,
  libraryMetadataUpdateRequestSchema,
  libraryMutationResponseSchema,
  libraryPlaybackStateMutationRequestJsonSchema,
  libraryPlaybackStateMutationRequestSchema,
  libraryPlaybackStateMutationResponseJsonSchema,
  libraryPlaybackStateMutationResponseSchema,
  libraryRemovalCommitRequestJsonSchema,
  libraryRemovalCommitRequestSchema,
  libraryRemovalOperationJsonSchema,
  libraryRemovalOperationSchema,
  libraryRemovalPreviewJsonSchema,
  libraryRemovalPreviewSchema,
  librarySeasonEpisodesQueryJsonSchema,
  librarySeasonEpisodesQuerySchema,
  librarySeasonEpisodesResponseJsonSchema,
  librarySeasonEpisodesResponseSchema,
  libraryTitleDetailResponseJsonSchema,
  libraryTitleDetailResponseSchema,
  viewingHistoryCursorSchema,
  viewingHistoryQueryJsonSchema,
  viewingHistoryQuerySchema,
  viewingHistoryResponseJsonSchema,
  viewingHistoryResponseSchema,
} from "../src/library.js";

const referenceId = `media_${"m".repeat(22)}`;
const searchId = `library_artwork_search_${"s".repeat(22)}`;
const resultId = `library_artwork_result_${"r".repeat(22)}`;
const downloadGrantId = `media_download_${"d".repeat(22)}`;
const removalPreviewId = `library_removal_preview_${"d".repeat(22)}`;
const removalOperationId = `library_removal_operation_${"e".repeat(22)}`;

const attention = {
  generatedAt: "2026-07-28T14:00:00.000Z",
  items: [
    {
      identityState: "unmatched" as const,
      issues: ["missing_identity", "missing_overview", "missing_poster"] as const,
      kind: "movie" as const,
      overview: null,
      posterPath: null,
      referenceId,
      title: "The Far Meridian",
      year: 2026,
    },
  ],
  nextCursor: "bGlicmFyeQ.c2lnbmF0dXJl",
  scanned: 30,
  truncated: true,
};

const catalogue = {
  generatedAt: "2026-07-28T14:00:00.000Z",
  items: [
    {
      media: {
        artwork: {
          accentColor: "#336699",
          backdropPath: `/v1/media/${referenceId}/images/backdrop`,
          blurHash: "005?}k",
          posterPath: `/v1/media/${referenceId}/images/poster`,
        },
        availability: "available" as const,
        contentRating: "TV-14",
        id: referenceId,
        kind: "movie" as const,
        overview: "A receiver resolves a signal beyond the ice.",
        runtimeMinutes: 45,
        subtitle: null,
        title: "The Long Meridian",
        year: 2026,
      },
      playback: { durationSeconds: 2_700, played: false, positionSeconds: 900 },
    },
  ],
  nextCursor: "bGlicmFyeQ.c2lnbmF0dXJl",
  source: { displayName: "Home Jellyfin", failure: null, status: "healthy" as const },
  state: "complete" as const,
};

describe("library operation contracts", () => {
  it("binds short-lived original-download grants to one opaque library title", () => {
    expect(libraryDownloadPrepareRequestSchema.parse({})).toEqual({});
    expect(
      libraryDownloadPrepareRequestSchema.safeParse({ itemId: "private-upstream" }).success,
    ).toBe(false);

    const prepared = {
      archiveRetrieval: "unknown" as const,
      contentType: "video/x-matroska",
      expiresAt: "2026-07-28T14:02:00.000Z",
      filename: "The Long Meridian (2026).mkv",
      generatedAt: "2026-07-28T14:00:00.000Z",
      grantId: downloadGrantId,
      path: `/v1/media/library/downloads/${downloadGrantId}`,
      referenceId,
      sizeBytes: 6_979_321_856,
    };
    expect(libraryDownloadPrepareResponseSchema.parse(prepared)).toEqual(prepared);
    expect(JSON.stringify(prepared)).not.toMatch(/jellyfin|upstream|\/private\//iu);
    expect(
      libraryDownloadPrepareResponseSchema.safeParse({
        ...prepared,
        path: `/v1/media/library/downloads/media_download_${"x".repeat(22)}`,
      }).success,
    ).toBe(false);
    expect(
      libraryDownloadPrepareResponseSchema.safeParse({
        ...prepared,
        expiresAt: prepared.generatedAt,
      }).success,
    ).toBe(false);
    expect(
      libraryDownloadPrepareResponseSchema.safeParse({
        ...prepared,
        filename: "unsafe\r\nname.mkv",
      }).success,
    ).toBe(false);
    expect(libraryDownloadPrepareRequestJsonSchema).toMatchObject({ type: "object" });
    expect(libraryDownloadPrepareResponseJsonSchema).toMatchObject({ type: "object" });
  });

  it("normalizes attention items without paths or upstream identifiers", () => {
    expect(libraryAttentionResponseSchema.parse(attention)).toEqual(attention);
    expect(JSON.stringify(attention)).not.toMatch(/\/media\/|upstream|providerId/iu);
  });

  it("requires attention state, issue order, and poster references to agree", () => {
    expect(
      libraryAttentionResponseSchema.safeParse({
        ...attention,
        items: [{ ...attention.items[0], identityState: "identified" }],
      }).success,
    ).toBe(false);
    expect(
      libraryAttentionResponseSchema.safeParse({
        ...attention,
        items: [
          {
            ...attention.items[0],
            issues: ["missing_poster", "missing_identity", "missing_overview"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryAttentionResponseSchema.safeParse({
        ...attention,
        items: [
          {
            ...attention.items[0],
            issues: ["missing_identity", "missing_overview"],
            posterPath: "https://jellyfin.example/Items/upstream/Images/Primary",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("coerces bounded paging and defaults safe refresh modes", () => {
    expect(libraryAttentionQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(libraryAttentionQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(libraryItemRefreshRequestSchema.parse({})).toEqual({
      imageMode: "missing",
      metadataMode: "missing",
    });
  });

  it("normalizes a title-level paired-user catalogue with opaque references", () => {
    expect(libraryBrowseResponseSchema.parse(catalogue)).toEqual(catalogue);
    expect(JSON.stringify(catalogue)).not.toMatch(/external|jellyfin\.example|upstream/iu);
    expect(libraryBrowseQuerySchema.parse({ limit: "25" })).toEqual({
      kind: "all",
      limit: 25,
      sort: "recent",
    });
    expect(
      libraryBrowseQuerySchema.parse({ kind: "series", query: "  Meridian  ", sort: "title" }),
    ).toEqual({ kind: "series", limit: 30, query: "Meridian", sort: "title" });
    expect(libraryBrowseQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });

  it("models explicit, user-scoped playback-state commands", () => {
    expect(libraryPlaybackStateMutationRequestSchema.parse({ action: "reset_progress" })).toEqual({
      action: "reset_progress",
    });
    expect(
      libraryPlaybackStateMutationRequestSchema.safeParse({
        action: "mark_watched",
        externalUserId: "jellyfin-user-1",
      }).success,
    ).toBe(false);
    const response = {
      action: "mark_unwatched" as const,
      playback: { durationSeconds: 2_700, played: false, positionSeconds: 0 },
      referenceId,
      updatedAt: catalogue.generatedAt,
    };
    expect(libraryPlaybackStateMutationResponseSchema.parse(response)).toEqual(response);
    for (const invalid of [
      { action: "mark_watched", playback: { ...response.playback, played: false } },
      { action: "mark_unwatched", playback: { ...response.playback, positionSeconds: 10 } },
      { action: "reset_progress", playback: { ...response.playback, positionSeconds: 10 } },
    ]) {
      expect(
        libraryPlaybackStateMutationResponseSchema.safeParse({
          ...response,
          ...invalid,
        }).success,
      ).toBe(false);
    }
    expect(JSON.stringify(response)).not.toMatch(/external|jellyfin\.example|upstream/iu);
  });

  it("models private, bounded, filterable viewing history with opaque references", () => {
    const history = {
      generatedAt: catalogue.generatedAt,
      items: [
        {
          activity: "in_progress" as const,
          lastPlayedAt: "2026-07-28T13:00:00.000Z",
          media: catalogue.items[0]!.media,
          playback: catalogue.items[0]!.playback!,
        },
      ],
      nextCursor: "aGlzdG9yeQ.c2lnbmF0dXJl",
      source: { displayName: "Home Jellyfin", failure: null, status: "healthy" as const },
      state: "complete" as const,
    };
    expect(viewingHistoryResponseSchema.parse(history)).toEqual(history);
    expect(
      viewingHistoryQuerySchema.parse({ kind: "episodes", limit: "20", range: "90_days" }),
    ).toEqual({ kind: "episodes", limit: 20, range: "90_days", state: "all" });
    expect(viewingHistoryQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(viewingHistoryCursorSchema.safeParse("c".repeat(1_024)).success).toBe(true);
    expect(viewingHistoryCursorSchema.safeParse("c".repeat(1_025)).success).toBe(false);
    expect(
      viewingHistoryResponseSchema.safeParse({
        generatedAt: catalogue.generatedAt,
        items: [],
        nextCursor: null,
        source: {
          displayName: "Home Jellyfin",
          failure: {
            code: "upstream_error",
            message: "Viewing history references are temporarily unavailable.",
            occurredAt: catalogue.generatedAt,
            operation: "media.reference",
            retryable: true,
            service: "jellyfin",
          },
          status: "unavailable",
        },
        state: "unavailable",
      }).success,
    ).toBe(true);
    expect(JSON.stringify(history)).not.toMatch(/external|jellyfin\.example|upstream/iu);
  });

  it("rejects viewing activity that disagrees with current Jellyfin state", () => {
    const base = {
      activity: "completed" as const,
      lastPlayedAt: catalogue.generatedAt,
      media: catalogue.items[0]!.media,
      playback: { durationSeconds: 2_700, played: true, positionSeconds: 0 },
    };
    expect(
      viewingHistoryResponseSchema.safeParse({
        generatedAt: catalogue.generatedAt,
        items: [{ ...base, playback: { ...base.playback, played: false } }],
        nextCursor: null,
        source: { displayName: "Home Jellyfin", failure: null, status: "healthy" },
        state: "complete",
      }).success,
    ).toBe(false);
    expect(
      viewingHistoryResponseSchema.safeParse({
        generatedAt: catalogue.generatedAt,
        items: [{ ...base, media: { ...base.media, kind: "series" } }],
        nextCursor: null,
        source: { displayName: "Home Jellyfin", failure: null, status: "healthy" },
        state: "complete",
      }).success,
    ).toBe(false);
  });

  it("rejects mismatched playback, cross-reference, or inconsistent catalogue state", () => {
    const item = catalogue.items[0]!;

    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [
          {
            ...item,
            media: { ...item.media, kind: "series" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [
          {
            ...item,
            media: {
              ...item.media,
              artwork: {
                ...item.media.artwork,
                posterPath: `/v1/media/media_${"z".repeat(22)}/images/poster`,
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [],
        nextCursor: null,
        state: "complete",
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [],
        nextCursor: null,
        source: {
          displayName: "Home Jellyfin",
          failure: null,
          status: "unavailable",
        },
        state: "unavailable",
      }).success,
    ).toBe(false);
    expect(
      libraryBrowseResponseSchema.safeParse({
        ...catalogue,
        items: [],
        nextCursor: null,
        source: {
          displayName: "Home Jellyfin",
          failure: {
            code: "upstream_error",
            message: "The source is unavailable.",
            occurredAt: catalogue.generatedAt,
            operation: "media.continue_watching",
            retryable: true,
            service: "jellyfin",
          },
          status: "unavailable",
        },
        state: "unavailable",
      }).success,
    ).toBe(false);
  });

  it("models series details and bounded season episode pages without upstream identity", () => {
    const seriesReferenceId = `media_${"s".repeat(22)}`;
    const episodeReferenceId = `media_${"e".repeat(22)}`;
    const seriesMedia = {
      ...catalogue.items[0]!.media,
      artwork: {
        ...catalogue.items[0]!.media.artwork,
        backdropPath: `/v1/media/${seriesReferenceId}/images/backdrop`,
        posterPath: `/v1/media/${seriesReferenceId}/images/poster`,
      },
      id: seriesReferenceId,
      kind: "series" as const,
      runtimeMinutes: null,
      title: "Northern Lights",
    };
    const season = {
      episodeCount: 8,
      playedEpisodeCount: 3,
      seasonNumber: 2,
      title: "Season 2",
    };
    const detail = {
      generatedAt: catalogue.generatedAt,
      media: seriesMedia,
      movie: null,
      playback: null,
      seasons: [season],
      seasonsTruncated: false,
    };
    expect(libraryTitleDetailResponseSchema.parse(detail)).toEqual(detail);

    const episodes = {
      generatedAt: catalogue.generatedAt,
      items: [
        {
          airDate: "2025-02-14",
          communityRating: 8.4,
          credits: [
            { name: "Mara Voss", role: "Dr. Elian Vale", type: "cast" as const },
            { name: "Ari Chen", role: null, type: "writer" as const },
          ],
          creditsTruncated: false,
          criticRating: 91,
          genres: ["Drama", "Science fiction"],
          media: {
            ...catalogue.items[0]!.media,
            artwork: {
              ...catalogue.items[0]!.media.artwork,
              backdropPath: `/v1/media/${episodeReferenceId}/images/backdrop`,
              posterPath: `/v1/media/${episodeReferenceId}/images/poster`,
            },
            id: episodeReferenceId,
            kind: "episode" as const,
            subtitle: "S02E03",
            title: "The Long Meridian",
          },
          playback: { durationSeconds: 2_700, played: false, positionSeconds: 900 },
          studios: ["Northlight Pictures"],
        },
      ],
      nextCursor: "bGlicmFyeQ.c2lnbmF0dXJl",
      seasonNumber: 2,
      titleReferenceId: seriesReferenceId,
    };
    expect(librarySeasonEpisodesResponseSchema.parse(episodes)).toEqual(episodes);
    expect(librarySeasonEpisodesQuerySchema.parse({ limit: "20" })).toEqual({ limit: 20 });
    expect(JSON.stringify({ detail, episodes })).not.toMatch(
      /external|jellyfin\.example|upstream/iu,
    );
  });

  it("models bounded local and reviewed online extras without exposing upstream identity", () => {
    const extraReferenceId = `media_${"x".repeat(22)}`;
    const response = {
      generatedAt: catalogue.generatedAt,
      items: [
        {
          extraType: "behind_the_scenes" as const,
          media: {
            ...catalogue.items[0]!.media,
            artwork: {
              ...catalogue.items[0]!.media.artwork,
              backdropPath: `/v1/media/${extraReferenceId}/images/backdrop`,
              posterPath: `/v1/media/${extraReferenceId}/images/poster`,
            },
            id: extraReferenceId,
            kind: "other" as const,
            subtitle: "Local extra",
            title: "Building the Meridian",
          },
          playback: { durationSeconds: 720, played: false, positionSeconds: 120 },
          source: "local" as const,
        },
      ],
      nextCursor: "ZXh0cmFz.c2lnbmF0dXJl",
      onlineItems: [
        {
          id: "youtube:QdBZY2fkU-0",
          provider: "youtube" as const,
          resolution: 2160,
          title: "Official trailer",
          type: "trailer" as const,
        },
      ],
      onlineSource: {
        displayName: "Seerr",
        failure: null,
        status: "healthy" as const,
      },
      onlineState: "ready" as const,
      parentReferenceId: referenceId,
      source: { displayName: "Home Jellyfin", failure: null, status: "healthy" as const },
      state: "complete" as const,
    };

    expect(libraryExtrasResponseSchema.parse(response)).toEqual(response);
    expect(libraryExtrasQuerySchema.parse({ limit: "12" })).toEqual({ limit: 12 });
    expect(libraryExtrasQuerySchema.safeParse({ limit: 25 }).success).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(/external|jellyfin\.example|upstream|itemId/iu);
    expect(
      libraryExtrasResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            media: { ...response.items[0]!.media, id: referenceId },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryExtrasResponseSchema.safeParse({
        ...response,
        onlineItems: [{ ...response.onlineItems[0], id: "vimeo:unreviewed" }],
      }).success,
    ).toBe(false);
  });

  it("models rich owned-movie facts without accepting cross-reference person artwork", () => {
    const media = catalogue.items[0]!.media;
    const detail = {
      generatedAt: catalogue.generatedAt,
      media,
      movie: {
        cast: [
          {
            imagePath: `/v1/media/${media.id}/images/people/${"p".repeat(64)}`,
            name: "Mara Voss",
            role: "Iris Vale",
            type: "cast" as const,
          },
        ],
        castTruncated: false,
        communityRating: 8.4,
        crew: [{ imagePath: null, name: "Jon Bell", role: null, type: "director" as const }],
        crewTruncated: false,
        criticRating: 91,
        genres: ["Drama", "Science fiction"],
        mediaSources: [
          {
            audio: [
              {
                bitrateKbps: 640,
                channels: 6,
                codec: "E-AC-3",
                language: "English",
                title: "English 5.1",
              },
            ],
            audioTruncated: false,
            bitrateKbps: 9_250,
            container: "MKV",
            label: "4K · HEVC · MKV",
            sizeBytes: 6_979_321_856,
            subtitles: [
              {
                codec: "SUBRIP",
                default: true,
                forced: false,
                language: "English",
                title: null,
              },
            ],
            subtitlesTruncated: false,
            video: {
              bitrateKbps: 8_700,
              bitDepth: 10,
              codec: "HEVC",
              hdrFormat: "HDR10",
              height: 1_606,
              profile: "Main 10",
              width: 3_840,
            },
          },
        ],
        mediaSourcesTruncated: false,
        premiereDate: "2026-04-18",
        studios: ["Northlight Pictures"],
        tagline: "The horizon remembers.",
      },
      playback: catalogue.items[0]!.playback,
      seasons: [],
      seasonsTruncated: false,
    };
    expect(libraryTitleDetailResponseSchema.parse(detail)).toEqual(detail);
    expect(JSON.stringify(detail)).not.toMatch(/jellyfin|upstream|\/private\//iu);
    expect(
      libraryTitleDetailResponseSchema.safeParse({
        ...detail,
        movie: {
          ...detail.movie,
          cast: [
            {
              ...detail.movie.cast[0],
              imagePath: `/v1/media/media_${"x".repeat(22)}/images/people/private`,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires a bounded editable metadata field", () => {
    expect(libraryMetadataUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      libraryMetadataUpdateRequestSchema.parse({ overview: null, title: "The Far Meridian" }),
    ).toEqual({ overview: null, title: "The Far Meridian" });
    expect(libraryMetadataUpdateRequestSchema.safeParse({ path: "/private/media" }).success).toBe(
      false,
    );
  });

  it("accepts an asynchronous mutation receipt", () => {
    expect(
      libraryMutationResponseSchema.parse({
        acceptedAt: "2026-07-28T14:02:00.000Z",
        operationId: `library_operation_${"o".repeat(22)}`,
        referenceId,
        state: "accepted",
      }).state,
    ).toBe("accepted");
  });

  it("models a short-lived managed-movie removal preview without upstream identity", () => {
    const commonEffects = {
      organizedFiles: "deleted" as const,
      requestHistory: "retained" as const,
      seedingCopies: "unchanged" as const,
      storageReclamation: "may_be_delayed" as const,
    };
    const preview = {
      confirmation: {
        expectedTitle: "The Long Meridian",
        kind: "exact_title" as const,
        recentAuthenticationRequired: true as const,
      },
      expiresAt: "2026-07-28T14:05:00.000Z",
      generatedAt: "2026-07-28T14:00:00.000Z",
      options: [
        {
          effects: {
            ...commonEffects,
            managerRecord: "retained" as const,
            monitoring: "monitored" as const,
            reacquisitionRisk: "possible" as const,
          },
          mode: "delete_files_keep_monitored" as const,
        },
        {
          effects: {
            ...commonEffects,
            managerRecord: "retained" as const,
            monitoring: "unmonitored" as const,
            reacquisitionRisk: "prevented" as const,
          },
          mode: "delete_files_and_unmonitor" as const,
        },
        {
          effects: {
            ...commonEffects,
            managerRecord: "removed" as const,
            monitoring: "removed" as const,
            reacquisitionRisk: "prevented" as const,
          },
          mode: "remove_from_radarr_and_delete_files" as const,
        },
      ],
      previewId: removalPreviewId,
      referenceId,
      sizeBytes: 6_979_321_856,
      source: { kind: "managed" as const, monitored: true, service: "radarr" as const },
      title: "The Long Meridian",
      year: 2026,
    };

    expect(libraryRemovalPreviewSchema.parse(preview)).toEqual(preview);
    expect(JSON.stringify(preview)).not.toMatch(/\/private\/|externalId|upstream|connectorUrl/iu);
    expect(
      libraryRemovalPreviewSchema.safeParse({
        ...preview,
        options: [
          {
            ...preview.options[0],
            effects: { ...preview.options[0]!.effects, reacquisitionRisk: "prevented" },
          },
          ...preview.options.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it("limits unmanaged removal previews to a Jellyfin-authorized file operation", () => {
    const preview = {
      confirmation: {
        expectedTitle: "The Long Meridian",
        kind: "exact_title" as const,
        recentAuthenticationRequired: true as const,
      },
      expiresAt: "2026-07-28T14:05:00.000Z",
      generatedAt: "2026-07-28T14:00:00.000Z",
      options: [
        {
          effects: {
            managerRecord: "not_applicable" as const,
            monitoring: "not_applicable" as const,
            organizedFiles: "deleted" as const,
            reacquisitionRisk: "not_managed" as const,
            requestHistory: "retained" as const,
            seedingCopies: "unchanged" as const,
            storageReclamation: "may_be_delayed" as const,
          },
          mode: "delete_unmanaged_files" as const,
        },
      ],
      previewId: removalPreviewId,
      referenceId,
      sizeBytes: null,
      source: { kind: "unmanaged" as const, monitored: null, service: "jellyfin" as const },
      title: "The Long Meridian",
      year: null,
    };

    expect(libraryRemovalPreviewSchema.parse(preview)).toEqual(preview);
    expect(
      libraryRemovalPreviewSchema.safeParse({
        ...preview,
        options: [
          {
            ...preview.options[0],
            mode: "remove_from_radarr_and_delete_files",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("binds a destructive removal commit to one exact preview and typed title", () => {
    const request = {
      confirmationTitle: "The Long Meridian",
      mode: "delete_files_and_unmonitor" as const,
      previewId: removalPreviewId,
    };

    expect(libraryRemovalCommitRequestSchema.parse(request)).toEqual(request);
    expect(
      libraryRemovalCommitRequestSchema.safeParse({
        ...request,
        connectorId: "radarr-primary",
        itemId: "upstream-movie-id",
      }).success,
    ).toBe(false);
  });

  it("reports a completed removal without exposing its private execution coordinates", () => {
    const operation = {
      completedAt: "2026-07-28T14:01:08.000Z",
      mode: "delete_files_and_unmonitor" as const,
      operationId: removalOperationId,
      previewId: removalPreviewId,
      referenceId,
      stages: [
        { kind: "authorization_recheck" as const, state: "succeeded" as const },
        { kind: "source_revalidation" as const, state: "succeeded" as const },
        { kind: "monitoring_change" as const, state: "succeeded" as const },
        { kind: "organized_file_deletion" as const, state: "succeeded" as const },
        { kind: "manager_record_removal" as const, state: "not_applicable" as const },
        { kind: "jellyfin_reconciliation" as const, state: "succeeded" as const },
      ],
      startedAt: "2026-07-28T14:01:00.000Z",
      state: "succeeded" as const,
    };

    expect(libraryRemovalOperationSchema.parse(operation)).toEqual(operation);
    expect(JSON.stringify(operation)).not.toMatch(/path|external|connector|upstream|title/iu);
    expect(
      libraryRemovalOperationSchema.safeParse({
        ...operation,
        stages: operation.stages.map((stage) =>
          stage.kind === "organized_file_deletion" ? { ...stage, state: "uncertain" } : stage,
        ),
      }).success,
    ).toBe(false);
  });

  it("preserves uncertain destructive outcomes for explicit reconciliation", () => {
    const operation = {
      completedAt: "2026-07-28T14:01:08.000Z",
      failureCode: "outcome_unknown" as const,
      mode: "remove_from_radarr_and_delete_files" as const,
      operationId: removalOperationId,
      previewId: removalPreviewId,
      referenceId,
      stages: [
        { kind: "authorization_recheck" as const, state: "succeeded" as const },
        { kind: "source_revalidation" as const, state: "succeeded" as const },
        { kind: "monitoring_change" as const, state: "not_applicable" as const },
        { kind: "organized_file_deletion" as const, state: "uncertain" as const },
        { kind: "manager_record_removal" as const, state: "uncertain" as const },
        { kind: "jellyfin_reconciliation" as const, state: "pending" as const },
      ],
      startedAt: "2026-07-28T14:01:00.000Z",
      state: "reconcile_required" as const,
    };

    expect(libraryRemovalOperationSchema.parse(operation)).toEqual(operation);
    expect(
      libraryRemovalOperationSchema.safeParse({
        ...operation,
        completedAt: null,
      }).success,
    ).toBe(false);
  });

  it("binds opaque artwork previews to their short-lived search", () => {
    const response = {
      expiresAt: "2026-07-28T14:20:00.000Z",
      generatedAt: "2026-07-28T14:00:00.000Z",
      kind: "poster" as const,
      referenceId,
      results: [
        {
          communityRating: 8.4,
          height: 3_000,
          id: resultId,
          language: "en",
          previewPath: `/v1/library/artwork-searches/${searchId}/results/${resultId}/preview`,
          providerName: "TMDb",
          voteCount: 412,
          width: 2_000,
        },
      ],
      searchId,
    };
    expect(libraryArtworkSearchResponseSchema.parse(response)).toEqual(response);
    expect(
      libraryArtworkSearchResponseSchema.safeParse({
        ...response,
        results: [{ ...response.results[0], previewPath: "https://image.tmdb.org/private" }],
      }).success,
    ).toBe(false);
  });

  it("exports Fastify-compatible response schema", () => {
    expect(libraryAttentionResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryAttentionResponseJsonSchema).toMatchObject({ type: "object" });
    expect(libraryBrowseQueryJsonSchema).not.toHaveProperty("$schema");
    expect(libraryBrowseQueryJsonSchema).toMatchObject({ type: "object" });
    expect(libraryBrowseResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryBrowseResponseJsonSchema).toMatchObject({ type: "object" });
    expect(libraryPlaybackStateMutationRequestJsonSchema).not.toHaveProperty("$schema");
    expect(libraryPlaybackStateMutationResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryRemovalPreviewJsonSchema).not.toHaveProperty("$schema");
    expect(libraryRemovalPreviewJsonSchema).toMatchObject({ type: "object" });
    expect(libraryRemovalCommitRequestJsonSchema).not.toHaveProperty("$schema");
    expect(libraryRemovalOperationJsonSchema).not.toHaveProperty("$schema");
    expect(libraryRemovalOperationJsonSchema).toMatchObject({ type: "object" });
    expect(viewingHistoryQueryJsonSchema).not.toHaveProperty("$schema");
    expect(viewingHistoryResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryTitleDetailResponseJsonSchema).not.toHaveProperty("$schema");
    expect(libraryTitleDetailResponseJsonSchema).toMatchObject({ type: "object" });
    expect(libraryExtrasQueryJsonSchema).not.toHaveProperty("$schema");
    expect(libraryExtrasResponseJsonSchema).not.toHaveProperty("$schema");
    expect(librarySeasonEpisodesQueryJsonSchema).not.toHaveProperty("$schema");
    expect(librarySeasonEpisodesResponseJsonSchema).not.toHaveProperty("$schema");
  });
});
