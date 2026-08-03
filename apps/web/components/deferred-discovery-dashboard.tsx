"use client";

import type { DiscoveryFeedResponse } from "@omnifin/contracts/discovery";
import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";

import { isDeferredContentNavigation } from "../lib/deferred-content-activation";
import { useIdleRender } from "../lib/use-idle-render";
import type { DiscoveryDashboardProperties } from "./discovery-dashboard";

const RAIL_TITLES = [
  "Popular movies",
  "Series people are watching",
  "Trending now",
  "Coming soon",
] as const;

let dashboardPromise: Promise<ComponentType<DiscoveryDashboardProperties>> | undefined;

function loadDashboard() {
  dashboardPromise ??= import("./discovery-dashboard").then((module) => module.DiscoveryDashboard);
  return dashboardPromise;
}

function DiscoveryRailsFallback({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div
      aria-label={failed ? "Connected discovery failed to load" : "Preparing connected discovery"}
      className="deferred-discovery-rails"
      role="region"
    >
      {RAIL_TITLES.map((title) => (
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
      {failed ? (
        <>
          <span className="sr-only" role="status">
            Connected discovery controls failed to load.
          </span>
          <button className="button button--glass" onClick={onRetry} type="button">
            Retry discovery controls
          </button>
        </>
      ) : (
        <span className="sr-only" role="status">
          Connected discovery controls are loading.
        </span>
      )}
    </div>
  );
}

export function DeferredDiscoveryDashboard({
  initialFeed,
}: {
  initialFeed: DiscoveryFeedResponse;
}) {
  const [Dashboard, setDashboard] = useState<ComponentType<DiscoveryDashboardProperties> | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const passiveReady = useIdleRender(1_000);

  const activate = useCallback(() => {
    setFailed(false);
    void loadDashboard()
      .then((Component) => setDashboard(() => Component))
      .catch(() => {
        dashboardPromise = undefined;
        setFailed(true);
      });
  }, []);

  useEffect(() => {
    if (!passiveReady) return;
    const task = window.setTimeout(activate, 0);
    return () => window.clearTimeout(task);
  }, [activate, passiveReady]);

  useEffect(() => {
    const activateFromIntent = () => activate();
    const activateFromKeyboard = (event: KeyboardEvent) => {
      if (isDeferredContentNavigation(event)) activate();
    };
    window.addEventListener("scroll", activateFromIntent, { once: true, passive: true });
    window.addEventListener("keydown", activateFromKeyboard);
    return () => {
      window.removeEventListener("scroll", activateFromIntent);
      window.removeEventListener("keydown", activateFromKeyboard);
    };
  }, [activate]);

  if (!Dashboard) return <DiscoveryRailsFallback failed={failed} onRetry={activate} />;

  return (
    <Dashboard initialFeed={initialFeed} live={false} showContinueWatching={false} suppressHero />
  );
}
