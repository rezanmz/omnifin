"use client";

import type { ContinueWatchingResponse } from "@omnifin/contracts/dashboard";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { continueWatchingCards } from "../lib/continue-watching";
import type { MediaCardModel } from "../lib/dashboard-data";
import type { PlaybackClient } from "../lib/playback";
import { MediaRail } from "./media-rail";

const NEXT_UP_MAX_CONTEXTS = 8;

export interface NextUpRailProperties {
  feed: ContinueWatchingResponse;
  onSelect: (item: MediaCardModel) => void;
  playbackClient?: PlaybackClient;
}

function nextEpisodeLabel(seasonNumber: number | null, episodeNumber: number | null) {
  const season = seasonNumber === null ? null : `S${seasonNumber}`;
  const episode = episodeNumber === null ? null : `E${episodeNumber}`;
  return [season, episode].filter((part): part is string => part !== null).join("");
}

function artworkPath(path: string | null) {
  return path === null ? undefined : path.replace(/^\/v1\//u, "/api/");
}

export function NextUpRail({ feed, onSelect, playbackClient }: NextUpRailProperties) {
  const candidates = useMemo(() => {
    const episodes: ContinueWatchingResponse["items"] = [];
    for (const item of feed.items) {
      if (item.media.kind !== "episode") continue;
      episodes.push(item);
      if (episodes.length === NEXT_UP_MAX_CONTEXTS) break;
    }
    return episodes;
  }, [feed.items]);
  const candidateIds = candidates.map((item) => item.media.id);
  const query = useQuery({
    enabled: playbackClient?.loadContext !== undefined && candidateIds.length > 0,
    queryFn: async ({ signal }) => {
      const loadContext = playbackClient?.loadContext;
      if (!loadContext) return [];
      const results = await Promise.allSettled(
        candidates.map(async (item) => ({
          item,
          context: await loadContext(item.media.id, signal),
        })),
      );
      if (signal.aborted) throw signal.reason;
      return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    },
    queryKey: ["next-up", feed.generatedAt, ...candidateIds],
    retry: false,
    staleTime: 20_000,
  });
  const cards = useMemo(() => {
    const accentByReference = new Map(
      continueWatchingCards(feed).map((card) => [card.id, card.accent]),
    );
    const seen = new Set<string>();
    return (query.data ?? []).flatMap(({ context, item }) => {
      if (context.nextState !== "ready" || context.nextEpisode === null) return [];
      const next = context.nextEpisode;
      if (seen.has(next.mediaReferenceId)) return [];
      seen.add(next.mediaReferenceId);
      const label = nextEpisodeLabel(next.seasonNumber, next.episodeNumber);
      const nextArtworkPath = artworkPath(next.artworkPath);
      return [
        {
          accent: accentByReference.get(item.media.id) ?? "#5d9690",
          ...(nextArtworkPath === undefined ? {} : { artworkPath: nextArtworkPath }),
          eyebrow: [next.seriesTitle, label].filter(Boolean).join(" · "),
          id: next.mediaReferenceId,
          positionSeconds: 0,
          title: next.title,
        },
      ];
    });
  }, [feed, query.data]);

  if (cards.length === 0) return null;
  return <MediaRail items={cards} onSelect={onSelect} title="Next up" />;
}
