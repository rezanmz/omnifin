"use client";

import type {
  RequestReviewFilter,
  RequestReviewItem,
  RequestReviewQuery,
} from "@omnifin/contracts/requests";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  CloudOff,
  Film,
  Inbox,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
  Tv,
  Unplug,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  createRequestReviewIdempotencyKey,
  requestReviewClient,
  type RequestReviewClient,
  type RequestReviewLoadOutcome,
  type RequestReviewSnapshot,
} from "../lib/request-review";
import type { ThemePreference } from "../lib/theme";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { useTheme } from "./theme-provider";
import styles from "./request-review.module.css";

export interface RequestReviewProperties {
  client?: RequestReviewClient;
  initialOutcome?: RequestReviewLoadOutcome;
}

type ReviewDecision = "approve" | "decline";
type DecisionState = {
  decision: ReviewDecision;
  error: Error | null;
  idempotencyKey: string;
  item: RequestReviewItem;
  running: boolean;
};

const FILTERS: { label: string; value: RequestReviewFilter }[] = [
  { label: "Pending", value: "pending" },
  { label: "All", value: "all" },
  { label: "Approved", value: "approved" },
  { label: "Declined", value: "declined" },
];

const THEME_OPTIONS: { icon: LucideIcon; label: string; value: ThemePreference }[] = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
];

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

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.layout}>
      <LiquidGlassEnvironment />
      <CinematicBackdrop />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <header className={styles.topbar} data-liquid-glass>
          <BrandMark />
          <div className={styles.topbarActions}>
            <Link className={styles.back} href="/operations/issues" prefetch={false}>
              <CircleAlert aria-hidden="true" size={17} /> Issues
            </Link>
            <Link className={styles.back} href="/">
              <ArrowLeft aria-hidden="true" size={17} /> Discover
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
      "Your current role can browse and request media, while approval decisions remain behind the operator boundary.",
    href: "/",
    icon: LockKeyhole,
    kicker: "Operational boundary",
    title: "Operator access required.",
  },
  not_configured: {
    action: "Configure services",
    detail:
      "Connect and validate one Seerr instance before Omnifin can expose its guarded approval workflow.",
    href: "/settings/connectors",
    icon: Unplug,
    kicker: "No request signal",
    title: "Connect the request plane.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before Omnifin could retrieve the request queue.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Session required",
    title: "Sign in to continue.",
  },
  unavailable: {
    action: null,
    detail: "The gateway or Seerr cannot be reached right now. No request decisions were changed.",
    href: null,
    icon: CloudOff,
    kicker: "Signal interrupted",
    title: "Request review is offline.",
  },
} as const;

function EntryState({
  kind,
  onRetry,
}: {
  kind: Exclude<RequestReviewLoadOutcome["status"], "ready">;
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
      <div aria-busy="true" aria-label="Loading request review" className={styles.loading}>
        <div className={styles.loadingHero}>
          <i />
          <b />
          <span />
        </div>
        <div className={styles.loadingCommand} />
        <div className={styles.loadingList}>
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index}>
              <i />
              <b />
              <em />
            </span>
          ))}
        </div>
        <span className="sr-only">Checking operator access and retrieving pending requests.</span>
      </div>
    </PageFrame>
  );
}

function formatRelativeTime(value: string, generatedAt: string) {
  const minutes = Math.max(
    0,
    Math.round((Date.parse(generatedAt) - Date.parse(value)) / (60 * 1000)),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function seasonLabel(item: RequestReviewItem) {
  if (item.kind === "movie") return "Movie";
  if (!item.seasons || item.seasons.length === 0) return "Series";
  if (item.seasons.length === 1) return `Season ${item.seasons[0]}`;
  return `${item.seasons.length} seasons`;
}

function statusLabel(status: RequestReviewItem["status"]) {
  if (status === "pending") return "Awaiting review";
  if (status === "approved") return "Approved";
  if (status === "declined") return "Declined";
  if (status === "completed") return "Completed";
  return "Failed";
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

  const approving = state.decision === "approve";
  return (
    <div className={styles.dialogBackdrop} data-testid="request-review-dialog-backdrop">
      <div
        aria-describedby="review-decision-detail"
        aria-labelledby="review-decision-title"
        aria-modal="true"
        className={styles.dialog}
        data-liquid-glass
        onKeyDown={keyDown}
        role="dialog"
      >
        <span className={styles.dialogIcon} data-decision={state.decision} aria-hidden="true">
          {approving ? <Check /> : <X />}
        </span>
        <p className="eyebrow">{approving ? "Approve request" : "Decline request"}</p>
        <h2 id="review-decision-title">
          {approving ? "Send this into acquisition?" : "Close this request?"}
        </h2>
        <p id="review-decision-detail">
          <strong>{state.item.title}</strong> was requested by {state.item.requestedBy}. This
          decision is written to Seerr and the Omnifin audit trail.
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
            className={approving ? styles.confirmApprove : styles.confirmDecline}
            disabled={state.running}
            onClick={onConfirm}
            ref={confirmReference}
            type="button"
          >
            {state.running ? (
              <LoaderCircle aria-hidden="true" className={styles.spin} size={17} />
            ) : approving ? (
              <Check aria-hidden="true" size={17} />
            ) : (
              <X aria-hidden="true" size={17} />
            )}
            {state.running
              ? "Writing decision…"
              : approving
                ? "Approve request"
                : "Decline request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestCard({
  generatedAt,
  item,
  onDecision,
}: {
  generatedAt: string;
  item: RequestReviewItem;
  onDecision: (item: RequestReviewItem, decision: ReviewDecision) => void;
}) {
  const Icon = item.kind === "movie" ? Film : Tv;
  return (
    <article className={styles.requestCard} data-status={item.status}>
      <div aria-hidden="true" className={styles.mediaGlyph} data-kind={item.kind}>
        <span>
          <Icon size={24} strokeWidth={1.45} />
        </span>
        <small>{item.kind === "movie" ? "FILM" : "SERIES"}</small>
      </div>
      <div className={styles.requestIdentity}>
        <div className={styles.requestTitleLine}>
          <h3>{item.title}</h3>
          {item.year ? <span>{item.year}</span> : null}
          {item.is4k ? <em>4K</em> : null}
        </div>
        <p>
          <span>{seasonLabel(item)}</span>
          <i aria-hidden="true" />
          <span>Profile {item.qualityProfile}</span>
          <i aria-hidden="true" />
          <span>Requested by {item.requestedBy}</span>
        </p>
      </div>
      <div className={styles.requestAge}>
        <Clock3 aria-hidden="true" size={15} />
        <span>{formatRelativeTime(item.createdAt, generatedAt)}</span>
      </div>
      {item.status === "pending" ? (
        <div className={styles.reviewActions} aria-label={`Review ${item.title}`}>
          <button onClick={() => onDecision(item, "decline")} type="button">
            <X aria-hidden="true" size={17} /> Decline
          </button>
          <button onClick={() => onDecision(item, "approve")} type="button">
            <Check aria-hidden="true" size={17} /> Approve
          </button>
        </div>
      ) : (
        <span className={styles.statusBadge} data-status={item.status}>
          {item.status === "approved" || item.status === "completed" ? (
            <BadgeCheck aria-hidden="true" size={17} />
          ) : (
            <X aria-hidden="true" size={16} />
          )}
          {statusLabel(item.status)}
        </span>
      )}
    </article>
  );
}

function ReadyView({
  client,
  live,
  snapshot: initialSnapshot,
}: {
  client: RequestReviewClient;
  live: boolean;
  snapshot: RequestReviewSnapshot;
}) {
  const initialFilter =
    initialSnapshot.page.status === "all" ? "pending" : initialSnapshot.page.status;
  const [filter, setFilter] = useState<RequestReviewFilter>(initialFilter);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [decision, setDecision] = useState<DecisionState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState("");
  const filterController = useRef<AbortController | null>(null);

  const counts = useMemo(
    () => ({
      approved: snapshot.page.items.filter((item) => item.status === "approved").length,
      pending: snapshot.page.items.filter((item) => item.status === "pending").length,
      people: new Set(snapshot.page.items.map((item) => item.requestedBy)).size,
    }),
    [snapshot.page.items],
  );

  const visibleItems = useMemo(
    () =>
      filter === "all"
        ? snapshot.page.items
        : snapshot.page.items.filter((item) => item.status === filter),
    [filter, snapshot.page.items],
  );

  useEffect(
    () => () => {
      filterController.current?.abort();
    },
    [],
  );

  const requestPage = useCallback(
    async (nextFilter: RequestReviewFilter, cursor: string | null = null) => {
      filterController.current?.abort();
      const controller = new AbortController();
      filterController.current = controller;
      const query: RequestReviewQuery = { cursor, limit: 20, status: nextFilter };
      return client.list(query, controller.signal);
    },
    [client],
  );

  const chooseFilter = async (nextFilter: RequestReviewFilter) => {
    setFilter(nextFilter);
    if (!live) return;
    setRefreshing(true);
    try {
      const page = await requestPage(nextFilter);
      setSnapshot((current) => ({ ...current, page }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(
          error instanceof Error ? error.message : "The request queue could not be refreshed.",
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
      const page = await requestPage(filter);
      setSnapshot((current) => ({ ...current, page }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(
          error instanceof Error ? error.message : "The request queue could not be refreshed.",
        );
      }
    } finally {
      setRefreshing(false);
    }
  };

  const loadMore = async () => {
    if (!snapshot.page.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await requestPage(filter, snapshot.page.nextCursor);
      setSnapshot((current) => ({
        ...current,
        page: {
          ...page,
          items: [...current.page.items, ...page.items],
        },
      }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(error instanceof Error ? error.message : "More requests could not be loaded.");
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const openDecision = (item: RequestReviewItem, nextDecision: ReviewDecision) => {
    try {
      setDecision({
        decision: nextDecision,
        error: null,
        idempotencyKey: createRequestReviewIdempotencyKey(),
        item,
        running: false,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "A secure decision could not be started.");
    }
  };

  const confirmDecision = async () => {
    if (!decision || decision.running) return;
    const current = decision;
    setDecision({ ...current, error: null, running: true });
    try {
      const result = await client.review(
        current.item.id,
        { decision: current.decision },
        {
          csrfToken: snapshot.csrfToken,
          idempotencyKey: current.idempotencyKey,
        },
      );
      setSnapshot((value) => ({
        ...value,
        page: {
          ...value.page,
          items: value.page.items.map((item) =>
            item.id === result.request.id ? result.request : item,
          ),
        },
      }));
      setDecision(null);
      setNotice(
        `${result.request.title} was ${current.decision === "approve" ? "approved" : "declined"}.`,
      );
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("The decision could not be saved.");
      setDecision({ ...current, error: failure, running: false });
    }
  };

  return (
    <PageFrame>
      <section className={styles.hero}>
        <div>
          <p className="eyebrow">Request review</p>
          <h1>Decide what enters the library.</h1>
          <p>
            A calm, accountable queue for Seerr approvals. Every decision is locally authorized,
            idempotent, and recorded without exposing upstream credentials to the browser.
          </p>
        </div>
        <div className={styles.heroPulse} data-empty={counts.pending === 0 || undefined}>
          <span aria-hidden="true">
            {counts.pending === 0 ? <Sparkles size={20} /> : <Inbox size={20} />}
          </span>
          <div>
            <strong>
              {counts.pending === 0 ? "Queue clear" : `${counts.pending} awaiting review`}
            </strong>
            <small>
              {counts.pending === 0 ? "Nothing needs a decision" : "Seerr · guarded mutations"}
            </small>
          </div>
        </div>
      </section>

      <section
        aria-label="Request queue controls"
        className={styles.commandGlass}
        data-liquid-glass
      >
        <div aria-label="Request status" className={styles.filters} role="group">
          {FILTERS.map(({ label, value }) => (
            <button
              aria-pressed={filter === value}
              data-selected={filter === value || undefined}
              key={value}
              onClick={() => void chooseFilter(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <button
          aria-label="Refresh request queue"
          className={styles.refresh}
          disabled={refreshing}
          onClick={() => void refresh()}
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={refreshing ? styles.spin : undefined}
            size={18}
          />
          <span>Refresh</span>
        </button>
      </section>

      <section className={styles.metrics} aria-label="Loaded request summary">
        <Metric icon={Inbox} label="pending" value={counts.pending} />
        <Metric icon={BadgeCheck} label="approved" value={counts.approved} />
        <Metric icon={Layers3} label="requestors" value={counts.people} />
        <span className={styles.secretBoundary}>
          <ShieldCheck aria-hidden="true" size={17} />
          <span>
            <strong>Secret boundary intact</strong>
            <small>Normalized Seerr data only</small>
          </span>
        </span>
      </section>

      <div aria-live="polite" className={styles.liveNotice} role="status">
        {notice}
      </div>

      <section className={styles.queue} aria-labelledby="request-queue-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">Decision queue</p>
            <h2 id="request-queue-heading">
              {filter === "pending"
                ? "Awaiting review"
                : FILTERS.find((item) => item.value === filter)?.label}
            </h2>
          </div>
          <span>{visibleItems.length} loaded</span>
        </div>

        {visibleItems.length > 0 ? (
          <div className={styles.requestList}>
            {visibleItems.map((item) => (
              <RequestCard
                generatedAt={snapshot.page.generatedAt}
                item={item}
                key={item.id}
                onDecision={openDecision}
              />
            ))}
          </div>
        ) : (
          <div className={styles.emptyState} role="status">
            <span aria-hidden="true">
              <Sparkles />
            </span>
            <p className="eyebrow">Queue clear</p>
            <h3>No requests in this view.</h3>
            <p>
              New Seerr requests will appear here when they match this status. No background action
              is needed.
            </p>
          </div>
        )}

        {snapshot.page.nextCursor ? (
          <button
            className={styles.loadMore}
            disabled={loadingMore}
            onClick={() => void loadMore()}
            type="button"
          >
            {loadingMore ? (
              <LoaderCircle aria-hidden="true" className={styles.spin} size={17} />
            ) : (
              <ChevronDown aria-hidden="true" size={17} />
            )}
            {loadingMore ? "Loading requests…" : "Load more requests"}
          </button>
        ) : null}
      </section>

      <footer className={styles.pageFooter}>
        <span>
          <ShieldCheck aria-hidden="true" size={16} /> Local role checked before every decision
        </span>
        <span>
          Updated {formatRelativeTime(snapshot.page.generatedAt, snapshot.page.generatedAt)}
        </span>
      </footer>

      {decision ? (
        <DecisionDialog
          onCancel={() => !decision.running && setDecision(null)}
          onConfirm={() => void confirmDecision()}
          state={decision}
        />
      ) : null}
    </PageFrame>
  );
}

export function RequestReview({
  client = requestReviewClient,
  initialOutcome,
}: RequestReviewProperties) {
  const [outcome, setOutcome] = useState<RequestReviewLoadOutcome | undefined>(initialOutcome);
  const [retryNonce, setRetryNonce] = useState(0);
  const live = initialOutcome === undefined;

  useEffect(() => {
    if (initialOutcome !== undefined && retryNonce === 0) return;
    const controller = new AbortController();
    void client.load(controller.signal).then((next) => {
      if (!controller.signal.aborted) setOutcome(next);
    });
    return () => controller.abort();
  }, [client, initialOutcome, retryNonce]);

  if (outcome === undefined) return <LoadingState />;
  if (outcome.status !== "ready") {
    return (
      <EntryState
        kind={outcome.status}
        onRetry={() => {
          setOutcome(undefined);
          setRetryNonce((value) => value + 1);
        }}
      />
    );
  }
  return <ReadyView client={client} live={live} snapshot={outcome.snapshot} />;
}
