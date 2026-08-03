import { CalendarDays, Library } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { preload } from "react-dom";
import type { DashboardModel } from "../lib/dashboard-data";
import { DirectionalNavigationGroup } from "./directional-navigation-group";

type AccentStyle = CSSProperties & {
  "--hero-accent": string;
};

export interface HeroSpotlightProperties {
  actionRegion?: ReactNode;
  artworkPath?: string | null;
  hero: DashboardModel["hero"];
}

export function HeroSpotlight({ actionRegion, artworkPath, hero }: HeroSpotlightProperties) {
  const safeArtworkPath =
    artworkPath === "/demo-hero.svg" ||
    (artworkPath &&
      /^\/api\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22}$/u.test(artworkPath))
      ? artworkPath
      : null;
  if (safeArtworkPath) {
    preload(safeArtworkPath, { as: "image", fetchPriority: "high" });
  }
  const style = {
    "--hero-accent": hero.accent,
  } as AccentStyle;
  const hasFallbackActions = actionRegion === undefined && hero.actions !== "none";
  const titleScale = hero.title.length > 42 ? "long" : "standard";

  return (
    <section
      className="hero-spotlight"
      data-artwork-source={safeArtworkPath ? "remote" : "generated"}
      data-title-scale={titleScale}
      style={style}
      aria-labelledby="hero-title"
    >
      <div className="hero-spotlight__art" aria-hidden="true">
        {safeArtworkPath ? (
          // The gateway already serves a bounded, session-protected image. Browser-native loading
          // keeps credentials same-origin and avoids routing private artwork through an optimizer.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt=""
            className="hero-spotlight__art-image"
            decoding="async"
            fetchPriority="high"
            height={338}
            loading="eager"
            src={safeArtworkPath}
            width={600}
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
        {actionRegion ??
          (hasFallbackActions ? (
            <DirectionalNavigationGroup className="hero-spotlight__actions">
              <>
                <Link
                  className="button button--primary"
                  data-directional-item
                  href="/library"
                  prefetch={false}
                >
                  <Library aria-hidden="true" size={17} />
                  Browse library
                </Link>
                <Link
                  className="button button--glass"
                  data-directional-item
                  href="/calendar"
                  prefetch={false}
                >
                  <CalendarDays aria-hidden="true" size={18} />
                  Open calendar
                </Link>
              </>
            </DirectionalNavigationGroup>
          ) : null)}
      </div>
    </section>
  );
}
