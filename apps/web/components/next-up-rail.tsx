"use client";

import type { ContinueWatchingResponse } from "@omnifin/contracts/dashboard";
import { useQuery } from "@tanstack/react-query";

import type { MediaCardModel } from "../lib/dashboard-data";
import { loadNextUp, type NextUpClient } from "../lib/next-up";
import { MediaRail } from "./media-rail";

export interface NextUpRailProperties {
  client: NextUpClient;
  enabled: boolean;
  feed: ContinueWatchingResponse;
  onSelect: (item: MediaCardModel) => void;
}

function NextUpLoadingRail() {
  return (
    <section aria-busy="true" aria-labelledby="next-up-loading-title" className="media-rail">
      <div className="section-heading">
        <h2 id="next-up-loading-title">Next up</h2>
      </div>
      <span className="sr-only" role="status">
        Finding your next episodes…
      </span>
    </section>
  );
}

/** Loads episode continuations only after private Continue Watching is available. */
export function NextUpRail({ client, enabled, feed, onSelect }: NextUpRailProperties) {
  const sourceKey = feed.items.map((item) => item.media.id).join(":");
  const query = useQuery({
    enabled: enabled && sourceKey.length > 0,
    queryFn: ({ signal }) => loadNextUp(feed, client, signal),
    queryKey: ["next-up", feed.generatedAt, sourceKey],
    retry: false,
    staleTime: 20_000,
  });

  if (!enabled || sourceKey.length === 0) return null;
  if (query.isPending) return <NextUpLoadingRail />;
  if (!query.data || query.data.length === 0) return null;
  return (
    <MediaRail
      emptyTitle="No next episode right now"
      items={query.data}
      onSelect={onSelect}
      {...(query.isError ? { statusMessage: "Suggestions could not refresh" } : {})}
      title="Next up"
    />
  );
}
