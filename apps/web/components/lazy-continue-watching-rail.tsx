"use client";

import dynamic from "next/dynamic";

function ContinueWatchingRailLoader() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="continue-watching-chunk-title"
      className="media-rail media-rail--after-hero"
    >
      <div className="section-heading">
        <h2 id="continue-watching-chunk-title">Continue watching</h2>
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

export const LazyContinueWatchingRail = dynamic(
  () =>
    import("./continue-watching-rail").then((module) => ({
      default: module.ContinueWatchingRail,
    })),
  { loading: ContinueWatchingRailLoader, ssr: false },
);
