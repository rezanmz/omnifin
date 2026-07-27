import { ArrowLeft, Network } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import styles from "./connector-control-room.module.css";

export function ConnectorPageShell({
  children,
  displayProfile = "standard",
}: {
  children: ReactNode;
  displayProfile?: DisplayProfile;
}) {
  return (
    <div className={styles.layout} data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <header className={styles.topbar}>
          <BrandMark />
          <Link className={styles.back} href="/settings">
            <ArrowLeft aria-hidden="true" size={17} /> Account &amp; access
          </Link>
        </header>
        <section className={styles.hero} aria-labelledby="connector-control-room-title">
          <div>
            <p className="eyebrow">Stack control room</p>
            <h1 id="connector-control-room-title">Every service. One signal.</h1>
            <p>
              Establish a guarded path to each media service, prove its health, and expose only the
              capabilities Omnifin can safely orchestrate.
            </p>
          </div>
          <div className={styles.heroSeal}>
            <Network aria-hidden="true" size={20} />
            <span>
              <strong>Private by design</strong>
              <small>No telemetry. No browser secrets.</small>
            </span>
          </div>
        </section>
        {children}
      </main>
    </div>
  );
}
