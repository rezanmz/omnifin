"use client";

import { ArrowRight, Clapperboard, PanelRightOpen, Play } from "lucide-react";
import type { CSSProperties } from "react";
import type { MediaCardModel } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";

type CardStyle = CSSProperties & { "--card-accent": string };

type ArtworkStyle = CSSProperties & { "--card-artwork"?: string };

export function MediaRail({
  emptyCopy,
  emptyTitle = "Nothing queued here yet",
  items,
  onSelect,
  onViewAll,
  statusMessage,
  title,
}: {
  emptyCopy?: string;
  emptyTitle?: string;
  items: MediaCardModel[];
  onSelect?: (item: MediaCardModel) => void;
  onViewAll?: () => void;
  statusMessage?: string;
  title: string;
}) {
  const headingId = `rail-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  const resolvedEmptyCopy =
    emptyCopy ??
    (title.toLowerCase().includes("continue")
      ? "Start watching something in Jellyfin and it will appear here with your progress."
      : "Discovery will return when connected metadata and library services have suggestions.");
  return (
    <section className="media-rail" aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId}>{title}</h2>
        <div className="section-heading__actions">
          {statusMessage && (
            <span className="media-rail__status" role="status">
              {statusMessage}
            </span>
          )}
          {items.length > 0 && onViewAll ? (
            <button className="text-action" onClick={onViewAll} type="button">
              View all <ArrowRight aria-hidden="true" size={15} />
            </button>
          ) : null}
        </div>
      </div>
      {items.length > 0 ? (
        <div
          aria-label={onSelect ? undefined : `${title} titles`}
          className="media-rail__scroller"
          data-media-scroller
          onKeyDown={(event) =>
            handleDirectionalFocus(event, {
              axis: "horizontal",
              scrollContainerSelector: "[data-media-scroller]",
            })
          }
          role={onSelect ? undefined : "region"}
          tabIndex={onSelect ? undefined : 0}
        >
          {items.map((item, index) => {
            const watchedPercent =
              typeof item.progress === "number" ? Math.round(item.progress * 100) : undefined;
            const progressDescriptionId = `${headingId}-${item.id}-progress`;
            const artworkPath = item.artworkPath
              ? /^(?:\/api\/media\/media_[A-Za-z0-9_-]{22}\/images\/(?:backdrop|poster)|\/api\/discovery\/artwork\/discovery_art_[A-Za-z0-9_-]{22})$/u.test(
                  item.artworkPath,
                )
                ? item.artworkPath
                : undefined
              : undefined;
            const cardContent = (
              <>
                <span
                  className="media-card__art"
                  data-artwork={item.artwork ?? "fallback"}
                  data-artwork-source={artworkPath ? "remote" : "generated"}
                  aria-hidden="true"
                  style={
                    artworkPath
                      ? ({ "--card-artwork": `url("${artworkPath}")` } as ArtworkStyle)
                      : undefined
                  }
                >
                  <span className="media-card__motif media-card__motif--one" />
                  <span className="media-card__motif media-card__motif--two" />
                  <span className="media-card__number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="media-card__flare" />
                </span>
                {onSelect ? (
                  <span className="media-card__overlay" aria-hidden="true">
                    <span className="media-card__play">
                      {watchedPercent === undefined ? (
                        <PanelRightOpen size={16} />
                      ) : (
                        <Play fill="currentColor" size={16} />
                      )}
                    </span>
                  </span>
                ) : null}
                {watchedPercent !== undefined && (
                  <>
                    <span
                      aria-label={`${item.title} watch progress`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={watchedPercent}
                      className="media-card__progress"
                      role="progressbar"
                    >
                      <span aria-hidden="true" style={{ width: `${watchedPercent}%` }} />
                    </span>
                    <span className="sr-only" id={progressDescriptionId}>
                      {watchedPercent}% watched
                    </span>
                  </>
                )}
              </>
            );

            return (
              <article
                className="media-card"
                key={item.id}
                style={{ "--card-accent": item.accent } as CardStyle}
              >
                {onSelect ? (
                  <button
                    aria-describedby={
                      watchedPercent === undefined ? undefined : progressDescriptionId
                    }
                    aria-label={
                      watchedPercent === undefined
                        ? `View details for ${item.title}`
                        : `Resume ${item.title}`
                    }
                    className="media-card__action"
                    data-directional-item
                    data-interactive="true"
                    data-media-id={item.id}
                    onClick={() => onSelect(item)}
                    type="button"
                  >
                    {cardContent}
                  </button>
                ) : (
                  <div className="media-card__action" data-interactive="false">
                    {cardContent}
                  </div>
                )}
                <div className="media-card__copy">
                  <h3>{item.title}</h3>
                  <p>{item.eyebrow}</p>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="quiet-state quiet-state--rail" role="status">
          <span className="quiet-state__icon" aria-hidden="true">
            <Clapperboard size={20} />
          </span>
          <span>
            <strong>{emptyTitle}</strong>
            <span>{resolvedEmptyCopy}</span>
          </span>
        </div>
      )}
    </section>
  );
}
