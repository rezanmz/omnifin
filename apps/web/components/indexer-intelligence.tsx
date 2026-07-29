"use client";

import type {
  IndexerApplication,
  IndexerFailure,
  IndexerIntelligenceItem,
} from "@omnifin/contracts/indexers";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Ban,
  Check,
  CircleAlert,
  Clock3,
  CloudOff,
  Gauge,
  History,
  LoaderCircle,
  LockKeyhole,
  Moon,
  Network,
  Radio,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Sun,
  TestTubeDiagonal,
  TriangleAlert,
  Unplug,
  Waves,
  X,
  Monitor,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  IndexerIntelligenceClientError,
  indexerIntelligenceClient,
  type IndexerIntelligenceClient,
  type IndexerIntelligenceLoadOutcome,
  type IndexerIntelligenceSnapshot,
} from "../lib/indexer-intelligence";
import type { ThemePreference } from "../lib/theme";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { useTheme } from "./theme-provider";
import styles from "./indexer-intelligence.module.css";

export interface IndexerIntelligenceProperties {
  client?: IndexerIntelligenceClient;
  initialOutcome?: IndexerIntelligenceLoadOutcome;
}

type Filter = "all" | "attention" | "disabled" | "healthy";
type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "passed"; testedAt: string }
  | { kind: "failed"; message: string };

const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Healthy", value: "healthy" },
  { label: "Attention", value: "attention" },
  { label: "Disabled", value: "disabled" },
];

const THEME_OPTIONS: { icon: LucideIcon; label: string; value: ThemePreference }[] = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
];

function formatNumber(value: number) {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatPercent(value: number) {
  const percent = value * 100;
  return `${percent < 99.5 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][timestamp.getUTCMonth()];
  const hour = timestamp.getUTCHours();
  const displayHour = hour % 12 || 12;
  const minute = String(timestamp.getUTCMinutes()).padStart(2, "0");
  return `${month} ${timestamp.getUTCDate()}, ${displayHour}:${minute} ${hour < 12 ? "AM" : "PM"} UTC`;
}

function statusLabel(indexer: IndexerIntelligenceItem) {
  if (indexer.state === "cooldown") return "Cooling down";
  if (indexer.state === "degraded") return "Needs attention";
  if (indexer.state === "disabled") return "Disabled";
  return "Healthy";
}

function syncLabel(application: IndexerApplication) {
  if (application.syncLevel === "full_sync") return "Full sync";
  if (application.syncLevel === "add_only") return "Add only";
  return "Sync disabled";
}

function failureLabel(failure: IndexerFailure) {
  if (failure.kind === "authentication") return "Authentication";
  if (failure.kind === "rss") return "RSS";
  if (failure.kind === "grab") return "Grab";
  if (failure.kind === "information") return "Information";
  if (failure.kind === "query") return "Search";
  return "Request";
}

function attentionLabel(count: number) {
  return count === 1 ? "1 signal needs attention" : `${formatNumber(count)} signals need attention`;
}

function ThemeControl() {
  const { preference, setPreference } = useTheme();

  const moveSelection = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const key = event.key;
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(key)) {
      return;
    }
    event.preventDefault();
    const lastIndex = THEME_OPTIONS.length - 1;
    const nextIndex =
      key === "Home"
        ? 0
        : key === "End"
          ? lastIndex
          : ["ArrowRight", "ArrowDown"].includes(key)
            ? (currentIndex + 1) % THEME_OPTIONS.length
            : (currentIndex - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    const next = THEME_OPTIONS[nextIndex];
    if (!next) return;
    setPreference(next.value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("button")
      [nextIndex]?.focus();
  };

  return (
    <div aria-label="Color theme" className={styles.themeControl} role="radiogroup">
      {THEME_OPTIONS.map(({ icon: Icon, label, value }, index) => (
        <button
          aria-checked={preference === value}
          aria-label={`${label} theme`}
          data-selected={preference === value || undefined}
          key={value}
          onKeyDown={(event) => moveSelection(event, index)}
          onClick={() => setPreference(value)}
          role="radio"
          tabIndex={preference === value ? 0 : -1}
          type="button"
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.7} />
        </button>
      ))}
    </div>
  );
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.layout}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <header className={styles.topbar} data-liquid-glass>
          <BrandMark />
          <nav aria-label="Operations navigation" className={styles.topbarActions}>
            <Link className={styles.back} href="/operations/health" prefetch={false}>
              <Activity aria-hidden="true" size={16} /> Health
            </Link>
            <Link className={styles.back} href="/operations/downloads" prefetch={false}>
              <Gauge aria-hidden="true" size={16} /> Downloads
            </Link>
            <Link className={styles.back} href="/">
              <ArrowLeft aria-hidden="true" size={17} /> Discover
            </Link>
            <ThemeControl />
          </nav>
        </header>
        {children}
      </main>
    </div>
  );
}

const STATE_COPY = {
  forbidden: {
    action: "Return to discovery",
    detail:
      "Your current role can use media features, but indexer telemetry and test controls require operator access.",
    href: "/",
    icon: LockKeyhole,
    kicker: "Operational boundary",
    title: "Operator access required.",
  },
  not_configured: {
    action: "Configure services",
    detail:
      "Validate and enable one Prowlarr connection to establish a guarded path for statistics and safe tests.",
    href: "/settings/connectors",
    icon: Unplug,
    kicker: "No Prowlarr signal",
    title: "Connect the indexer plane.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before Omnifin could retrieve operational indexer data.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Session required",
    title: "Sign in to continue.",
  },
  unavailable: {
    action: null,
    detail:
      "The gateway or Prowlarr cannot be reached right now. Existing service configuration was not changed.",
    href: null,
    icon: CloudOff,
    kicker: "Signal interrupted",
    title: "Indexer intelligence is offline.",
  },
} as const;

function EntryState({
  kind,
  onRetry,
}: {
  kind: Exclude<IndexerIntelligenceLoadOutcome["status"], "ready">;
  onRetry: () => void;
}) {
  const state = STATE_COPY[kind];
  const Icon = state.icon;
  return (
    <PageFrame>
      <section className={styles.statePanel} role={kind === "unavailable" ? "alert" : "status"}>
        <span className={styles.stateIcon} aria-hidden="true">
          <Icon />
        </span>
        <p className="eyebrow">{state.kicker}</p>
        <h1>{state.title}</h1>
        <p>{state.detail}</p>
        {state.href ? (
          <Link className={styles.primaryAction} href={state.href}>
            {state.action} <ArrowRight aria-hidden="true" size={16} />
          </Link>
        ) : (
          <button className={styles.primaryAction} onClick={onRetry} type="button">
            <RefreshCw aria-hidden="true" size={16} /> Try again
          </button>
        )}
      </section>
    </PageFrame>
  );
}

function LoadingState() {
  return (
    <PageFrame>
      <div aria-busy="true" aria-label="Loading indexer intelligence" className={styles.loading}>
        <div className={styles.loadingHero}>
          <i />
          <b />
          <span />
        </div>
        <div className={styles.loadingMetrics}>
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <div className={styles.loadingGrid}>
          <div>
            {Array.from({ length: 3 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
          <i />
        </div>
        <span className="sr-only">Loading indexers, application sync, and failure history.</span>
      </div>
    </PageFrame>
  );
}

function Metric({
  detail,
  icon: Icon,
  label,
  state,
  value,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  state?: "attention" | "good";
  value: string;
}) {
  return (
    <article className={styles.metric} data-state={state}>
      <Icon aria-hidden="true" size={18} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function TestButton({
  indexer,
  onTest,
  state,
}: {
  indexer: IndexerIntelligenceItem;
  onTest: () => void;
  state: TestState;
}) {
  const running = state.kind === "running";
  return (
    <div className={styles.testControl}>
      <button
        aria-describedby={`indexer-test-status-${indexer.id}`}
        disabled={running || !indexer.enabled}
        onClick={onTest}
        type="button"
      >
        {running ? (
          <LoaderCircle aria-hidden="true" className={styles.spinner} size={15} />
        ) : state.kind === "passed" ? (
          <Check aria-hidden="true" size={15} />
        ) : (
          <TestTubeDiagonal aria-hidden="true" size={15} />
        )}
        {running ? "Testing" : state.kind === "passed" ? "Passed" : "Test"}
      </button>
      <span className="sr-only" id={`indexer-test-status-${indexer.id}`} aria-live="polite">
        {state.kind === "running"
          ? `Testing ${indexer.name}.`
          : state.kind === "passed"
            ? `${indexer.name} passed at ${formatTimestamp(state.testedAt)}.`
            : state.kind === "failed"
              ? `${indexer.name} test failed. ${state.message}`
              : indexer.enabled
                ? `Run a safe connectivity test for ${indexer.name}.`
                : `${indexer.name} is disabled and cannot be tested.`}
      </span>
    </div>
  );
}

function IndexerCard({
  indexer,
  onTest,
  testState,
}: {
  indexer: IndexerIntelligenceItem;
  onTest: () => void;
  testState: TestState;
}) {
  return (
    <article className={styles.indexerCard} data-state={indexer.state}>
      <header>
        <span className={styles.indexerMark} aria-hidden="true">
          <Radio size={18} />
        </span>
        <div>
          <h3>{indexer.name}</h3>
          <p>
            {indexer.protocol} · {indexer.privacy.replace("_", " ")}
          </p>
        </div>
        <span className={styles.status} data-state={indexer.state}>
          <i aria-hidden="true" /> {statusLabel(indexer)}
        </span>
      </header>
      <div className={styles.indexerTelemetry}>
        <span>
          <small>Success</small>
          <strong>
            {indexer.statistics.queries === 0 ? "—" : formatPercent(indexer.statistics.successRate)}
          </strong>
        </span>
        <span>
          <small>Queries</small>
          <strong>{formatNumber(indexer.statistics.queries)}</strong>
        </span>
        <span>
          <small>Avg response</small>
          <strong>{formatNumber(indexer.statistics.averageQueryResponseTimeMs)} ms</strong>
        </span>
        <span>
          <small>Grabs</small>
          <strong>{formatNumber(indexer.statistics.grabs)}</strong>
        </span>
      </div>
      <footer>
        <span>
          {indexer.state === "cooldown" && indexer.disabledUntil
            ? `Disabled until ${formatTimestamp(indexer.disabledUntil)}`
            : indexer.mostRecentFailureAt
              ? `Last failure ${formatTimestamp(indexer.mostRecentFailureAt)}`
              : indexer.supportsSearch
                ? "Search ready"
                : "RSS only"}
        </span>
        <TestButton indexer={indexer} onTest={onTest} state={testState} />
      </footer>
      {testState.kind === "failed" ? (
        <div className={styles.testError} role="alert">
          <CircleAlert aria-hidden="true" size={15} /> {testState.message}
        </div>
      ) : null}
    </article>
  );
}

function ApplicationSync({
  applications,
}: {
  applications: IndexerIntelligenceSnapshot["applications"];
}) {
  return (
    <section className={styles.sidePanel} aria-labelledby="application-sync-title">
      <header className={styles.sectionHeading}>
        <div>
          <p className="section-kicker">Application sync</p>
          <h2 id="application-sync-title">Managed destinations</h2>
        </div>
        <ServerCog aria-hidden="true" size={19} />
      </header>
      {applications.status === "unavailable" ? (
        <div className={styles.inlineState} role="status">
          <CloudOff aria-hidden="true" size={18} />
          <span>
            <strong>Sync signal unavailable</strong>
            <small>Indexer telemetry remains intact.</small>
          </span>
        </div>
      ) : applications.data.items.length === 0 ? (
        <div className={styles.inlineState} role="status">
          <Network aria-hidden="true" size={18} />
          <span>
            <strong>No managed applications</strong>
            <small>Radarr and Sonarr sync modes will appear here.</small>
          </span>
        </div>
      ) : (
        <ul className={styles.applicationList}>
          {applications.data.items.map((application) => (
            <li data-sync={application.syncLevel} key={application.id}>
              <span aria-hidden="true">
                {application.syncLevel === "full_sync" ? (
                  <BadgeCheck size={17} />
                ) : application.syncLevel === "add_only" ? (
                  <Waves size={17} />
                ) : (
                  <Ban size={17} />
                )}
              </span>
              <div>
                <strong>{application.name}</strong>
                <small>{application.implementation}</small>
              </div>
              <em>{syncLabel(application)}</em>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FailureHistory({
  failures,
  loading,
  onLoadMore,
}: {
  failures: IndexerIntelligenceSnapshot["failures"];
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <section className={styles.failurePanel} aria-labelledby="failure-history-title">
      <header className={styles.sectionHeading}>
        <div>
          <p className="section-kicker">Failure history</p>
          <h2 id="failure-history-title">Recent rejected signals</h2>
        </div>
        <History aria-hidden="true" size={19} />
      </header>
      {failures.status === "unavailable" ? (
        <div className={styles.inlineState} role="status">
          <CloudOff aria-hidden="true" size={18} />
          <span>
            <strong>History is temporarily unavailable</strong>
            <small>No raw upstream data was shown.</small>
          </span>
        </div>
      ) : failures.data.items.length === 0 ? (
        <div className={styles.inlineState} role="status">
          <ShieldCheck aria-hidden="true" size={18} />
          <span>
            <strong>No recent failures</strong>
            <small>Prowlarr has a quiet failure log.</small>
          </span>
        </div>
      ) : (
        <ol className={styles.failureList}>
          {failures.data.items.map((failure) => (
            <li key={failure.id}>
              <span className={styles.failureMarker} aria-hidden="true">
                <X size={14} />
              </span>
              <div>
                <span>
                  <strong>{failure.summary}</strong>
                  <em>{failureLabel(failure)}</em>
                </span>
                <small>
                  Indexer {failure.indexerId}
                  {failure.latencyMs !== null ? ` · ${formatNumber(failure.latencyMs)} ms` : ""}
                </small>
              </div>
              <time dateTime={failure.occurredAt}>{formatTimestamp(failure.occurredAt)}</time>
            </li>
          ))}
        </ol>
      )}
      {failures.status === "ready" && failures.data.nextCursor ? (
        <button className={styles.loadMore} disabled={loading} onClick={onLoadMore} type="button">
          {loading ? (
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={15} />
          ) : null}
          {loading ? "Loading" : "Load older failures"}
        </button>
      ) : null}
    </section>
  );
}

function EmptyIndexers() {
  return (
    <section className={styles.emptyIndexers} role="status">
      <span aria-hidden="true">
        <Radio />
      </span>
      <h3>No indexers in this view</h3>
      <p>Adjust the filter, or add an enabled indexer in Prowlarr.</p>
    </section>
  );
}

function ReadyWorkspace({
  client,
  initialSnapshot,
  onReload,
}: {
  client: IndexerIntelligenceClient;
  initialSnapshot: IndexerIntelligenceSnapshot;
  onReload: () => void;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [testStates, setTestStates] = useState<Record<number, TestState>>({});
  const [loadingMore, setLoadingMore] = useState<"failures" | "indexers" | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const visibleIndexers = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return snapshot.indexers.items.filter((indexer) => {
      const matchesTerm = !term || indexer.name.toLocaleLowerCase().includes(term);
      const matchesFilter =
        filter === "all" ||
        (filter === "healthy" && indexer.state === "healthy") ||
        (filter === "disabled" && indexer.state === "disabled") ||
        (filter === "attention" && ["cooldown", "degraded"].includes(indexer.state));
      return matchesTerm && matchesFilter;
    });
  }, [filter, query, snapshot.indexers.items]);

  const successRate =
    snapshot.indexers.summary.queries === 0
      ? 1
      : Math.max(
          0,
          (snapshot.indexers.summary.queries - snapshot.indexers.summary.failedQueries) /
            snapshot.indexers.summary.queries,
        );

  const runTest = async (indexer: IndexerIntelligenceItem) => {
    setTestStates((states) => ({ ...states, [indexer.id]: { kind: "running" } }));
    try {
      const result = await client.test(indexer.id, snapshot.csrfToken);
      setTestStates((states) => ({
        ...states,
        [indexer.id]: { kind: "passed", testedAt: result.testedAt },
      }));
    } catch (error) {
      const message =
        error instanceof IndexerIntelligenceClientError && error.kind === "rate_limited"
          ? "Prowlarr is cooling down. Try again shortly."
          : "The test could not be safely completed.";
      setTestStates((states) => ({ ...states, [indexer.id]: { kind: "failed", message } }));
    }
  };

  const loadMoreIndexers = async () => {
    const cursor = snapshot.indexers.nextCursor;
    if (!cursor) return;
    setLoadingMore("indexers");
    setPageError(null);
    try {
      const page = await client.loadIndexers(cursor);
      setSnapshot((current) => ({
        ...current,
        indexers: {
          ...page,
          items: [...current.indexers.items, ...page.items],
        },
      }));
    } catch {
      setPageError("The next indexer page could not be verified.");
    } finally {
      setLoadingMore(null);
    }
  };

  const loadMoreFailures = async () => {
    if (snapshot.failures.status !== "ready" || !snapshot.failures.data.nextCursor) return;
    setLoadingMore("failures");
    setPageError(null);
    try {
      const page = await client.loadFailures(snapshot.failures.data.nextCursor);
      setSnapshot((current) =>
        current.failures.status === "ready"
          ? {
              ...current,
              failures: {
                data: {
                  ...page,
                  items: [...current.failures.data.items, ...page.items],
                },
                status: "ready",
              },
            }
          : current,
      );
    } catch {
      setPageError("Older failure history could not be verified.");
    } finally {
      setLoadingMore(null);
    }
  };

  return (
    <PageFrame>
      <section className={styles.hero} aria-labelledby="indexer-intelligence-title">
        <div>
          <p className="eyebrow">Prowlarr intelligence</p>
          <h1 id="indexer-intelligence-title">Know every source.</h1>
          <p>
            Read the signal behind every search, sync destination, cooldown, and rejected request—
            without exposing indexer credentials to the browser.
          </p>
        </div>
        <div
          className={styles.heroPulse}
          data-attention={snapshot.indexers.summary.attention > 0 || undefined}
        >
          <span aria-hidden="true">
            <Activity size={19} />
          </span>
          <div>
            <strong>
              {snapshot.indexers.summary.attention > 0
                ? attentionLabel(snapshot.indexers.summary.attention)
                : "Indexer plane nominal"}
            </strong>
            <small>24-hour verified window</small>
          </div>
        </div>
      </section>

      <div className={styles.commandGlass}>
        <label className={styles.searchControl}>
          <span className="sr-only">Search indexers</span>
          <Search aria-hidden="true" size={17} />
          <input
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an indexer"
            type="search"
            value={query}
          />
        </label>
        <div aria-label="Filter indexers" className={styles.filters} role="group">
          {FILTERS.map(({ label, value }) => (
            <button
              aria-pressed={filter === value}
              data-selected={filter === value || undefined}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <button
          aria-label="Refresh indexer intelligence"
          className={styles.refresh}
          onClick={onReload}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={17} />
        </button>
      </div>

      {snapshot.indexers.state === "degraded" ? (
        <div className={styles.degradedNotice} role="status">
          <TriangleAlert aria-hidden="true" size={19} />
          <span>
            <strong>Partial intelligence</strong>
            One Prowlarr telemetry source is unavailable. Verified indexers remain visible.
          </span>
        </div>
      ) : null}

      <section className={styles.metrics} aria-label="24-hour indexer summary">
        <Metric
          detail={`${snapshot.indexers.summary.enabled} enabled`}
          icon={Radio}
          label="Indexers"
          value={formatNumber(snapshot.indexers.summary.total)}
        />
        <Metric
          detail={`${formatNumber(snapshot.indexers.summary.failedQueries)} rejected`}
          icon={Gauge}
          label="Query success"
          {...(snapshot.indexers.summary.queries === 0
            ? {}
            : {
                state: successRate >= 0.98 ? ("good" as const) : ("attention" as const),
              })}
          value={snapshot.indexers.summary.queries === 0 ? "—" : formatPercent(successRate)}
        />
        <Metric
          detail="last 24 hours"
          icon={Waves}
          label="Queries"
          value={formatNumber(snapshot.indexers.summary.queries)}
        />
        <Metric
          detail={`${snapshot.indexers.summary.disabled} disabled`}
          icon={CircleAlert}
          label="Attention"
          state={snapshot.indexers.summary.attention > 0 ? "attention" : "good"}
          value={formatNumber(snapshot.indexers.summary.attention)}
        />
      </section>

      {pageError ? (
        <div className={styles.pageError} role="alert">
          <CircleAlert aria-hidden="true" size={17} /> {pageError}
        </div>
      ) : null}

      <div className={styles.workspace}>
        <section className={styles.indexerPanel} aria-labelledby="indexer-list-title">
          <header className={styles.sectionHeading}>
            <div>
              <p className="section-kicker">Source telemetry</p>
              <h2 id="indexer-list-title">Indexers</h2>
            </div>
            <span>{visibleIndexers.length.toString().padStart(2, "0")}</span>
          </header>
          {visibleIndexers.length === 0 ? (
            <EmptyIndexers />
          ) : (
            <div className={styles.indexerList}>
              {visibleIndexers.map((indexer) => (
                <IndexerCard
                  indexer={indexer}
                  key={indexer.id}
                  onTest={() => void runTest(indexer)}
                  testState={testStates[indexer.id] ?? { kind: "idle" }}
                />
              ))}
            </div>
          )}
          {snapshot.indexers.nextCursor ? (
            <button
              className={styles.loadMore}
              disabled={loadingMore === "indexers"}
              onClick={() => void loadMoreIndexers()}
              type="button"
            >
              {loadingMore === "indexers" ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={15} />
              ) : null}
              {loadingMore === "indexers" ? "Loading" : "Load more indexers"}
            </button>
          ) : null}
        </section>
        <aside className={styles.sidebar}>
          <ApplicationSync applications={snapshot.applications} />
          <section className={styles.boundaryPanel} aria-labelledby="security-boundary-title">
            <span aria-hidden="true">
              <ShieldCheck size={19} />
            </span>
            <div>
              <p className="section-kicker">Security boundary</p>
              <h2 id="security-boundary-title">Tests stay server-side.</h2>
              <p>
                Omnifin retrieves the secret-bearing provider record inside the gateway, tests it,
                then returns only the outcome.
              </p>
            </div>
          </section>
        </aside>
      </div>

      <FailureHistory
        failures={snapshot.failures}
        loading={loadingMore === "failures"}
        onLoadMore={() => void loadMoreFailures()}
      />
      <footer className={styles.pageFooter}>
        <span>
          <Clock3 aria-hidden="true" size={15} /> Generated{" "}
          {formatTimestamp(snapshot.indexers.generatedAt)}
        </span>
        <span>Raw queries, hosts, sources, and credentials are excluded.</span>
      </footer>
    </PageFrame>
  );
}

export function IndexerIntelligence({
  client = indexerIntelligenceClient,
  initialOutcome,
}: IndexerIntelligenceProperties) {
  const [outcome, setOutcome] = useState<IndexerIntelligenceLoadOutcome | null>(
    initialOutcome ?? null,
  );
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (initialOutcome && revision === 0) return;
    let active = true;
    void client.load().then((result) => {
      if (active) setOutcome(result);
    });
    return () => {
      active = false;
    };
  }, [client, initialOutcome, revision]);

  const reload = () => {
    setOutcome(null);
    setRevision((value) => value + 1);
  };
  if (outcome === null) return <LoadingState />;
  if (outcome.status !== "ready") return <EntryState kind={outcome.status} onRetry={reload} />;
  return (
    <ReadyWorkspace
      client={client}
      initialSnapshot={outcome.snapshot}
      key={`${outcome.snapshot.indexers.generatedAt}:${revision}`}
      onReload={reload}
    />
  );
}
