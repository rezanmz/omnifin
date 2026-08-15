import type { ContinueWatchingResponse } from "@omnifin/contracts/dashboard";
import type { PlaybackContextResponse } from "@omnifin/contracts/playback";

import type { MediaCardModel } from "./dashboard-data";

export const NEXT_UP_MAX_CONTEXTS = 8;
export const NEXT_UP_MAX_CONCURRENCY = 4;

export interface NextUpClient {
  loadContext(mediaReferenceId: string, signal?: AbortSignal): Promise<PlaybackContextResponse>;
}

interface NextUpCandidate {
  readonly accent: string;
  readonly sourceReferenceId: string;
}

function sameOriginArtwork(path: string | null) {
  return path === null ? undefined : path.replace(/^\/v1\//u, "/api/");
}

function fallbackAccent(referenceId: string) {
  let hash = 0;
  for (const character of referenceId) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return ["#5d9690", "#9b735f", "#6f789b", "#7f7361", "#75658d"][hash % 5]!;
}

function episodeLabel(episode: NonNullable<PlaybackContextResponse["nextEpisode"]>) {
  const season = episode.seasonNumber === null ? null : `S${episode.seasonNumber}`;
  const number = episode.episodeNumber === null ? null : `E${episode.episodeNumber}`;
  return season && number ? `${season}${number}` : "Next episode";
}

function candidates(feed: ContinueWatchingResponse): NextUpCandidate[] {
  return feed.items
    .filter((item) => item.media.kind === "episode")
    .slice(0, NEXT_UP_MAX_CONTEXTS)
    .map((item) => ({
      accent: item.media.artwork.accentColor ?? fallbackAccent(item.media.id),
      sourceReferenceId: item.media.id,
    }));
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Resolves a bounded, user-scoped continuation rail from private watch state.
 * Context failures are isolated to their originating title; an abort cancels the
 * entire aggregation so a stale dashboard cannot keep connector work alive.
 */
export async function loadNextUp(
  feed: ContinueWatchingResponse,
  client: NextUpClient,
  signal?: AbortSignal,
): Promise<MediaCardModel[]> {
  const source = candidates(feed);
  const results = new Array<PlaybackContextResponse | null>(source.length).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < source.length) {
      const index = nextIndex++;
      const candidate = source[index]!;
      if (signal?.aborted)
        throw new DOMException("The next-up request was cancelled.", "AbortError");
      try {
        const context = await client.loadContext(candidate.sourceReferenceId, signal);
        if (context.mediaReferenceId === candidate.sourceReferenceId) results[index] = context;
      } catch (error) {
        if (isAbort(error)) throw error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(NEXT_UP_MAX_CONCURRENCY, source.length) }, () => worker()),
  );

  const seen = new Set<string>();
  const cards: MediaCardModel[] = [];
  for (const [index, context] of results.entries()) {
    const nextEpisode = context?.nextEpisode;
    if (
      context === null ||
      nextEpisode === undefined ||
      nextEpisode === null ||
      (context.nextState !== "ready" && context.nextState !== "requestable") ||
      seen.has(nextEpisode.mediaReferenceId)
    ) {
      continue;
    }
    seen.add(nextEpisode.mediaReferenceId);
    const artworkPath = sameOriginArtwork(nextEpisode.artworkPath);
    const requestable = context.nextState === "requestable";
    cards.push({
      accent: source[index]!.accent,
      ...(artworkPath === undefined ? {} : { artworkPath }),
      eyebrow: `${requestable ? "Available to request" : `Continue with ${episodeLabel(nextEpisode)}`} · ${nextEpisode.title}`,
      id: nextEpisode.mediaReferenceId,
      requestable,
      selectable: !requestable,
      title: nextEpisode.seriesTitle,
    });
  }
  return cards;
}
