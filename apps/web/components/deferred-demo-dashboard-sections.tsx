"use client";

import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";

import { isDeferredContentNavigation } from "../lib/deferred-content-activation";
import { useIdleRender } from "../lib/use-idle-render";
import { DashboardSectionsSkeleton } from "./deferred-dashboard-sections";

let demoSectionsPromise: Promise<ComponentType> | undefined;

function loadDemoSections() {
  demoSectionsPromise ??= Promise.all([
    import("../app/dashboard.css"),
    import("./demo-dashboard-sections"),
  ]).then(([, module]) => module.DemoDashboardSections);
  return demoSectionsPromise;
}

export function DeferredDemoDashboardSections() {
  const [Sections, setSections] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);
  const passiveReady = useIdleRender(600);

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
