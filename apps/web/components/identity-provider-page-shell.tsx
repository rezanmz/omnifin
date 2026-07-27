import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import styles from "./identity-provider-console.module.css";

interface IdentityProviderPageShellProperties {
  children: ReactNode;
  displayProfile?: DisplayProfile;
}

export function IdentityProviderPageShell({
  children,
  displayProfile = "standard",
}: IdentityProviderPageShellProperties) {
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

        <section className={styles.hero} aria-labelledby="identity-provider-title">
          <div>
            <p className="eyebrow">Identity control room</p>
            <h1 id="identity-provider-title">Trust, made visible.</h1>
            <p>
              Connect OIDC providers, verify every advertised capability, and translate exact claims
              into bounded Omnifin roles.
            </p>
          </div>
          <div className={styles.heroSeal}>
            <ShieldCheck aria-hidden="true" size={20} />
            <span>
              <strong>Local authority</strong>
              <small>Secrets stay in the gateway</small>
            </span>
          </div>
        </section>

        {children}
      </main>
    </div>
  );
}
