"use client";

import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import type {
  AuditEvent,
  AuditEventCategory,
  AuditEventListResponse,
  AuditEventOutcome,
} from "@omnifin/contracts/audit";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  CloudOff,
  FilterX,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import {
  auditTrailClient,
  type AuditTrailClient,
  type AuditTrailLoadOutcome,
  type AuditTrailQuery,
} from "../lib/audit-trail";
import { AuditTrailPageShell } from "./audit-trail-page-shell";
import styles from "./audit-trail.module.css";

const PAGE_SIZE = 25;
const categoryOptions: readonly { label: string; value: AuditEventCategory | "all" }[] = [
  { label: "All activity", value: "all" },
  { label: "Access", value: "access" },
  { label: "Authentication", value: "authentication" },
  { label: "Configuration", value: "configuration" },
  { label: "Requests", value: "requests" },
  { label: "Acquisition", value: "acquisition" },
  { label: "Downloads", value: "downloads" },
  { label: "Library", value: "library" },
  { label: "Issues", value: "issues" },
  { label: "Indexers", value: "indexers" },
  { label: "System", value: "system" },
];
const outcomeOptions: readonly { label: string; value: AuditEventOutcome | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Successful", value: "success" },
  { label: "Denied", value: "denied" },
  { label: "Failed", value: "failure" },
];

const eventLabels: Readonly<Record<string, string>> = {
  "auth.admin.bootstrap_attempt": "Recovery access attempted",
  "auth.session.csrf_denied": "Session request denied",
  "auth.session.logout": "Session signed out",
  "auth.user.access_updated": "User access updated",
  "connector.configuration.updated": "Service configuration updated",
  "library.scan.requested": "Library scan requested",
  "media.request.approved": "Media request approved",
  "media.request.created": "Media request submitted",
};

export interface AuditTrailProperties {
  client?: AuditTrailClient;
  displayProfile?: DisplayProfile;
  embedded?: boolean;
  initialOutcome?: AuditTrailLoadOutcome;
}

function titleCase(value: string) {
  return value
    .split(/[_.:-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function eventLabel(event: AuditEvent) {
  return eventLabels[event.eventType] ?? titleCase(event.eventType.split(".").slice(1).join(" "));
}

function categoryLabel(category: AuditEventCategory) {
  return categoryOptions.find((option) => option.value === category)?.label ?? titleCase(category);
}

function authenticationLabel(event: AuditEvent) {
  if (event.actor.authenticationMethod === "oidc") return "OIDC";
  if (event.actor.authenticationMethod === "jellyfin") return "Jellyfin";
  if (event.actor.authenticationMethod === "recovery") return "Break-glass recovery";
  return "Local system";
}

function outcomeLabel(outcome: AuditEventOutcome) {
  return { denied: "Denied", failure: "Failed", success: "Completed" }[outcome];
}

function eventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function eventDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    weekday: "long",
    year: "numeric",
  }).format(date);
}

function dayKey(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown"
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function StatePanel({
  kind,
  onRetry,
}: {
  kind: "forbidden" | "signed_out" | "unavailable";
  onRetry: () => void;
}) {
  const content = {
    forbidden: {
      detail:
        "An active administrator with audit access is required. Recovery access is deliberately excluded.",
      icon: LockKeyhole,
      title: "This record is restricted.",
    },
    signed_out: {
      detail: "Sign in again before reviewing operator and authentication activity.",
      icon: KeyRound,
      title: "Your administrative session ended.",
    },
    unavailable: {
      detail:
        "No records were changed. Restore the gateway or database connection, then try again.",
      icon: CloudOff,
      title: "The audit trail is temporarily offline.",
    },
  }[kind];
  const Icon = content.icon;
  return (
    <section
      className={styles.statePanel}
      data-liquid-glass
      role={kind === "signed_out" ? "status" : "alert"}
    >
      <Icon aria-hidden="true" size={30} />
      <div>
        <h2>{content.title}</h2>
        <p>{content.detail}</p>
      </div>
      {kind === "signed_out" ? (
        <Link className={styles.primaryButton} href="/login">
          Return to sign in <ArrowRight aria-hidden="true" size={16} />
        </Link>
      ) : kind === "unavailable" ? (
        <button className={styles.secondaryButton} onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" size={16} /> Try again
        </button>
      ) : (
        <Link className={styles.secondaryButton} href="/settings">
          Back to account
        </Link>
      )}
    </section>
  );
}

function AuditTrailContent({
  client,
  initialOutcome,
}: {
  client: AuditTrailClient;
  initialOutcome?: AuditTrailLoadOutcome;
}) {
  const [category, setCategory] = useState<AuditEventCategory | "all">("all");
  const [outcome, setOutcome] = useState<AuditEventOutcome | "all">("all");
  const [paginationState, setPaginationState] = useState<{
    announcement: string;
    basePage: AuditEventListResponse;
    extraPages: readonly AuditEventListResponse[];
  } | null>(null);
  const filters = useMemo<AuditTrailQuery>(
    () => ({
      ...(category === "all" ? {} : { category }),
      limit: PAGE_SIZE,
      ...(outcome === "all" ? {} : { outcome }),
    }),
    [category, outcome],
  );
  const filterKey = `${category}:${outcome}`;
  const outcomeQuery = useQuery({
    initialData: filterKey === "all:all" ? initialOutcome : undefined,
    queryFn: () => client.load(filters),
    queryKey: ["audit-trail", filterKey],
    retry: false,
    staleTime: initialOutcome && filterKey === "all:all" ? Number.POSITIVE_INFINITY : 30_000,
  });
  const pagination = useMutation({
    mutationFn: (query: AuditTrailQuery) => client.page(query),
  });

  if (outcomeQuery.isPending) {
    return (
      <section
        aria-busy="true"
        aria-label="Loading operator audit trail"
        className={styles.ledger}
        data-liquid-glass
      >
        <div className={`${styles.filters} ${styles.skeleton}`} />
        <div className={styles.skeletonRows}>
          {Array.from({ length: 5 }, (_, index) => (
            <div className={styles.skeletonRow} key={index} />
          ))}
        </div>
      </section>
    );
  }

  const loadedOutcome = outcomeQuery.data;
  if (loadedOutcome?.status !== "ready") {
    return (
      <StatePanel
        kind={loadedOutcome?.status ?? "unavailable"}
        onRetry={() => void outcomeQuery.refetch()}
      />
    );
  }

  const basePage = loadedOutcome.page;
  const currentPagination = paginationState?.basePage === basePage ? paginationState : null;
  const pages = [basePage, ...(currentPagination?.extraPages ?? [])];
  const announcement = currentPagination?.announcement ?? "";
  const events = pages.flatMap((page) => page.events);
  const lastPage = pages.at(-1) ?? loadedOutcome.page;
  const hasFilters = category !== "all" || outcome !== "all";
  const grouped = new Map<string, AuditEvent[]>();
  for (const event of events) {
    const key = dayKey(event.occurredAt);
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }

  const loadEarlier = async () => {
    if (!lastPage.nextCursor || pagination.isPending) return;
    try {
      const next = await pagination.mutateAsync({ ...filters, cursor: lastPage.nextCursor });
      setPaginationState((current) => ({
        announcement: `${next.events.length} earlier event${next.events.length === 1 ? "" : "s"} loaded.`,
        basePage,
        extraPages: [...(current?.basePage === basePage ? current.extraPages : []), next],
      }));
    } catch {
      setPaginationState((current) => ({
        announcement: "Earlier events could not be loaded.",
        basePage,
        extraPages: current?.basePage === basePage ? current.extraPages : [],
      }));
    }
  };

  const clearFilters = () => {
    setCategory("all");
    setOutcome("all");
  };

  return (
    <>
      <div className={styles.announcer} aria-atomic="true" aria-live="polite">
        {announcement}
      </div>
      <section className={styles.overview} aria-label="Audit trail overview">
        <div data-liquid-glass>
          <ScrollText aria-hidden="true" size={19} />
          <span>
            <strong>{events.length} recorded events</strong>
            <small>
              {lastPage.nextCursor ? "Earlier history is available" : "End of retained view"}
            </small>
          </span>
        </div>
        <div data-liquid-glass>
          <ShieldCheck aria-hidden="true" size={19} />
          <span>
            <strong>Private fields sealed</strong>
            <small>Only normalized operator context is shown</small>
          </span>
        </div>
      </section>

      <section className={styles.ledger} data-liquid-glass aria-label="Operator audit trail">
        <header className={styles.filters}>
          <div className={styles.filterHeading}>
            <div>
              <p className="section-kicker">Recorded activity</p>
              <h2>Event ledger</h2>
            </div>
            <span className={styles.snapshotLabel}>
              Snapshot {eventTime(loadedOutcome.page.generatedAt)}
            </span>
          </div>
          <div className={styles.filterControls}>
            <label className={styles.categorySelect}>
              <span>Event category</span>
              <select
                aria-label="Event category"
                onChange={(event) => setCategory(event.target.value as AuditEventCategory | "all")}
                value={category}
              >
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className={styles.outcomeFilter}>
              <legend>Event outcome</legend>
              <div>
                {outcomeOptions.map((option) => (
                  <button
                    aria-label={`${option.label} events`}
                    aria-pressed={outcome === option.value}
                    key={option.value}
                    onClick={() => setOutcome(option.value)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
            {hasFilters ? (
              <button className={styles.clearButton} onClick={clearFilters} type="button">
                <FilterX aria-hidden="true" size={16} /> Clear filters
              </button>
            ) : null}
          </div>
        </header>

        {events.length === 0 ? (
          <div className={styles.emptyState} role="status">
            <span aria-hidden="true">
              <FilterX size={25} />
            </span>
            <div>
              <h2>{hasFilters ? "No events match this view." : "The ledger is quiet."}</h2>
              <p>
                {hasFilters
                  ? "Change or clear the filters to widen the operator record."
                  : "Authentication and control-plane actions will appear here as they occur."}
              </p>
            </div>
          </div>
        ) : (
          <div className={styles.timeline}>
            {[...grouped.entries()].map(([key, dayEvents]) => (
              <section className={styles.dayGroup} key={key} aria-labelledby={`audit-day-${key}`}>
                <div className={styles.dayHeading}>
                  <time dateTime={dayEvents[0]!.occurredAt} id={`audit-day-${key}`}>
                    {eventDay(dayEvents[0]!.occurredAt)}
                  </time>
                  <span>{dayEvents.length}</span>
                </div>
                <ol>
                  {dayEvents.map((event) => (
                    <li className={styles.eventRow} data-outcome={event.outcome} key={event.id}>
                      <span className={styles.timelineMarker} aria-hidden="true">
                        {event.outcome === "success" ? (
                          <CheckCircle2 size={17} />
                        ) : (
                          <CircleAlert size={17} />
                        )}
                      </span>
                      <div className={styles.eventCopy}>
                        <div className={styles.eventHeading}>
                          <div>
                            <span className={styles.categoryTag}>
                              {categoryLabel(event.category)}
                            </span>
                            <h3>{eventLabel(event)}</h3>
                          </div>
                          <span className={styles.outcomeTag} data-outcome={event.outcome}>
                            {outcomeLabel(event.outcome)}
                          </span>
                        </div>
                        <div className={styles.eventMeta}>
                          <span>
                            <UserRound aria-hidden="true" size={15} />
                            {event.actor.displayName} · {authenticationLabel(event)}
                          </span>
                          <time dateTime={event.occurredAt}>{eventTime(event.occurredAt)}</time>
                          <code>{event.eventType}</code>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}

        {pagination.isError &&
        pagination.variables?.category === filters.category &&
        pagination.variables?.outcome === filters.outcome ? (
          <div className={styles.paginationError} role="alert">
            <CircleAlert aria-hidden="true" size={18} />
            <p>Earlier events could not be loaded. The visible record is still intact.</p>
            <button onClick={() => void loadEarlier()} type="button">
              Retry earlier events
            </button>
          </div>
        ) : null}
        {lastPage.nextCursor ? (
          <footer className={styles.ledgerFooter}>
            <button
              className={styles.loadButton}
              disabled={pagination.isPending}
              onClick={() => void loadEarlier()}
              type="button"
            >
              {pagination.isPending ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={17} />
              ) : (
                <RefreshCw aria-hidden="true" size={17} />
              )}
              Load earlier events
            </button>
            <p>Pages are fixed to this encrypted snapshot so new activity never reshuffles it.</p>
          </footer>
        ) : null}
      </section>
    </>
  );
}

export function AuditTrail({
  client = auditTrailClient,
  displayProfile = "standard",
  embedded = false,
  initialOutcome,
}: AuditTrailProperties) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
      }),
  );
  const content = (
    <QueryClientProvider client={queryClient}>
      <AuditTrailContent
        client={client}
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
      />
    </QueryClientProvider>
  );
  return embedded ? (
    content
  ) : (
    <AuditTrailPageShell displayProfile={displayProfile}>{content}</AuditTrailPageShell>
  );
}
