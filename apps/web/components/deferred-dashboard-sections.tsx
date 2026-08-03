"use client";

import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";

import { isDeferredContentNavigation } from "../lib/deferred-content-activation";
import { useIdleRender } from "../lib/use-idle-render";
import type { DashboardSectionsProperties } from "./dashboard-sections";

let sectionsPromise: Promise<ComponentType<DashboardSectionsProperties>> | undefined;

function loadSections() {
  sectionsPromise ??= Promise.all([
    import("../app/dashboard.css"),
    import("./dashboard-sections"),
  ]).then(([, module]) => module.DashboardSections);
  return sectionsPromise;
}

function RailSkeleton({ title }: { title: string }) {
  return (
    <section aria-busy="true" aria-label={`Loading ${title}`} className="media-rail">
      <div className="section-heading">
        <h2>{title}</h2>
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
    </section>
  );
}

export function DashboardSectionsSkeleton({ showMedia }: { showMedia: boolean }) {
  return (
    <div
      aria-label="Preparing dashboard controls"
      className="deferred-dashboard-sections"
      role="region"
    >
      {showMedia ? (
        <>
          <RailSkeleton title="Continue watching" />
          <RailSkeleton title="Made for tonight" />
        </>
      ) : null}
      <section
        aria-busy="true"
        aria-label="Loading this week’s releases"
        className="calendar-strip"
      >
        <div className="section-heading">
          <div>
            <p className="section-kicker">Release cadence</p>
            <h2>This week</h2>
          </div>
        </div>
        <div aria-hidden="true" className="dashboard-skeleton__calendar-grid">
          {Array.from({ length: 4 }, (_, index) => (
            <span className="dashboard-skeleton__calendar-item" key={index} />
          ))}
        </div>
      </section>
      <section
        aria-busy="true"
        aria-label="Loading acquisition operations"
        className="dashboard-sections__operations-skeleton"
        data-liquid-glass
      >
        <span />
        <span />
        <span />
      </section>
      <span className="sr-only" role="status">
        Dashboard controls are loading.
      </span>
    </div>
  );
}

export function DeferredDashboardSections(properties: DashboardSectionsProperties) {
  const [Sections, setSections] = useState<ComponentType<DashboardSectionsProperties> | null>(null);
  const [failed, setFailed] = useState(false);
  const passiveReady = useIdleRender(600);

  const activate = useCallback(() => {
    setFailed(false);
    void loadSections()
      .then((Component) => setSections(() => Component))
      .catch(() => {
        sectionsPromise = undefined;
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

  if (Sections) return <Sections {...properties} />;
  return (
    <>
      <DashboardSectionsSkeleton showMedia={properties.showMedia ?? true} />
      {failed ? (
        <button className="button button--glass" onClick={activate} type="button">
          Retry dashboard controls
        </button>
      ) : null}
    </>
  );
}
