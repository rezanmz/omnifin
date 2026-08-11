"use client";

import type { Role, UserAccessSummary } from "@omnifin/contracts/auth";
import { ArrowLeft, ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "./user-access-control.module.css";

const roles = ["viewer", "requester", "operator", "admin"] as const;
const roleDescriptions: Record<Role, string> = {
  admin: "Full identity, service, and policy control.",
  operator: "Manage requests, acquisition, downloads, and library care.",
  requester: "Browse, play, and submit new media requests.",
  viewer: "Browse and play within the paired Jellyfin permissions.",
};

function roleLabel(role: Role) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function sourceLabel(user: UserAccessSummary) {
  return user.roleSource === "default" ? "Default role" : "OIDC mapping";
}

export function UserRoleAssignmentWizard({
  busy,
  onCancel,
  onSubmit,
  user,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (role: Role) => Promise<void>;
  user: UserAccessSummary;
}) {
  const headingReference = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [assignmentRole, setAssignmentRole] = useState<Role>(user.role);

  useEffect(() => {
    headingReference.current?.focus();
  }, [step]);

  const unchanged = assignmentRole === user.role;

  return (
    <section className={styles.assignmentWizard} aria-labelledby="oidc-role-assignment-title">
      <div className={styles.assignmentHeading}>
        <div>
          <p className="section-kicker">Individual provider role</p>
          <h3 id="oidc-role-assignment-title" ref={headingReference} tabIndex={-1}>
            {step === 1 ? "Assign an individual role" : "Review role assignment"}
          </h3>
        </div>
        <ol className={styles.assignmentSteps} aria-label="Role assignment progress">
          <li data-current={step === 1 || undefined}>1. Choose</li>
          <li data-current={step === 2 || undefined}>2. Review</li>
        </ol>
      </div>

      {step === 1 ? (
        <>
          <p className={styles.assignmentIntro}>
            Create a server-owned fallback provider mapping for this identity. It does not change
            the provider-wide rules or create a manual role.
          </p>
          <dl className={styles.assignmentFacts}>
            <div>
              <dt>Current source</dt>
              <dd>{sourceLabel(user)}</dd>
            </div>
            <div>
              <dt>Current effective role</dt>
              <dd>{roleLabel(user.role)}</dd>
            </div>
            <div>
              <dt>Assignment role</dt>
              <dd>{roleLabel(assignmentRole)}</dd>
            </div>
          </dl>
          <fieldset className={styles.assignmentFieldset} disabled={busy}>
            <legend>Choose the role for this identity</legend>
            <div className={styles.roleGrid}>
              {roles.map((role) => (
                <button
                  aria-pressed={assignmentRole === role}
                  className={styles.roleOption}
                  key={role}
                  onClick={() => setAssignmentRole(role)}
                  type="button"
                >
                  <span>
                    <strong>{roleLabel(role)}</strong>
                    {assignmentRole === role ? <ShieldCheck aria-hidden="true" size={16} /> : null}
                  </span>
                  <small>{roleDescriptions[role]}</small>
                </button>
              ))}
            </div>
          </fieldset>
          <p className={styles.assignmentLimitations}>
            This applies after the target&apos;s next OIDC sign-in. A higher-priority provider
            mapping may override this assignment. Saving may close affected provider-managed
            sessions.
          </p>
        </>
      ) : (
        <div className={styles.assignmentReview} role="region" aria-label="Review role assignment">
          <p>
            <strong>{user.displayName}</strong> will receive a server-owned provider fallback.
          </p>
          <dl className={styles.assignmentFacts}>
            <div>
              <dt>Current source</dt>
              <dd>{sourceLabel(user)}</dd>
            </div>
            <div>
              <dt>Current effective role</dt>
              <dd>{roleLabel(user.role)}</dd>
            </div>
            <div>
              <dt>Assignment role</dt>
              <dd>{roleLabel(assignmentRole)}</dd>
            </div>
          </dl>
          <p className={styles.assignmentLimitations}>
            The assignment takes effect after the target&apos;s next OIDC sign-in. Higher-priority
            provider mappings may override it. Saving may close affected provider-managed sessions;
            the exact effective mapping cannot be determined here.
          </p>
        </div>
      )}

      <div className={styles.assignmentActions}>
        <button className={styles.secondaryButton} disabled={busy} onClick={onCancel} type="button">
          Cancel
        </button>
        {step === 2 ? (
          <button
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => setStep(1)}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={16} /> Back
          </button>
        ) : null}
        {step === 1 ? (
          <button
            className={styles.primaryButton}
            disabled={busy || unchanged}
            onClick={() => setStep(2)}
            type="button"
          >
            Continue <ArrowRight aria-hidden="true" size={16} />
          </button>
        ) : (
          <button
            className={styles.primaryButton}
            disabled={busy}
            onClick={() => void onSubmit(assignmentRole)}
            type="button"
          >
            {busy ? (
              <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
            ) : (
              <ShieldCheck aria-hidden="true" size={16} />
            )}
            {busy ? "Assigning role…" : "Apply provider role"}
          </button>
        )}
      </div>
    </section>
  );
}
