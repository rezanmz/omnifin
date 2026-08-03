"use client";

import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";

import { DashboardSectionsSkeleton } from "./deferred-dashboard-sections";

let demoSectionsPromise: Promise<ComponentType> | undefined;

function loadDemoSections() {
  demoSectionsPromise ??= import("./demo-dashboard-sections").then(
    (module) => module.DemoDashboardSections,
  );
  return demoSectionsPromise;
}

export function DeferredDemoDashboardSections() {
  const [Sections, setSections] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);

  const activate = useCallback(() => {
    setFailed(false);
    void loadDemoSections()
      .then((Component) => setSections(() => Component))
      .catch(() => {
        demoSectionsPromise = undefined;
        setFailed(true);
      });
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(activate, 600);
    const activateFromIntent = () => activate();
    window.addEventListener("keydown", activateFromIntent, { once: true });
    window.addEventListener("pointerdown", activateFromIntent, { once: true, passive: true });
    window.addEventListener("scroll", activateFromIntent, { once: true, passive: true });
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", activateFromIntent);
      window.removeEventListener("pointerdown", activateFromIntent);
      window.removeEventListener("scroll", activateFromIntent);
    };
  }, [activate]);

  if (Sections) return <Sections />;
  return (
    <>
      <DashboardSectionsSkeleton showMedia />
      {failed ? (
        <button className="button button--glass" onClick={activate} type="button">
          Retry dashboard controls
        </button>
      ) : null}
    </>
  );
}
