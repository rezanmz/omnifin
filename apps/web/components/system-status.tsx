"use client";

import type {
  StorageCapacity,
  SystemStatusResponse,
  SystemStatusSource,
} from "@omnifin/contracts/system";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  CloudOff,
  Database,
  Gauge,
  HardDrive,
  LockKeyhole,
  Monitor,
  Moon,
  RadioTower,
  RefreshCw,
  Server,
  Sun,
  TriangleAlert,
  Waves,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  systemStatusClient,
  type SystemStatusClient,
  type SystemStatusLiveStatus,
  type SystemStatusLoadOutcome,
} from "../lib/system-status";
import type { ThemePreference } from "../lib/theme";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { useTheme } from "./theme-provider";
import styles from "./system-status.module.css";

export interface SystemStatusProperties {
  client?: SystemStatusClient;
  initialOutcome?: SystemStatusLoadOutcome;
  live?: boolean;
}

const THEME_OPTIONS: { icon: LucideIcon; label: string; value: ThemePreference }[] = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
];

const SOURCE_ICONS = {
  prowlarr: RadioTower,
  radarr: Gauge,
  sonarr: Waves,
} as const satisfies Record<SystemStatusSource["service"], LucideIcon>;

function formatBytes(value: number) {
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(1)} TB`;
  if (value >= 1_000_000_000) return `${Math.round(value / 1_000_000_000)} GB`;
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)} MB`;
  return `${Math.round(value / 1_000)} KB`;
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value);
  const hour = timestamp.getUTCHours();
  const minute = String(timestamp.getUTCMinutes()).padStart(2, "0");
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"} UTC`;
}

function statusCopy(status: SystemStatusResponse, attentionCount: number) {
  if (status.state === "degraded") {
    return {
      detail: "Healthy services stay visible while interrupted signals remain clearly isolated.",
      kicker: "Partial visibility",
      title: "The stack is holding, with gaps.",
    };
  }
  if (
    status.summary.attentionSources > 0 ||
    status.summary.warningStorage > 0 ||
    status.summary.criticalStorage > 0
  ) {
    return {
      detail: `The control plane is connected. ${attentionCount === 1 ? "One focused signal deserves" : `${attentionCount} focused signals deserve`} your attention.`,
      kicker: "Signal concentrated",
      title: `${attentionCount === 1 ? "One clear thing" : `${attentionCount} clear things`} to check.`,
    };
  }
  return {
    detail: "Every connected acquisition service is responding within its expected envelope.",
    kicker: "Stack synchronized",
    title: "Everything is in rhythm.",
  };
}

function sourceStatusLabel(source: SystemStatusSource) {
  if (source.status === "unavailable") return "Offline";
  if (source.status === "attention") return "Attention";
  return "Healthy";
}

function capacityPercent(storage: StorageCapacity) {
  return Math.max(0, Math.min(100, (storage.freeBytes / storage.totalBytes) * 100));
}

function ThemeControl() {
  const { preference, setPreference } = useTheme();

  const moveSelection = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
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
          <nav aria-label="Operations navigation" className={styles.topbarActions}>
            <Link aria-current="page" className={styles.activeNav} href="/operations/health">
              <Activity aria-hidden="true" size={16} /> Health
            </Link>
            <Link className={styles.navLink} href="/operations/downloads" prefetch={false}>
              <HardDrive aria-hidden="true" size={16} /> Downloads
            </Link>
            <Link className={styles.navLink} href="/operations/indexers" prefetch={false}>
              <RadioTower aria-hidden="true" size={16} /> Indexers
            </Link>
            <Link className={styles.back} href="/" prefetch={false}>
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

const BOUNDARY_COPY = {
  forbidden: {
    action: "Return to discovery",
    detail:
      "Your current role can use media features, but infrastructure telemetry requires operator access.",
    href: "/",
    icon: LockKeyhole,
    kicker: "Operational boundary",
    title: "Operator access required.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before Omnifin could retrieve protected system telemetry.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Session required",
    title: "Sign in to continue.",
  },
  unavailable: {
    action: null,
    detail:
      "The control plane cannot be reached right now. Existing services and storage were not changed.",
    href: null,
    icon: CloudOff,
    kicker: "Signal interrupted",
    title: "System telemetry is offline.",
  },
} as const;

function BoundaryState({
  onRetry,
  status,
}: {
  onRetry: () => void;
  status: keyof typeof BOUNDARY_COPY;
}) {
  const copy = BOUNDARY_COPY[status];
  const Icon = copy.icon;
  return (
    <PageFrame>
      <section className={styles.statePanel} role={status === "unavailable" ? "alert" : "status"}>
        <span className={styles.stateIcon} aria-hidden="true">
          <Icon />
        </span>
        <p className="eyebrow">{copy.kicker}</p>
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
        {copy.action && copy.href ? (
          <Link className={styles.primaryAction} href={copy.href}>
            {copy.action}
          </Link>
        ) : (
          <button className={styles.primaryAction} onClick={onRetry} type="button">
            <RefreshCw aria-hidden="true" size={17} /> Retry
          </button>
        )}
      </section>
    </PageFrame>
  );
}

function LoadingState() {
  return (
    <PageFrame>
      <div
        aria-busy="true"
        aria-label="Loading system status"
        className={styles.loading}
        role="status"
      >
        <section className={styles.heroSkeleton} data-liquid-glass>
          <span />
          <span />
          <span />
        </section>
        <section className={styles.sourceSkeletons}>
          {[0, 1, 2].map((item) => (
            <div data-liquid-glass key={item}>
              <span />
              <span />
              <span />
            </div>
          ))}
        </section>
      </div>
    </PageFrame>
  );
}

function UnconfiguredState() {
  return (
    <PageFrame>
      <section className={styles.statePanel} role="status">
        <span className={styles.stateIcon} aria-hidden="true">
          <Server />
        </span>
        <p className="eyebrow">No acquisition signal</p>
        <h1>Connect the stack.</h1>
        <p>
          Add and validate Radarr, Sonarr, or Prowlarr to reveal service health and private storage
          capacity in one place.
        </p>
        <Link className={styles.primaryAction} href="/settings/connectors">
          Configure services
        </Link>
      </section>
    </PageFrame>
  );
}

function SourcePanel({ source }: { source: SystemStatusSource }) {
  const Icon = SOURCE_ICONS[source.service];
  return (
    <article className={styles.sourcePanel} data-state={source.status} data-liquid-glass>
      <div className={styles.sourceHeader}>
        <span className={styles.sourceIcon} aria-hidden="true">
          <Icon />
        </span>
        <div>
          <p>{source.service}</p>
          <h3>{source.displayName}</h3>
        </div>
        <span className={styles.sourceState}>
          <i aria-hidden="true" /> {sourceStatusLabel(source)}
        </span>
      </div>
      {source.failure ? (
        <p className={styles.sourceFailure} role="status">
          <CloudOff aria-hidden="true" size={16} /> {source.failure.message}
        </p>
      ) : null}
      {source.signals.length > 0 ? (
        <ul className={styles.signalList}>
          {source.signals.map((signal) => (
            <li data-severity={signal.severity} key={signal.id}>
              <span aria-hidden="true">
                {signal.severity === "error" ? (
                  <TriangleAlert />
                ) : signal.severity === "warning" ? (
                  <AlertTriangle />
                ) : (
                  <Activity />
                )}
              </span>
              <div>
                <strong>{signal.sourceLabel}</strong>
                <p>{signal.message}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : source.status === "healthy" ? (
        <p className={styles.quietSignal}>
          <Check aria-hidden="true" size={17} /> No active service warnings
        </p>
      ) : null}
      <footer className={styles.sourceFooter}>
        <span>{source.signals.length} signals</span>
        <span>{source.storage.length} volumes</span>
      </footer>
    </article>
  );
}

function CapacityMeter({ storage }: { storage: StorageCapacity }) {
  const freePercent = capacityPercent(storage);
  const usedPercent = 100 - freePercent;
  return (
    <article className={styles.capacityRow} data-state={storage.state}>
      <div className={styles.capacityCopy}>
        <span className={styles.capacityIcon} aria-hidden="true">
          <Database />
        </span>
        <div>
          <h3>{storage.label}</h3>
          <p>
            <strong>{formatBytes(storage.freeBytes)}</strong> free of{" "}
            {formatBytes(storage.totalBytes)}
          </p>
        </div>
        <span className={styles.capacityState}>{storage.state}</span>
      </div>
      <div
        aria-label={`${storage.label}: ${Math.round(freePercent)} percent free`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(freePercent)}
        className={styles.capacityTrack}
        role="meter"
      >
        <span style={{ width: `${usedPercent}%` }} />
      </div>
    </article>
  );
}

function ReadyStatus({
  liveStatus,
  onRefresh,
  refreshing,
  stale,
  status,
}: {
  liveStatus: SystemStatusLiveStatus | "snapshot";
  onRefresh: () => void;
  refreshing: boolean;
  stale: boolean;
  status: SystemStatusResponse;
}) {
  const storage = status.sources.flatMap((source) => source.storage);
  const attentionCount =
    status.summary.warningSignals +
    status.summary.errorSignals +
    status.summary.warningStorage +
    status.summary.criticalStorage +
    status.summary.unavailableSources;
  const copy = statusCopy(status, attentionCount);

  return (
    <PageFrame>
      <div className={styles.content}>
        <section className={styles.hero} data-state={status.state} data-liquid-glass>
          <div className={styles.heroCopy}>
            <p className="eyebrow">{copy.kicker}</p>
            <h1>{copy.title}</h1>
            <p>{copy.detail}</p>
            <div className={styles.heroMeta}>
              <span>
                <Activity aria-hidden="true" size={16} /> Updated{" "}
                {formatTimestamp(status.generatedAt)}
              </span>
              <span
                aria-label={`System status updates: ${
                  liveStatus === "fallback" ? "30 second polling fallback" : liveStatus
                }`}
                aria-live="polite"
                className={styles.liveState}
                data-state={liveStatus}
              >
                <i aria-hidden="true" />
                {liveStatus === "live"
                  ? "Live"
                  : liveStatus === "connecting"
                    ? "Connecting"
                    : liveStatus === "fallback"
                      ? "30s polling"
                      : "Snapshot"}
              </span>
              <button disabled={refreshing} onClick={onRefresh} type="button">
                <RefreshCw aria-hidden="true" data-spinning={refreshing || undefined} size={16} />
                {refreshing ? "Refreshing" : "Refresh"}
              </button>
            </div>
          </div>
          <div className={styles.signalOrb} data-state={attentionCount > 0 ? "attention" : "quiet"}>
            <span aria-hidden="true" className={styles.orbRing} />
            <span aria-hidden="true" className={styles.orbCore}>
              {attentionCount > 0 ? <AlertTriangle /> : <Check />}
            </span>
            <strong>{attentionCount}</strong>
            <small>{attentionCount === 1 ? "active signal" : "active signals"}</small>
          </div>
          <dl className={styles.metrics}>
            <div>
              <dt>Connected</dt>
              <dd>
                {status.summary.sources - status.summary.unavailableSources}/
                {status.summary.sources}
              </dd>
            </div>
            <div>
              <dt>Healthy</dt>
              <dd>{status.summary.healthySources}</dd>
            </div>
            <div>
              <dt>Capacity alerts</dt>
              <dd>{status.summary.warningStorage + status.summary.criticalStorage}</dd>
            </div>
          </dl>
        </section>

        {stale ? (
          <div className={styles.staleNotice} role="status">
            <CloudOff aria-hidden="true" size={18} />
            <p>
              <strong>Showing the last verified reading.</strong> The gateway did not answer the
              latest refresh; no service or storage state was inferred.
            </p>
          </div>
        ) : null}

        <section aria-labelledby="service-signals-heading" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div>
              <p className="eyebrow">Service constellation</p>
              <h2 id="service-signals-heading">Signal by signal</h2>
            </div>
            <p>Operational warnings stay close to the service that produced them.</p>
          </div>
          <div className={styles.sourceGrid}>
            {status.sources.map((source) => (
              <SourcePanel key={source.id} source={source} />
            ))}
          </div>
        </section>

        <section
          aria-labelledby="capacity-heading"
          className={styles.capacitySection}
          data-liquid-glass
        >
          <div className={styles.sectionHeading}>
            <div>
              <p className="eyebrow">Capacity atlas</p>
              <h2 id="capacity-heading">Room to keep moving</h2>
            </div>
            <p>Storage names are normalized; private mount paths never leave the gateway.</p>
          </div>
          {storage.length > 0 ? (
            <div className={styles.capacityList}>
              {storage.map((item) => (
                <CapacityMeter key={item.id} storage={item} />
              ))}
            </div>
          ) : (
            <div className={styles.capacityEmpty} role="status">
              <HardDrive aria-hidden="true" />
              <div>
                <h3>No storage-capable sources</h3>
                <p>Connect Radarr or Sonarr to include normalized volume capacity.</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </PageFrame>
  );
}

export function SystemStatus({
  client = systemStatusClient,
  initialOutcome,
  live = true,
}: SystemStatusProperties) {
  const [outcome, setOutcome] = useState<SystemStatusLoadOutcome | undefined>(initialOutcome);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [streamStatus, setStreamStatus] = useState<SystemStatusLiveStatus>("connecting");
  const mounted = useRef(true);
  const outcomeRef = useRef<SystemStatusLoadOutcome | undefined>(initialOutcome);
  const requestController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setRefreshing(true);
    try {
      const next = await client.load(controller.signal);
      if (mounted.current) {
        const previous = outcomeRef.current;
        if (previous?.status === "ready" && next.status === "unavailable") {
          setStale(true);
        } else {
          outcomeRef.current = next;
          setOutcome(next);
          setStale(false);
        }
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        if (mounted.current) setRefreshing(false);
      }
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    const timer =
      initialOutcome === undefined ? window.setTimeout(() => void refresh(), 0) : undefined;
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      mounted.current = false;
      requestController.current?.abort();
      requestController.current = null;
    };
  }, [initialOutcome, refresh]);

  useEffect(() => {
    if (!live || outcome?.status !== "ready" || !client.watch) return;
    return client.watch({
      onSnapshot: (event) => {
        const current = outcomeRef.current;
        if (!mounted.current || current?.status !== "ready") return;
        requestController.current?.abort();
        requestController.current = null;
        const next: SystemStatusLoadOutcome = {
          snapshot: { principal: current.snapshot.principal, status: event.status },
          status: "ready",
        };
        outcomeRef.current = next;
        setOutcome(next);
        setRefreshing(false);
        setStale(false);
        setStreamStatus("live");
      },
      onStatus: setStreamStatus,
    });
  }, [client, live, outcome?.status]);

  const liveStatus: SystemStatusLiveStatus | "snapshot" = !live
    ? "snapshot"
    : client.watch
      ? streamStatus
      : "fallback";

  useEffect(() => {
    if (!live || liveStatus === "live") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [live, liveStatus, refresh]);

  const announcement = useMemo(() => {
    if (!outcome) return "Loading system telemetry.";
    if (outcome.status !== "ready") return `System telemetry is ${outcome.status}.`;
    const { summary } = outcome.snapshot.status;
    return `${summary.healthySources} healthy services, ${summary.attentionSources} needing attention, and ${summary.unavailableSources} unavailable.`;
  }, [outcome]);

  if (!outcome) return <LoadingState />;
  if (outcome.status !== "ready") {
    return <BoundaryState onRetry={() => void refresh()} status={outcome.status} />;
  }
  if (outcome.snapshot.status.state === "unconfigured") return <UnconfiguredState />;
  return (
    <>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <ReadyStatus
        liveStatus={liveStatus}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        stale={stale}
        status={outcome.snapshot.status}
      />
    </>
  );
}
