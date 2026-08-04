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

// Keep passive, below-fold work outside the Core Web Vitals observation window.
// Scroll and keyboard intent still activate the dashboard immediately.
const PASSIVE_ACTIVATION_DELAY_MS = 3_000;

let dashboardPromise: Promise<ComponentType<DiscoveryDashboardProperties>> | undefined;

function loadDashboard() {
  dashboardPromise ??= Promise.all([
    import("../app/dashboard.css"),
    import("./discovery-dashboard"),
  ]).then(([, module]) => module.DiscoveryDashboard);
  return dashboardPromise;
}

function DiscoveryHeroSkeleton() {
  return (
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
        Loading discovery spotlight…
      </span>
    </section>
  );
}

function DiscoveryRailsFallback({
  failed,
  onRetry,
  suppressHero,
}: {
  failed: boolean;
  onRetry: () => void;
  suppressHero: boolean;
}) {
  return (
    <>
      {suppressHero ? null : <DiscoveryHeroSkeleton />}
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
                <article
                  className="media-card media-card--loading media-card--loading-compact"
                  key={index}
                />
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
    </>
  );
}

export function DeferredDiscoveryDashboard({
  initialFeed,
  live = false,
  showContinueWatching = false,
  suppressHero = true,
}: {
  initialFeed?: DiscoveryFeedResponse;
  live?: boolean;
  showContinueWatching?: boolean;
  suppressHero?: boolean;
}) {
  const [Dashboard, setDashboard] = useState<ComponentType<DiscoveryDashboardProperties> | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const passiveReady = useIdleRender(PASSIVE_ACTIVATION_DELAY_MS);

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

  if (!Dashboard) {
    return (
      <DiscoveryRailsFallback failed={failed} onRetry={activate} suppressHero={suppressHero} />
    );
  }

  return (
    <Dashboard
      {...(initialFeed === undefined ? {} : { initialFeed })}
      live={live}
      showContinueWatching={showContinueWatching}
      suppressHero={suppressHero}
    />
  );
}
