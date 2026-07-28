"use client";

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { CloudOff, LockKeyhole, RefreshCw, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  continueWatchingCards,
  continueWatchingClient,
  continueWatchingOutcomeFromError,
  type ContinueWatchingClient,
  type ContinueWatchingLoadOutcome,
} from "../lib/continue-watching";
import { MediaRail } from "./media-rail";

export interface ContinueWatchingRailProperties {
  client?: ContinueWatchingClient;
  initialOutcome?: ContinueWatchingLoadOutcome;
  live?: boolean;
}

function LoadingRail() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="continue-watching-loading-title"
      className="media-rail"
    >
      <div className="section-heading">
        <h2 id="continue-watching-loading-title">Continue watching</h2>
      </div>
      <div aria-hidden="true" className="media-rail__scroller media-rail__scroller--loading">
        {Array.from({ length: 4 }, (_, index) => (
          <article className="media-card media-card--loading" key={index}>
            <span className="media-card__loading-art" />
            <span className="media-card__loading-line" />
            <span className="media-card__loading-line media-card__loading-line--short" />
          </article>
        ))}
      </div>
      <span className="sr-only" role="status">
        Loading Continue Watching…
      </span>
    </section>
  );
}

const boundaryCopy = {
  forbidden: {
    action: "Review account access",
    detail: "Your current role does not include media-library access.",
    href: "/settings",
    icon: ShieldAlert,
    title: "Continue Watching is restricted",
  },
  signed_out: {
    action: "Sign in",
    detail: "Sign in with OIDC or Jellyfin to bring your private watch state into view.",
    href: "/login",
    icon: LockKeyhole,
    title: "Your progress is waiting",
  },
} as const;

function BoundaryRail({ status }: { status: keyof typeof boundaryCopy }) {
  const copy = boundaryCopy[status];
  const Icon = copy.icon;
  return (
    <section className="media-rail" aria-labelledby={`continue-watching-${status}-title`}>
      <div className="section-heading">
        <h2 id={`continue-watching-${status}-title`}>Continue watching</h2>
      </div>
      <div className="quiet-state quiet-state--rail media-rail__boundary" role="status">
        <span className="quiet-state__icon" aria-hidden="true">
          <Icon size={20} />
        </span>
        <span>
          <strong>{copy.title}</strong>
          <span>{copy.detail}</span>
        </span>
        <Link className="button button--glass media-rail__boundary-action" href={copy.href}>
          {copy.action}
        </Link>
      </div>
    </section>
  );
}

function UnavailableRail({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="media-rail" aria-labelledby="continue-watching-unavailable-title">
      <div className="section-heading">
        <h2 id="continue-watching-unavailable-title">Continue watching</h2>
      </div>
      <div
        className="quiet-state quiet-state--rail media-rail__boundary"
        data-severity="warning"
        role="status"
      >
        <span className="quiet-state__icon" aria-hidden="true">
          <CloudOff size={20} />
        </span>
        <span>
          <strong>Jellyfin is out of reach</strong>
          <span>
            Your watch state is untouched. Omnifin will try again when the signal returns.
          </span>
        </span>
        <button
          className="button button--glass media-rail__boundary-action"
          onClick={onRetry}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={16} /> Retry
        </button>
      </div>
    </section>
  );
}

function ContinueWatchingRailContent({
  client,
  initialOutcome,
  live,
}: Required<Pick<ContinueWatchingRailProperties, "client">> &
  Pick<ContinueWatchingRailProperties, "initialOutcome" | "live">) {
  const refreshAvailable = live ?? initialOutcome === undefined;
  const initialFeed = initialOutcome?.status === "ready" ? initialOutcome.feed : undefined;
  const query = useQuery({
    enabled: refreshAvailable,
    initialData: initialFeed,
    queryFn: ({ signal }) => client.load(signal),
    queryKey: ["continue-watching"],
    refetchInterval: refreshAvailable ? 30_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 20_000,
  });

  if (!refreshAvailable && initialOutcome && initialOutcome.status !== "ready") {
    return initialOutcome.status === "unavailable" ? (
      <UnavailableRail onRetry={() => undefined} />
    ) : (
      <BoundaryRail status={initialOutcome.status} />
    );
  }
  if (query.isPending) return <LoadingRail />;
  if (!query.data) {
    const status = continueWatchingOutcomeFromError(query.error);
    return status === "unavailable" ? (
      <UnavailableRail onRetry={() => void query.refetch()} />
    ) : (
      <BoundaryRail status={status} />
    );
  }
  if (query.data.state === "unavailable") {
    return <UnavailableRail onRetry={() => void query.refetch()} />;
  }
  return (
    <MediaRail
      items={continueWatchingCards(query.data)}
      {...(query.isError ? { statusMessage: "Showing saved progress · refresh interrupted" } : {})}
      title="Continue watching"
    />
  );
}

export function ContinueWatchingRail({
  client = continueWatchingClient,
  initialOutcome,
  live,
}: ContinueWatchingRailProperties) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { gcTime: 5 * 60_000, retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ContinueWatchingRailContent
        client={client}
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
        {...(live === undefined ? {} : { live })}
      />
    </QueryClientProvider>
  );
}
