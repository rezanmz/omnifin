"use client";

import { CalendarDays, Info, Library, Sparkles } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import type { DashboardModel } from "../lib/dashboard-data";
import { DirectionalNavigationGroup } from "./directional-navigation-group";

type AccentStyle = CSSProperties & {
  "--hero-accent": string;
};

export interface HeroSpotlightProperties {
  artworkPath?: string | null;
  hero: DashboardModel["hero"];
  onDetails?: () => void;
  onRequest?: () => void;
}

export function HeroSpotlight({
  artworkPath,
  hero,
  onDetails,
  onRequest,
}: HeroSpotlightProperties) {
  const safeArtworkPath =
    artworkPath && /^\/api\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u.test(artworkPath)
      ? artworkPath
      : null;
  const style = {
    "--hero-accent": hero.accent,
  } as AccentStyle;
  const hasLiveActions = onDetails !== undefined;
  const hasFallbackActions = !hasLiveActions && hero.actions !== "none";

  return (
    <section
      className="hero-spotlight"
      data-artwork-source={safeArtworkPath ? "remote" : "generated"}
      style={style}
      aria-labelledby="hero-title"
    >
      <div className="hero-spotlight__art" aria-hidden="true">
        {safeArtworkPath ? (
          <Image
            alt=""
            className="hero-spotlight__art-image"
            fetchPriority="high"
            fill
            loading="eager"
            sizes="100vw"
            src={safeArtworkPath}
            unoptimized
          />
        ) : null}
        <div className="hero-spotlight__planet" />
        <div className="hero-spotlight__signal" />
        <div className="hero-spotlight__grain" />
      </div>
      <div className="hero-spotlight__scrim" aria-hidden="true" />
      <div className="hero-spotlight__content">
        <p className="eyebrow">{hero.eyebrow}</p>
        <h1 id="hero-title">{hero.title}</h1>
        <ul className="hero-spotlight__facts" aria-label="Media facts">
          {hero.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        <p className="hero-spotlight__description">{hero.description}</p>
        {(hasLiveActions || hasFallbackActions) && (
          <DirectionalNavigationGroup className="hero-spotlight__actions">
            {hasLiveActions ? (
              <>
                <button
                  className="button button--primary"
                  data-directional-item
                  onClick={onDetails}
                  type="button"
                >
                  <Info aria-hidden="true" size={18} />
                  View details
                </button>
                {onRequest ? (
                  <button
                    className="button button--glass"
                    data-directional-item
                    onClick={onRequest}
                    type="button"
                  >
                    <Sparkles aria-hidden="true" size={17} />
                    Request title
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <Link className="button button--primary" data-directional-item href="/library">
                  <Library aria-hidden="true" size={17} />
                  Browse library
                </Link>
                <Link className="button button--glass" data-directional-item href="/calendar">
                  <CalendarDays aria-hidden="true" size={18} />
                  Open calendar
                </Link>
              </>
            )}
          </DirectionalNavigationGroup>
        )}
      </div>
    </section>
  );
}
