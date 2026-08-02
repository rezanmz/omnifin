import { ArrowLeft, ScrollText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import styles from "./audit-trail.module.css";

export function AuditTrailPageShell({
  children,
  displayProfile,
}: {
  children: ReactNode;
  displayProfile: DisplayProfile;
}) {
  return (
    <div className={styles.layout} data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <LiquidGlassEnvironment />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <header className={styles.topbar}>
          <BrandMark />
          <Link className={styles.back} href="/settings">
            <ArrowLeft aria-hidden="true" size={17} /> Account &amp; access
          </Link>
        </header>
        <section className={styles.hero} aria-labelledby="audit-title">
          <div>
            <p className="eyebrow">Operator record</p>
            <h1 id="audit-title">Every consequential move, accounted for.</h1>
            <p>
              Follow authentication, configuration, requests, acquisition, and library actions
              without exposing the private payloads behind them.
            </p>
          </div>
          <div className={styles.heroSeal} data-liquid-glass>
            <span className={styles.heroSealIcon} aria-hidden="true">
              <ScrollText size={21} />
            </span>
            <span>
              <strong>Privacy-safe record</strong>
              <small>Metadata and upstream identifiers stay sealed</small>
            </span>
            <ShieldCheck aria-hidden="true" className={styles.heroSealProof} size={18} />
          </div>
        </section>
        {children}
      </main>
    </div>
  );
}
