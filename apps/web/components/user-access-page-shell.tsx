import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import styles from "./user-access-control.module.css";

export function UserAccessPageShell({
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
        <section className={styles.hero} aria-labelledby="user-access-title">
          <div>
            <p className="eyebrow">Access directory</p>
            <h1 id="user-access-title">Authority, without ambiguity.</h1>
            <p>
              See how every person enters Omnifin, where their role comes from, and what will happen
              before changing their access.
            </p>
          </div>
          <div className={styles.heroSeal} data-liquid-glass>
            <ShieldCheck aria-hidden="true" size={20} />
            <span>
              <strong>Least privilege</strong>
              <small>Every change closes active sessions</small>
            </span>
          </div>
        </section>
        {children}
      </main>
    </div>
  );
}
