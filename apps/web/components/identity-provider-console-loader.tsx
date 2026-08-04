"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import type { IdentityProviderConsoleProperties } from "./identity-provider-console";
import styles from "./identity-provider-console.module.css";

function IdentityProviderConsoleSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading identity provider administration"
      className={styles.console}
    >
      <div className={`${styles.providerRail} ${styles.skeleton}`} />
      <div className={`${styles.workspace} ${styles.skeleton}`} />
    </section>
  );
}

const LazyIdentityProviderConsole = dynamic(
  () => import("./identity-provider-console").then((module_) => module_.IdentityProviderConsole),
  {
    loading: IdentityProviderConsoleSkeleton,
    ssr: false,
  },
);

export function IdentityProviderConsoleLoader(properties: IdentityProviderConsoleProperties) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const requestIdle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback.bind(window)
        : null;
    if (requestIdle) {
      const callback = requestIdle(() => setReady(true), { timeout: 1_200 });
      return () => {
        if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(callback);
      };
    }
    const timeout = globalThis.setTimeout(() => setReady(true), 160);
    return () => globalThis.clearTimeout(timeout);
  }, []);

  if (!ready) return <IdentityProviderConsoleSkeleton />;
  return <LazyIdentityProviderConsole {...properties} />;
}
