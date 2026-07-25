"use client";

import { Info, Play } from "lucide-react";
import type { CSSProperties } from "react";
import type { DashboardModel } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";

type AccentStyle = CSSProperties & { "--hero-accent": string };

export function HeroSpotlight({ hero }: { hero: DashboardModel["hero"] }) {
  return (
    <section
      className="hero-spotlight"
      style={{ "--hero-accent": hero.accent } as AccentStyle}
      aria-labelledby="hero-title"
    >
      <div className="hero-spotlight__art" aria-hidden="true">
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
        <div
          className="hero-spotlight__actions"
          onKeyDown={(event) => handleDirectionalFocus(event, { axis: "horizontal" })}
        >
          <button className="button button--primary" data-directional-item type="button">
            <Play aria-hidden="true" fill="currentColor" size={17} />
            Play now
          </button>
          <button className="button button--glass" data-directional-item type="button">
            <Info aria-hidden="true" size={18} />
            Details
          </button>
        </div>
      </div>
      <div className="hero-spotlight__position" aria-label="Spotlight 1 of 5" role="img">
        <span className="is-active" />
        <span />
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}
