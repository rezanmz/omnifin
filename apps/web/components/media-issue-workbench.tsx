"use client";

import type {
  MediaIssueFilter,
  MediaIssueSourceFilter,
  MediaIssueWorkbenchItem,
  MediaIssueWorkbenchQuery,
} from "@omnifin/contracts/issues";
import {
  AlertTriangle,
  ArrowLeft,
  Captions,
  Check,
  CircleAlert,
  Clock3,
  CloudOff,
  Film,
  Gauge,
  Headphones,
  Inbox,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sun,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  createMediaIssueIdempotencyKey,
  mediaIssueClient,
  type MediaIssueClient,
  type MediaIssueLoadOutcome,
  type MediaIssueSnapshot,
} from "../lib/media-issues";
import type { ThemePreference } from "../lib/theme";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { useTheme } from "./theme-provider";
import styles from "./media-issue-workbench.module.css";

export interface MediaIssueWorkbenchProperties {
  client?: MediaIssueClient;
  initialOutcome?: MediaIssueLoadOutcome;
}

type DecisionState = {
  error: Error | null;
  idempotencyKey: string;
  issue: MediaIssueWorkbenchItem;
  returnFocus: HTMLButtonElement | null;
  running: boolean;
  status: "open" | "resolved";
};

const STATUS_FILTERS: { label: string; value: MediaIssueFilter }[] = [
  { label: "Open", value: "open" },
  { label: "Resolved", value: "resolved" },
  { label: "All", value: "all" },
];

const SOURCE_FILTERS: { label: string; value: MediaIssueSourceFilter }[] = [
  { label: "Every source", value: "all" },
  { label: "Omnifin", value: "omnifin" },
  { label: "Seerr", value: "seerr" },
];

const THEME_OPTIONS: { icon: LucideIcon; label: string; value: ThemePreference }[] = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
];

const CATEGORY_PRESENTATION: Record<
  MediaIssueWorkbenchItem["category"],
  { icon: LucideIcon; label: string }
> = {
  audio: { icon: Headphones, label: "Audio" },
  buffering: { icon: Waves, label: "Buffering" },
  other: { icon: CircleAlert, label: "Other" },
  subtitles: { icon: Captions, label: "Subtitles" },
  sync: { icon: Radio, label: "A/V sync" },
  video_quality: { icon: Gauge, label: "Video quality" },
};

function ThemeControl() {
  const { preference, setPreference } = useTheme();

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const lastIndex = THEME_OPTIONS.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? lastIndex
          : ["ArrowRight", "ArrowDown"].includes(event.key)
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
          onClick={() => setPreference(value)}
          onKeyDown={(event) => moveSelection(event, index)}
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

function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.layout}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <header className={styles.topbar} data-liquid-glass>
          <BrandMark />
          <div className={styles.topbarActions}>
            <Link className={styles.back} href="/operations/requests" prefetch={false}>
              <ArrowLeft aria-hidden="true" size={17} /> Requests
            </Link>
            <Link className={styles.back} href="/">
              Discover
            </Link>
            <ThemeControl />
          </div>
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
      "Your current role can report playback problems, while resolving issues remains behind the operator boundary.",
    href: "/",
    icon: LockKeyhole,
    kicker: "Operational boundary",
    title: "Operator access required.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before Omnifin could retrieve the issue queue.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Session required",
    title: "Sign in to continue.",
  },
  unavailable: {
    action: null,
    detail: "The gateway cannot be reached right now. No issue decisions were changed.",
    href: null,
    icon: CloudOff,
    kicker: "Signal interrupted",
    title: "Issue management is offline.",
  },
} as const;

function EntryState({
  kind,
  onRetry,
}: {
  kind: Exclude<MediaIssueLoadOutcome["status"], "ready">;
  onRetry: () => void;
}) {
  const state = STATE_COPY[kind];
  const Icon = state.icon;
  return (
    <PageFrame>
      <section className={styles.statePanel} role={kind === "unavailable" ? "alert" : "status"}>
        <span aria-hidden="true" className={styles.stateIcon}>
          <Icon />
        </span>
        <p className="eyebrow">{state.kicker}</p>
        <h1>{state.title}</h1>
        <p>{state.detail}</p>
        {state.href ? (
          <Link className={styles.primaryAction} href={state.href}>
            {state.action}
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
      <div aria-busy="true" aria-label="Loading issue workbench" className={styles.loading}>
        <div className={styles.loadingHero}>
          <i />
          <b />
          <span />
        </div>
        <div className={styles.loadingControls} />
        <div className={styles.loadingList}>
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index}>
              <i />
              <b />
              <em />
            </span>
          ))}
        </div>
        <span className="sr-only">Checking operator access and retrieving media issues.</span>
      </div>
    </PageFrame>
  );
}

function formatRelativeTime(value: string, generatedAt: string) {
  const minutes = Math.max(
    0,
    Math.round((Date.parse(generatedAt) - Date.parse(value)) / (60 * 1_000)),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function formatPosition(positionSeconds: number | null) {
  if (positionSeconds === null) return null;
  const minutes = Math.floor(positionSeconds / 60);
  const seconds = positionSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function mediaLabel(issue: MediaIssueWorkbenchItem) {
  const suffix = issue.year ? ` · ${issue.year}` : "";
  if (issue.kind === "episode") {
    return `Season ${issue.seasonNumber}, episode ${issue.episodeNumber}${suffix}`;
  }
  if (issue.kind === "series") return `Series${suffix}`;
  if (issue.kind === "movie") return `Movie${suffix}`;
  return `Media${suffix}`;
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <span className={styles.metric}>
      <Icon aria-hidden="true" size={17} />
      <span>
        <strong>{value}</strong>
        <small>{label}</small>
      </span>
    </span>
  );
}

function IssueCard({
  generatedAt,
  issue,
  onDecision,
}: {
  generatedAt: string;
  issue: MediaIssueWorkbenchItem;
  onDecision: (issue: MediaIssueWorkbenchItem, trigger: HTMLButtonElement) => void;
}) {
  const category = CATEGORY_PRESENTATION[issue.category];
  const Icon = category.icon;
  const position = formatPosition(issue.positionSeconds);
  return (
    <article className={styles.issueCard} data-liquid-glass data-source={issue.source}>
      <span aria-hidden="true" className={styles.issueGlyph}>
        <Icon />
      </span>
      <div className={styles.issueBody}>
        <div className={styles.issueHeading}>
          <div>
            <div className={styles.issueMeta}>
              <span>{category.label}</span>
              <span>{mediaLabel(issue)}</span>
              <span>{formatRelativeTime(issue.updatedAt, generatedAt)}</span>
            </div>
            <h2>{issue.title}</h2>
          </div>
          <span className={styles.sourceBadge} data-source={issue.source}>
            {issue.source === "omnifin" ? "Live playback" : "Seerr"}
          </span>
        </div>
        <p className={styles.summary}>{issue.summary ?? "No additional context was provided."}</p>
        <div className={styles.issueFooter}>
          <div className={styles.reporter}>
            <span>
              Reported by <strong>{issue.reportedBy}</strong>
            </span>
            {position ? (
              <span>
                <Clock3 aria-hidden="true" size={14} /> at {position}
              </span>
            ) : null}
          </div>
          <button
            className={issue.status === "open" ? styles.resolveAction : styles.reopenAction}
            onClick={(event) => onDecision(issue, event.currentTarget)}
            type="button"
          >
            {issue.status === "open" ? (
              <Check aria-hidden="true" size={17} />
            ) : (
              <RotateCcw aria-hidden="true" size={16} />
            )}
            {issue.status === "open" ? "Resolve" : "Reopen"}
          </button>
        </div>
      </div>
    </article>
  );
}

function DecisionDialog({
  onCancel,
  onConfirm,
  state,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  state: DecisionState;
}) {
  const confirmReference = useRef<HTMLButtonElement>(null);
  const resolving = state.status === "resolved";

  useEffect(() => {
    confirmReference.current?.focus();
  }, []);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !state.running) {
      event.preventDefault();
      onCancel();
    }
    if (event.key !== "Tab") return;
    const buttons =
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    const first = buttons[0];
    const last = buttons.item(buttons.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className={styles.dialogBackdrop} data-testid="issue-dialog-backdrop">
      <div
        aria-describedby="issue-decision-detail"
        aria-labelledby="issue-decision-title"
        aria-modal="true"
        className={styles.dialog}
        data-liquid-glass
        onKeyDown={keyDown}
        role="dialog"
      >
        <span
          aria-hidden="true"
          className={styles.dialogIcon}
          data-resolving={resolving || undefined}
        >
          {resolving ? <Check /> : <RotateCcw />}
        </span>
        <p className="eyebrow">{resolving ? "Resolve issue" : "Reopen issue"}</p>
        <h2 id="issue-decision-title">
          {resolving ? "Mark issue resolved?" : "Reopen this issue?"}
        </h2>
        <p id="issue-decision-detail">
          <strong>{state.issue.title}</strong> will be marked {state.status} in{" "}
          {state.issue.source === "seerr" ? "Seerr" : "Omnifin"}. The decision is recorded in the
          audit trail.
        </p>
        {state.error ? (
          <div className={styles.dialogError} role="alert">
            <CircleAlert aria-hidden="true" size={17} />
            <span>{state.error.message}</span>
          </div>
        ) : null}
        <div className={styles.dialogActions}>
          <button disabled={state.running} onClick={onCancel} type="button">
            Keep reviewing
          </button>
          <button
            className={styles.confirmAction}
            disabled={state.running}
            onClick={onConfirm}
            ref={confirmReference}
            type="button"
          >
            {state.running ? (
              <LoaderCircle aria-hidden="true" className={styles.spin} size={17} />
            ) : resolving ? (
              <Check aria-hidden="true" size={17} />
            ) : (
              <RotateCcw aria-hidden="true" size={16} />
            )}
            {state.running ? "Writing decision…" : resolving ? "Resolve issue" : "Reopen issue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReadyView({
  client,
  live,
  snapshot: initialSnapshot,
}: {
  client: MediaIssueClient;
  live: boolean;
  snapshot: MediaIssueSnapshot;
}) {
  const initialStatus =
    initialSnapshot.page.status === "all" ? "open" : initialSnapshot.page.status;
  const [status, setStatus] = useState<MediaIssueFilter>(initialStatus);
  const [source, setSource] = useState<MediaIssueSourceFilter>(initialSnapshot.page.source);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [decision, setDecision] = useState<DecisionState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const requestController = useRef<AbortController | null>(null);

  const visibleItems = useMemo(
    () =>
      snapshot.page.items.filter(
        (issue) =>
          (status === "all" || issue.status === status) &&
          (source === "all" || issue.source === source),
      ),
    [snapshot.page.items, source, status],
  );
  const counts = useMemo(
    () => ({
      local: snapshot.page.items.filter((issue) => issue.source === "omnifin").length,
      open: snapshot.page.items.filter((issue) => issue.status === "open").length,
      seerr: snapshot.page.items.filter((issue) => issue.source === "seerr").length,
    }),
    [snapshot.page.items],
  );
  const degradedSources = Object.entries(snapshot.page.sourceStates).filter(
    ([, state]) => state !== "available",
  ) as ["omnifin" | "seerr", "unavailable" | "unconfigured"][];

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    [],
  );

  const requestPage = useCallback(
    async (nextStatus: MediaIssueFilter, nextSource: MediaIssueSourceFilter) => {
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      const query: MediaIssueWorkbenchQuery = {
        limit: 50,
        source: nextSource,
        status: nextStatus,
      };
      return client.list(query, controller.signal);
    },
    [client],
  );

  const chooseFilters = async (
    nextStatus: MediaIssueFilter,
    nextSource: MediaIssueSourceFilter,
  ) => {
    setStatus(nextStatus);
    setSource(nextSource);
    if (!live) return;
    setRefreshing(true);
    setNotice("");
    try {
      const page = await requestPage(nextStatus, nextSource);
      setSnapshot((current) => ({ ...current, page }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(
          error instanceof Error ? error.message : "The issue queue could not be refreshed.",
        );
      }
    } finally {
      setRefreshing(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setNotice("");
    try {
      const page = await requestPage(status, source);
      setSnapshot((current) => ({ ...current, page }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(
          error instanceof Error ? error.message : "The issue queue could not be refreshed.",
        );
      }
    } finally {
      setRefreshing(false);
    }
  };

  const closeDecision = () => {
    const returnFocus = decision?.returnFocus;
    setDecision(null);
    globalThis.requestAnimationFrame?.(() => returnFocus?.focus());
  };

  const openDecision = (issue: MediaIssueWorkbenchItem, trigger: HTMLButtonElement) => {
    try {
      setDecision({
        error: null,
        idempotencyKey: createMediaIssueIdempotencyKey(),
        issue,
        returnFocus: trigger,
        running: false,
        status: issue.status === "open" ? "resolved" : "open",
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "A secure decision could not be started.");
    }
  };

  const confirmDecision = async () => {
    if (!decision || decision.running) return;
    setDecision({ ...decision, error: null, running: true });
    try {
      const result = await client.updateStatus(
        decision.issue.id,
        { status: decision.status },
        {
          csrfToken: snapshot.csrfToken,
          idempotencyKey: decision.idempotencyKey,
        },
      );
      setSnapshot((current) => ({
        ...current,
        page: {
          ...current.page,
          items: current.page.items.map((issue) =>
            issue.id === result.issue.id ? result.issue : issue,
          ),
        },
      }));
      setNotice(
        `${result.issue.title} was ${result.issue.status === "resolved" ? "resolved" : "reopened"}.${
          result.replayed ? " The existing decision was confirmed." : ""
        }`,
      );
      closeDecision();
    } catch (error) {
      setDecision((current) =>
        current
          ? {
              ...current,
              error:
                error instanceof Error
                  ? error
                  : new Error("The issue decision could not be completed."),
              running: false,
            }
          : current,
      );
    }
  };

  return (
    <PageFrame>
      <div aria-hidden={decision ? true : undefined} inert={decision ? true : undefined}>
        <section className={styles.hero}>
          <div>
            <p className="eyebrow">Playback care · one accountable queue</p>
            <h1>Close the loop on every stream.</h1>
            <p>
              Bring in-player reports and Seerr issues into one guarded view. Omnifin keeps raw
              service identifiers behind the gateway while operators resolve the human problem.
            </p>
          </div>
          <div className={styles.heroPulse} data-empty={counts.open === 0 || undefined}>
            <span aria-hidden="true">{counts.open === 0 ? <Check /> : <Sparkles />}</span>
            <div>
              <strong>
                {counts.open === 0 ? "Playback clear" : `${counts.open} open signals`}
              </strong>
              <small>
                {counts.open === 0 ? "Nothing needs attention" : "Ready for operator care"}
              </small>
            </div>
          </div>
        </section>

        <section aria-label="Issue filters" className={styles.commandGlass} data-liquid-glass>
          <div className={styles.filterGroup}>
            <span>Status</span>
            <div>
              {STATUS_FILTERS.map((filter) => (
                <button
                  aria-pressed={status === filter.value}
                  data-selected={status === filter.value || undefined}
                  key={filter.value}
                  onClick={() => void chooseFilters(filter.value, source)}
                  type="button"
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.filterGroup}>
            <span>Source</span>
            <div>
              {SOURCE_FILTERS.map((filter) => (
                <button
                  aria-pressed={source === filter.value}
                  data-selected={source === filter.value || undefined}
                  key={filter.value}
                  onClick={() => void chooseFilters(status, filter.value)}
                  type="button"
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
          <button
            aria-label="Refresh issues"
            className={styles.refresh}
            disabled={refreshing}
            onClick={() => void refresh()}
            type="button"
          >
            <RefreshCw
              aria-hidden="true"
              className={refreshing ? styles.spin : undefined}
              size={17}
            />
            Refresh
          </button>
        </section>

        <div className={styles.metrics}>
          <Metric icon={CircleAlert} label="open now" value={counts.open} />
          <Metric icon={Film} label="player reports" value={counts.local} />
          <Metric icon={Layers3} label="Seerr issues" value={counts.seerr} />
          <div className={styles.secretBoundary}>
            <ShieldCheck aria-hidden="true" size={19} />
            <span>
              <strong>Opaque boundary intact</strong>
              <small>Service IDs and credentials stay server-side</small>
            </span>
          </div>
        </div>

        {degradedSources.length > 0 ? (
          <div className={styles.degraded} role="status">
            <AlertTriangle aria-hidden="true" size={18} />
            <span>
              <strong>Partial view</strong>
              {degradedSources.map(([name, state]) => (
                <small key={name}>
                  {name === "seerr" ? "Seerr" : "Omnifin"} is {state.replace("_", " ")}.
                </small>
              ))}
            </span>
            {snapshot.page.sourceStates.seerr === "unconfigured" ? (
              <Link href="/settings/connectors">Connect Seerr</Link>
            ) : null}
          </div>
        ) : null}

        <section aria-labelledby="issue-list-heading" className={styles.issueSection}>
          <div className={styles.sectionHeading}>
            <div>
              <p className="eyebrow">Signal ledger</p>
              <h2 id="issue-list-heading">
                {status === "open"
                  ? "Needs attention"
                  : status === "resolved"
                    ? "Resolved"
                    : "All issues"}
              </h2>
            </div>
            <span>{visibleItems.length} visible</span>
          </div>

          {notice ? (
            <div className={styles.notice} role="status">
              {notice}
              <button aria-label="Dismiss notice" onClick={() => setNotice("")} type="button">
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}

          {visibleItems.length > 0 ? (
            <div className={styles.issueList}>
              {visibleItems.map((issue) => (
                <IssueCard
                  generatedAt={snapshot.page.generatedAt}
                  issue={issue}
                  key={issue.id}
                  onDecision={openDecision}
                />
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <span aria-hidden="true">
                <Inbox />
              </span>
              <p className="eyebrow">Queue clear</p>
              <h2>No issues in this view.</h2>
              <p>Change the status or source filter, or enjoy the quiet.</p>
            </div>
          )}

          {snapshot.page.truncated ? (
            <p className={styles.truncated}>Showing the newest {snapshot.page.limit} issues.</p>
          ) : null}
        </section>

        <footer className={styles.pageFooter}>
          <span>
            <ShieldCheck aria-hidden="true" size={15} /> Every decision is role-checked, idempotent,
            and audited.
          </span>
          <span>
            Updated {formatRelativeTime(snapshot.page.generatedAt, snapshot.page.generatedAt)}
          </span>
        </footer>
      </div>

      {decision ? (
        <DecisionDialog
          onCancel={closeDecision}
          onConfirm={() => void confirmDecision()}
          state={decision}
        />
      ) : null}
    </PageFrame>
  );
}

export function MediaIssueWorkbench({
  client = mediaIssueClient,
  initialOutcome,
}: MediaIssueWorkbenchProperties) {
  const [outcome, setOutcome] = useState<MediaIssueLoadOutcome | undefined>(initialOutcome);
  const [loadRevision, setLoadRevision] = useState(0);

  useEffect(() => {
    if (initialOutcome !== undefined && loadRevision === 0) return;
    const controller = new AbortController();
    void client.load(controller.signal).then((result) => {
      if (!controller.signal.aborted) setOutcome(result);
    });
    return () => controller.abort();
  }, [client, initialOutcome, loadRevision]);

  if (!outcome) return <LoadingState />;
  if (outcome.status !== "ready") {
    return (
      <EntryState
        kind={outcome.status}
        onRetry={() => {
          setOutcome(undefined);
          setLoadRevision((revision) => revision + 1);
        }}
      />
    );
  }
  return (
    <ReadyView client={client} live={initialOutcome === undefined} snapshot={outcome.snapshot} />
  );
}
