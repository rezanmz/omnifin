"use client";

import dynamic from "next/dynamic";

import type { IdentityProviderConsoleProperties } from "./identity-provider-console";
import styles from "./identity-provider-console.module.css";

const LazyIdentityProviderConsole = dynamic(
  () => import("./identity-provider-console").then((module_) => module_.IdentityProviderConsole),
  {
    loading: () => (
      <section
        aria-busy="true"
        aria-label="Loading identity provider administration"
        className={styles.console}
      >
        <div className={`${styles.providerRail} ${styles.skeleton}`} />
        <div className={`${styles.workspace} ${styles.skeleton}`} />
      </section>
    ),
    ssr: false,
  },
);

export function IdentityProviderConsoleLoader(properties: IdentityProviderConsoleProperties) {
  return <LazyIdentityProviderConsole {...properties} />;
}
