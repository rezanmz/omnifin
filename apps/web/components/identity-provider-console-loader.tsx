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
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setReady(true));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  if (!ready) return <IdentityProviderConsoleSkeleton />;
  return <LazyIdentityProviderConsole {...properties} />;
}
