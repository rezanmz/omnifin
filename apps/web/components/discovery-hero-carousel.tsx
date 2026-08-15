"use client";

import type { DiscoveryFeedItem } from "@omnifin/contracts/discovery";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { discoverySpotlightHero } from "../lib/discovery-presentation";
import { HeroSpotlight } from "./hero-spotlight";

const AUTO_ROTATE_INTERVAL_MS = 8_000;

export interface DiscoveryHeroCarouselProperties {
  readonly actionRegion: (item: DiscoveryFeedItem) => ReactNode;
  readonly items: readonly DiscoveryFeedItem[];
}

export function DiscoveryHeroCarousel({ actionRegion, items }: DiscoveryHeroCarouselProperties) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const pausedReference = useRef(false);
  const currentIndex = Math.min(activeIndex, items.length - 1);
  const activeItem = items[currentIndex]!;
  const artworkPath = activeItem.artwork.backdropPath ?? activeItem.artwork.posterPath ?? null;

  function updatePaused(value: boolean) {
    pausedReference.current = value;
    setIsPaused(value);
  }

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener("change", updatePreference);
    return () => media.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    if (items.length < 2 || isPaused || reducedMotion) return;
    const interval = window.setInterval(() => {
      if (pausedReference.current) return;
      setActiveIndex((current) => (current + 1) % items.length);
    }, AUTO_ROTATE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isPaused, items.length, reducedMotion]);

  return (
    <div
      aria-label="Featured discovery"
      aria-roledescription="carousel"
      className="discovery-hero-carousel"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) updatePaused(false);
      }}
      onFocusCapture={() => updatePaused(true)}
      onPointerEnter={() => updatePaused(true)}
      onPointerLeave={() => updatePaused(false)}
      role="group"
    >
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        Showing {activeItem.title}
      </span>
      <HeroSpotlight
        actionRegion={actionRegion(activeItem)}
        artworkPath={artworkPath}
        hero={discoverySpotlightHero(activeItem)}
      />
      {items.length > 1 ? (
        <div
          aria-label="Spotlight controls"
          className="discovery-hero-carousel__controls"
          role="group"
        >
          <button
            aria-label="Show previous featured title"
            onClick={() => setActiveIndex((current) => (current + items.length - 1) % items.length)}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={20} />
          </button>
          <div className="discovery-hero-carousel__dots">
            {items.map((item, index) => (
              <button
                aria-current={index === currentIndex ? "true" : undefined}
                aria-label={`Show ${item.title}`}
                className="discovery-hero-carousel__dot"
                data-active={index === currentIndex}
                key={item.id}
                onClick={() => setActiveIndex(index)}
                type="button"
              />
            ))}
          </div>
          <button
            aria-label="Show next featured title"
            className="discovery-hero-carousel__step"
            onClick={() => setActiveIndex((current) => (current + 1) % items.length)}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={20} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
