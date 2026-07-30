"use client";

import dynamic from "next/dynamic";

import { LazyContinueWatchingRail } from "./lazy-continue-watching-rail";

const TITLES = [
  "Trending now",
  "Popular movies",
  "Series people are watching",
  "Coming soon",
] as const;

function DiscoveryDashboardChunkLoader() {
  return (
    <>
      <section
        aria-busy="true"
        aria-label="Loading discovery spotlight"
        className="hero-spotlight discovery-hero-skeleton"
      >
        <h1 className="sr-only">Loading connected discovery</h1>
        <div aria-hidden="true" className="discovery-hero-skeleton__lens" />
        <div aria-hidden="true" className="discovery-hero-skeleton__copy">
          <span />
          <span />
          <span />
          <span />
        </div>
        <span className="sr-only" role="status">
          Loading discovery dashboard…
        </span>
      </section>
      <LazyContinueWatchingRail />
      {TITLES.map((title) => (
        <section
          aria-busy="true"
          aria-label={`Loading ${title}`}
          className="media-rail"
          key={title}
        >
          <div className="section-heading">
            <h2>{title}</h2>
          </div>
          <div aria-hidden="true" className="media-rail__scroller media-rail__scroller--loading">
            {Array.from({ length: 5 }, (_, index) => (
              <article className="media-card media-card--loading" key={index}>
                <span className="media-card__loading-art" />
                <span className="media-card__loading-line" />
                <span className="media-card__loading-line media-card__loading-line--short" />
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export const LazyDiscoveryDashboard = dynamic(
  () =>
    import("./discovery-dashboard").then((module) => ({
      default: module.DiscoveryDashboard,
    })),
  { loading: DiscoveryDashboardChunkLoader, ssr: false },
);
