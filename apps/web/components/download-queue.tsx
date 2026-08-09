"use client";

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DownloadQueueAction,
  DownloadQueueBulkActionInput,
  DownloadQueueItem,
  DownloadQueueItemState,
  DownloadQueueResponse,
} from "@omnifin/contracts/downloads";
import {
  Activity,
  ArrowLeft,
  ArrowUpToLine,
  Cable,
  Check,
  CircleAlert,
  CloudOff,
  Download,
  Gauge,
  HardDrive,
  Layers3,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  Network,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Sun,
  Timer,
  Trash2,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  downloadQueueClient,
  DownloadQueueClientError,
  outcomeFromError,
  type DownloadQueueClient,
  type DownloadQueueLiveStatus,
  type DownloadQueueLoadOutcome,
} from "../lib/download-queue";
import type { ThemePreference } from "../lib/theme";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import { useTheme } from "./theme-provider";
import styles from "./download-queue.module.css";

type QueueFilter = "active" | "all" | "attention" | "paused";

const FILTERS: { label: string; value: QueueFilter }[] = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Attention", value: "attention" },
  { label: "Paused", value: "paused" },
];

const THEME_OPTIONS: { icon: LucideIcon; label: string; value: ThemePreference }[] = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
];

const STATE_LABELS: Record<DownloadQueueItemState, string> = {
  checking: "Checking",
  downloading: "Downloading",
  failed: "Failed",
  moving: "Moving",
  paused: "Paused",
  queued: "Queued",
  stalled: "Stalled",
  unknown: "Unknown",
};

const ACTIVE_STATES = new Set<DownloadQueueItemState>(["checking", "downloading", "moving"]);
const ATTENTION_STATES = new Set<DownloadQueueItemState>(["failed", "stalled"]);
const PAUSABLE_STATES = new Set<DownloadQueueItemState>([
  "checking",
  "downloading",
  "moving",
  "queued",
  "stalled",
]);

type QueueControlAttribute = "data-item-action" | "data-item-removal";

function focusQueueControl(attribute: QueueControlAttribute, itemId: string) {
  const controls = document.querySelectorAll<HTMLButtonElement>(`button[${attribute}]`);
  for (const control of controls) {
    if (control.getAttribute(attribute) === itemId) {
      control.focus();
      return;
    }
  }
}

type QueueActionStatus = "confirming" | "error" | "submitting" | "success";

interface QueueActionState {
  action: DownloadQueueAction;
  itemId: string;
  message: string;
  status: QueueActionStatus;
}

interface QueueRemovalState {
  confirmation: string;
  idempotencyKey: string;
  itemId: string;
  message: string;
  status: QueueActionStatus;
}

interface QueuePromotionState {
  itemId: string;
  message: string;
  status: "error" | "submitting";
}

interface QueueBulkState {
  action: DownloadQueueAction;
  idempotencyKey: string;
  items: DownloadQueueItem[];
  message: string;
  status: "confirming" | "error" | "result" | "submitting";
}

export interface DownloadQueueProperties {
  client?: DownloadQueueClient;
  initialOutcome?: DownloadQueueLoadOutcome;
  live?: boolean;
}

function formatBytes(value: number) {
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unitIndex;
  return `${new Intl.NumberFormat("en", {
    maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2,
  }).format(amount)} ${units[unitIndex]}`;
}

function formatRate(value: number) {
  return value === 0 ? "Idle" : `${formatBytes(value)}/s`;
}

function formatEta(value: number | null) {
  if (value === null) return "Calculating";
  if (value < 60) return "Under a minute";
  const totalMinutes = Math.ceil(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function formatCount(value: number, singular: string) {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")} · ${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"} UTC`;
}

function queueWithItems(
  current: DownloadQueueResponse,
  items: DownloadQueueItem[],
  generatedAt: string,
): DownloadQueueResponse {
  const clients = current.clients.map((queueClient) => {
    const clientItems = items.filter(
      (candidate) => candidate.connectorId === queueClient.connectorId,
    );
    return {
      ...queueClient,
      itemCount: clientItems.length,
      rateBytesPerSecond: clientItems.reduce(
        (total, candidate) => total + candidate.rateBytesPerSecond,
        0,
      ),
    };
  });
  return {
    ...current,
    clients,
    generatedAt,
    items,
    summary: {
      attention: items.filter(
        (candidate) => candidate.state === "failed" || candidate.state === "stalled",
      ).length,
      downloading: items.filter((candidate) => ACTIVE_STATES.has(candidate.state)).length,
      paused: items.filter((candidate) => candidate.state === "paused").length,
      queued: items.filter((candidate) => candidate.state === "queued").length,
      remainingBytes: items.reduce((total, candidate) => total + candidate.remainingBytes, 0),
      total: items.length,
      totalRateBytesPerSecond: items.reduce(
        (total, candidate) => total + candidate.rateBytesPerSecond,
        0,
      ),
    },
  };
}

function itemsAfterPromotion(
  items: readonly DownloadQueueItem[],
  promoted: DownloadQueueItem,
): DownloadQueueItem[] {
  const currentIndex = items.findIndex((candidate) => candidate.id === promoted.id);
  if (currentIndex < 0) return [...items];
  const remaining = items.filter((candidate) => candidate.id !== promoted.id);
  const firstClientIndex = remaining.findIndex(
    (candidate) => candidate.connectorId === promoted.connectorId,
  );
  const insertionIndex =
    firstClientIndex < 0 ? Math.min(currentIndex, remaining.length) : firstClientIndex;
  return [...remaining.slice(0, insertionIndex), promoted, ...remaining.slice(insertionIndex)];
}

function ThemeControl() {
  const { preference, setPreference } = useTheme();

  const moveSelection = (currentIndex: number, direction: -1 | 1) => {
    const nextIndex = (currentIndex + direction + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    const next = THEME_OPTIONS[nextIndex];
    if (!next) return;
    setPreference(next.value);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-download-theme="${next.value}"]`)?.focus();
    });
  };

  return (
    <div aria-label="Color theme" className={styles.themeControl} role="radiogroup">
      {THEME_OPTIONS.map(({ icon: Icon, label, value }, index) => (
        <button
          aria-checked={preference === value}
          aria-label={`${label} theme`}
          data-download-theme={value}
          data-selected={preference === value || undefined}
          key={value}
          onClick={() => setPreference(value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(index, -1);
            }
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              moveSelection(index, 1);
            }
          }}
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
            <Link className={styles.indexerLink} href="/operations/health" prefetch={false}>
              <Activity aria-hidden="true" size={16} /> Health
            </Link>
            <Link className={styles.indexerLink} href="/operations/indexers" prefetch={false}>
              <Radio aria-hidden="true" size={16} /> Indexers
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
      "Your current role can use media features, but download-client telemetry requires operator access.",
    href: "/",
    icon: LockKeyhole,
    kicker: "Operational boundary",
    title: "Operator access required.",
  },
  signed_out: {
    action: "Sign in",
    detail: "Your session ended before Omnifin could retrieve protected download activity.",
    href: "/login",
    icon: LockKeyhole,
    kicker: "Session required",
    title: "Sign in to continue.",
  },
  unavailable: {
    action: "Return to discovery",
    detail:
      "The gateway cannot verify download activity right now. Existing clients and transfers were not changed.",
    href: "/",
    icon: CloudOff,
    kicker: "Signal interrupted",
    title: "The queue is offline.",
  },
} as const;

function BoundaryState({ status }: { status: keyof typeof BOUNDARY_COPY }) {
  const copy = BOUNDARY_COPY[status];
  const Icon = copy.icon;
  return (
    <PageFrame>
      <section className={styles.statePanel}>
        <span className={styles.stateIcon} aria-hidden="true">
          <Icon />
        </span>
        <p className="eyebrow">{copy.kicker}</p>
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
        <Link className={styles.primaryAction} href={copy.href}>
          {copy.action}
        </Link>
      </section>
    </PageFrame>
  );
}

function LoadingState() {
  return (
    <PageFrame>
      <div
        aria-busy="true"
        aria-label="Loading download queue"
        className={styles.loading}
        role="status"
      >
        <div className={styles.loadingHero}>
          <i />
          <b />
          <span />
        </div>
        <div className={styles.loadingCommand} />
        <div className={styles.loadingMetrics}>
          {Array.from({ length: 4 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <div className={styles.loadingWorkspace}>
          <div>
            {Array.from({ length: 3 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
          <i />
        </div>
        <span className="sr-only">Loading download clients and active transfers.</span>
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
      <Icon aria-hidden="true" size={19} strokeWidth={1.65} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function QueueItem({
  actionAvailable,
  actionLocked,
  actionState,
  item,
  onBeginAction,
  onBeginRemoval,
  onCancelAction,
  onCancelRemoval,
  onChangeRemovalConfirmation,
  onConfirmAction,
  onConfirmRemoval,
  onPromote,
  promotionAvailable,
  promotionState,
  removalAvailable,
  removalState,
}: {
  actionAvailable: boolean;
  actionLocked: boolean;
  actionState: QueueActionState | null;
  item: DownloadQueueItem;
  onBeginAction: (item: DownloadQueueItem, action: DownloadQueueAction) => void;
  onBeginRemoval: (item: DownloadQueueItem) => void;
  onCancelAction: (item: DownloadQueueItem) => void;
  onCancelRemoval: (item: DownloadQueueItem) => void;
  onChangeRemovalConfirmation: (value: string) => void;
  onConfirmAction: (item: DownloadQueueItem, action: DownloadQueueAction) => void;
  onConfirmRemoval: (item: DownloadQueueItem) => void;
  onPromote: (item: DownloadQueueItem) => void;
  promotionAvailable: boolean;
  promotionState: QueuePromotionState | null;
  removalAvailable: boolean;
  removalState: QueueRemovalState | null;
}) {
  const percent = Math.round(item.progress * 100);
  const ProtocolIcon = item.protocol === "torrent" ? Network : Layers3;
  const action =
    item.state === "paused" ? "resume" : PAUSABLE_STATES.has(item.state) ? "pause" : null;
  const ActionIcon = action === "resume" ? Play : Pause;
  const activeAction = actionState?.itemId === item.id ? actionState : null;
  const activePromotion = promotionState?.itemId === item.id ? promotionState : null;
  const activeRemoval = removalState?.itemId === item.id ? removalState : null;
  return (
    <article
      className={styles.queueItem}
      data-action={activeAction?.status ?? activePromotion?.status}
      data-state={item.state}
    >
      <div className={styles.queueItemLead}>
        <span className={styles.protocolIcon} aria-hidden="true">
          <ProtocolIcon size={19} />
        </span>
        <div>
          <h3>{item.title}</h3>
          <p>
            {item.clientName}
            {item.category ? ` · ${item.category}` : ""}
          </p>
        </div>
        <div className={styles.queueItemActions}>
          <span className={styles.status} data-state={item.state}>
            <i aria-hidden="true" /> {STATE_LABELS[item.state]}
          </span>
          {promotionAvailable &&
          activeAction?.status !== "confirming" &&
          activeRemoval?.status !== "confirming" ? (
            <button
              aria-label={`Move ${item.title} to front of queue`}
              className={styles.itemAction}
              data-item-promotion={item.id}
              disabled={actionLocked}
              onClick={() => onPromote(item)}
              type="button"
            >
              {activePromotion?.status === "submitting" ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={15} />
              ) : (
                <ArrowUpToLine aria-hidden="true" size={15} />
              )}
              <span>First</span>
            </button>
          ) : null}
          {action &&
          actionAvailable &&
          activeAction?.status !== "confirming" &&
          activeRemoval?.status !== "confirming" ? (
            <button
              aria-label={`${action === "pause" ? "Pause" : "Resume"} ${item.title}`}
              className={styles.itemAction}
              data-item-action={item.id}
              disabled={actionLocked}
              onClick={() => onBeginAction(item, action)}
              type="button"
            >
              {activeAction?.status === "submitting" ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={15} />
              ) : (
                <ActionIcon aria-hidden="true" size={15} />
              )}
              <span>{action === "pause" ? "Pause" : "Resume"}</span>
            </button>
          ) : null}
          {removalAvailable &&
          activeAction?.status !== "confirming" &&
          activeRemoval?.status !== "confirming" ? (
            <button
              aria-label={`Remove ${item.title}`}
              className={`${styles.itemAction} ${styles.removeAction}`}
              data-item-removal={item.id}
              disabled={actionLocked}
              onClick={() => onBeginRemoval(item)}
              type="button"
            >
              {activeRemoval?.status === "submitting" ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={15} />
              ) : (
                <Trash2 aria-hidden="true" size={15} />
              )}
              <span>Remove</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.itemProgressLine}>
        <span
          aria-label={`${item.title} progress`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className={styles.progress}
          role="progressbar"
        >
          <span aria-hidden="true" style={{ width: `${percent}%` }} />
        </span>
        <strong>{percent}%</strong>
      </div>
      <dl className={styles.itemTelemetry}>
        <div>
          <dt>Rate</dt>
          <dd>{formatRate(item.rateBytesPerSecond)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{formatBytes(item.remainingBytes)}</dd>
        </div>
        <div>
          <dt>ETA</dt>
          <dd>{formatEta(item.etaSeconds)}</dd>
        </div>
        <div>
          <dt>{item.protocol === "torrent" ? "Peers" : "Size"}</dt>
          <dd>
            {item.protocol === "torrent"
              ? `${formatCount(item.seeders ?? 0, "seed")} · ${formatCount(item.leechers ?? 0, "peer")}`
              : formatBytes(item.sizeBytes)}
          </dd>
        </div>
      </dl>
      {activeRemoval?.status === "confirming" ? (
        <div
          className={`${styles.actionConfirm} ${styles.removalConfirm}`}
          role="group"
          aria-label="remove confirmation"
        >
          <span>
            <strong>Remove this transfer?</strong>
            <small>
              {item.client === "qbittorrent"
                ? `This stops tracking the torrent in ${item.clientName}. Downloaded content stays on disk.`
                : `This removes the job from ${item.clientName}. Already-downloaded files stay on disk, but the queue job cannot continue.`}
            </small>
            <label className={styles.removalPhrase}>
              <span>Type REMOVE to confirm</span>
              <input
                aria-label="Type REMOVE to confirm"
                autoComplete="off"
                onChange={(event) => onChangeRemovalConfirmation(event.target.value)}
                spellCheck={false}
                value={activeRemoval.confirmation}
              />
            </label>
          </span>
          <div>
            <button
              autoFocus
              className={styles.cancelAction}
              onClick={() => onCancelRemoval(item)}
              type="button"
            >
              Cancel removal
            </button>
            <button
              className={`${styles.confirmAction} ${styles.dangerAction}`}
              disabled={activeRemoval.confirmation !== "REMOVE"}
              onClick={() => onConfirmRemoval(item)}
              type="button"
            >
              Remove transfer
            </button>
          </div>
        </div>
      ) : activeAction?.status === "confirming" && action ? (
        <div className={styles.actionConfirm} role="group" aria-label={`${action} confirmation`}>
          <span>
            <strong>{action === "pause" ? "Pause this transfer?" : "Resume this transfer?"}</strong>
            <small>
              Omnifin will verify the exact item state with {item.clientName} before and after the
              change.
            </small>
          </span>
          <div>
            <button
              autoFocus
              className={styles.cancelAction}
              onClick={() => onCancelAction(item)}
              type="button"
            >
              Cancel
            </button>
            <button
              className={styles.confirmAction}
              onClick={() => onConfirmAction(item, action)}
              type="button"
            >
              {action === "pause" ? "Confirm pause" : "Confirm resume"}
            </button>
          </div>
        </div>
      ) : null}
      {activeRemoval?.status === "error" ? (
        <div className={styles.actionFeedback} data-status="error" role="alert">
          <TriangleAlert aria-hidden="true" size={16} />
          <span>{activeRemoval.message}</span>
        </div>
      ) : null}
      {activePromotion?.status === "error" ? (
        <div className={styles.actionFeedback} data-status="error" role="alert">
          <TriangleAlert aria-hidden="true" size={16} />
          <span>{activePromotion.message}</span>
        </div>
      ) : null}
      {activeAction?.status === "error" || activeAction?.status === "success" ? (
        <div
          className={styles.actionFeedback}
          data-status={activeAction.status}
          role={activeAction.status === "error" ? "alert" : "status"}
        >
          {activeAction.status === "success" ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <TriangleAlert aria-hidden="true" size={16} />
          )}
          <span>{activeAction.message}</span>
        </div>
      ) : null}
    </article>
  );
}

function EmptyQueue({ filtered }: { filtered: boolean }) {
  return (
    <section className={styles.emptyQueue} role="status">
      <span aria-hidden="true">
        <Check />
      </span>
      <h3>{filtered ? "No transfers in this view" : "The queue is calm"}</h3>
      <p>
        {filtered
          ? "Adjust the filter or search to see other transfers."
          : "No active downloads are waiting for attention."}
      </p>
    </section>
  );
}

function ClientPanel({ queue }: { queue: DownloadQueueResponse }) {
  return (
    <aside className={styles.clientPanel} aria-labelledby="download-clients-title">
      <header className={styles.sectionHeading}>
        <div>
          <p className="section-kicker">Client plane</p>
          <h2 id="download-clients-title">Connections</h2>
        </div>
        <ServerCog aria-hidden="true" size={20} />
      </header>
      <div className={styles.clientList}>
        {queue.clients.map((client) => (
          <article data-status={client.status} key={client.connectorId}>
            <span aria-hidden="true">
              {client.status === "healthy" ? <Cable size={17} /> : <Unplug size={17} />}
            </span>
            <div>
              <h3>{client.displayName}</h3>
              <p>{client.service === "qbittorrent" ? "Torrent" : "Usenet"}</p>
            </div>
            <strong>
              {client.status === "healthy" ? formatRate(client.rateBytesPerSecond) : "Offline"}
            </strong>
            <small>
              {client.status === "healthy"
                ? `${client.itemCount} ${client.itemCount === 1 ? "transfer" : "transfers"}`
                : client.failure?.retryable
                  ? "Retrying safely"
                  : "Check configuration"}
            </small>
          </article>
        ))}
      </div>
      <div className={styles.securityNote}>
        <ShieldCheck aria-hidden="true" size={18} />
        <p>
          <strong>Secret boundary intact</strong>
          <span>Client credentials and upstream identifiers stay in the gateway.</span>
        </p>
      </div>
    </aside>
  );
}

function UnconfiguredQueue() {
  return (
    <section className={styles.unconfigured}>
      <span aria-hidden="true">
        <Unplug />
      </span>
      <p className="section-kicker">No validated clients</p>
      <h2>Connect the transfer plane.</h2>
      <p>
        Validate and enable qBittorrent or SABnzbd to bring read-only queue telemetry into this
        workspace.
      </p>
      <Link className={styles.primaryAction} href="/settings/connectors">
        Configure services
      </Link>
    </section>
  );
}

function ReadyQueue({
  client,
  isFetching,
  liveStatus,
  onRefresh,
  queue,
  refreshAvailable,
  stale,
}: {
  client: DownloadQueueClient;
  isFetching: boolean;
  liveStatus: DownloadQueueLiveStatus | "snapshot";
  onRefresh: () => void;
  queue: DownloadQueueResponse;
  refreshAvailable: boolean;
  stale: boolean;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const [actionState, setActionState] = useState<QueueActionState | null>(null);
  const [bulkState, setBulkState] = useState<QueueBulkState | null>(null);
  const [promotionState, setPromotionState] = useState<QueuePromotionState | null>(null);
  const [removalState, setRemovalState] = useState<QueueRemovalState | null>(null);
  const [operationAnnouncement, setOperationAnnouncement] = useState("");
  const actionReturnFocus = useRef<string | null>(null);
  const removalReturnFocus = useRef<string | null>(null);
  const visibleItems = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return queue.items.filter((item) => {
      const matchesTerm =
        !term ||
        item.title.toLocaleLowerCase().includes(term) ||
        item.clientName.toLocaleLowerCase().includes(term) ||
        item.category?.toLocaleLowerCase().includes(term);
      const matchesFilter =
        filter === "all" ||
        (filter === "active" && ACTIVE_STATES.has(item.state)) ||
        (filter === "attention" && ATTENTION_STATES.has(item.state)) ||
        (filter === "paused" && item.state === "paused");
      return matchesTerm && matchesFilter;
    });
  }, [filter, query, queue.items]);
  const filtered = filter !== "all" || query.trim().length > 0;
  const bulkPauseItems = useMemo(
    () => visibleItems.filter((item) => ACTIVE_STATES.has(item.state)),
    [visibleItems],
  );
  const bulkResumeItems = useMemo(
    () => visibleItems.filter((item) => item.state === "paused"),
    [visibleItems],
  );
  const visibleClientCount = useMemo(
    () => new Set(visibleItems.map((item) => item.connectorId)).size,
    [visibleItems],
  );
  const actionAvailable = Boolean(client.act && client.loadEligibility);
  const bulkAvailable = Boolean(client.bulkAct && client.loadEligibility);
  const promotionAvailable = Boolean(client.promote && client.loadEligibility);
  const removalAvailable = Boolean(client.remove && client.loadEligibility);
  const actionLocked =
    actionState?.status === "submitting" ||
    bulkState?.status === "submitting" ||
    promotionState?.status === "submitting" ||
    removalState?.status === "submitting";

  const clearBulkReturnFocus = () => {
    const triggers = document.querySelectorAll<HTMLButtonElement>(
      'button[data-bulk-return-focus="true"]',
    );
    for (const trigger of triggers) trigger.removeAttribute("data-bulk-return-focus");
  };

  useEffect(() => {
    if (actionState !== null || actionReturnFocus.current === null) return;
    const itemId = actionReturnFocus.current;
    actionReturnFocus.current = null;
    focusQueueControl("data-item-action", itemId);
  }, [actionState]);

  useEffect(() => {
    if (removalState !== null || removalReturnFocus.current === null) return;
    const itemId = removalReturnFocus.current;
    removalReturnFocus.current = null;
    focusQueueControl("data-item-removal", itemId);
  }, [removalState]);

  const cancelAction = (item: DownloadQueueItem) => {
    actionReturnFocus.current = item.id;
    setActionState(null);
  };

  const beginAction = (item: DownloadQueueItem, action: DownloadQueueAction) => {
    if (actionLocked) return;
    clearBulkReturnFocus();
    setBulkState(null);
    setPromotionState(null);
    setRemovalState(null);
    setActionState({ action, itemId: item.id, message: "", status: "confirming" });
  };

  const cancelRemoval = (item: DownloadQueueItem) => {
    removalReturnFocus.current = item.id;
    setRemovalState(null);
  };

  const beginRemoval = (item: DownloadQueueItem) => {
    if (actionLocked) return;
    clearBulkReturnFocus();
    setActionState(null);
    setBulkState(null);
    setPromotionState(null);
    setOperationAnnouncement("");
    setRemovalState({
      confirmation: "",
      idempotencyKey: globalThis.crypto.randomUUID(),
      itemId: item.id,
      message: "",
      status: "confirming",
    });
  };

  const beginBulk = (
    action: DownloadQueueAction,
    items: DownloadQueueItem[],
    trigger: HTMLButtonElement,
  ) => {
    if (actionLocked || items.length === 0) return;
    setActionState(null);
    setPromotionState(null);
    setRemovalState(null);
    setOperationAnnouncement("");
    clearBulkReturnFocus();
    trigger.dataset.bulkReturnFocus = "true";
    setBulkState({
      action,
      idempotencyKey: globalThis.crypto.randomUUID(),
      items: [...items],
      message: "",
      status: "confirming",
    });
  };

  const cancelBulk = () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[data-bulk-return-focus="true"]',
    );
    clearBulkReturnFocus();
    setBulkState(null);
    globalThis.requestAnimationFrame(() => trigger?.focus());
  };

  const confirmBulk = async () => {
    if (!bulkState || !client.bulkAct || !client.loadEligibility) return;
    const operation = bulkState;
    setBulkState({ ...operation, message: "", status: "submitting" });
    try {
      const eligibility = await client.loadEligibility();
      if (eligibility.status !== "ready") {
        const message =
          eligibility.status === "signed_out"
            ? "Your session ended. Sign in again before changing these transfers."
            : eligibility.status === "forbidden"
              ? "Operator access is required to change these transfers."
              : "The session could not be verified. No bulk action was started.";
        setBulkState({ ...operation, message, status: "error" });
        return;
      }
      const input: DownloadQueueBulkActionInput =
        operation.action === "pause"
          ? {
              action: "pause",
              targets: operation.items.map((item) => ({
                connectorId: item.connectorId,
                expectedState: item.state as "checking" | "downloading" | "moving",
                itemId: item.id,
              })),
            }
          : {
              action: "resume",
              targets: operation.items.map((item) => ({
                connectorId: item.connectorId,
                expectedState: "paused",
                itemId: item.id,
              })),
            };
      const result = await client.bulkAct(input, {
        csrfToken: eligibility.snapshot.csrfToken,
        idempotencyKey: operation.idempotencyKey,
      });
      const changedItems = new Map(
        result.results.flatMap((entry) =>
          entry.status === "succeeded" ? [[entry.response.item.id, entry.response.item]] : [],
        ),
      );
      queryClient.setQueryData<DownloadQueueResponse>(["download-queue"], (current) => {
        if (!current) return current;
        const items = current.items.map((item) => changedItems.get(item.id) ?? item);
        return queueWithItems(current, items, result.completedAt);
      });
      const changed = result.summary.succeeded;
      const verb = operation.action === "pause" ? "paused" : "resumed";
      if (result.summary.failed === 0) {
        clearBulkReturnFocus();
        setBulkState(null);
        setOperationAnnouncement(
          `${changed} ${changed === 1 ? "transfer" : "transfers"} ${verb} and reverified.`,
        );
      } else {
        setBulkState({
          ...operation,
          message: `${changed} ${changed === 1 ? "transfer was" : "transfers were"} ${verb}; ${result.summary.failed} ${result.summary.failed === 1 ? "target needs" : "targets need"} review after changing or becoming unavailable.`,
          status: "result",
        });
        void onRefresh();
      }
    } catch (error) {
      const message =
        error instanceof DownloadQueueClientError
          ? error.message
          : "The bulk action could not be verified. Its idempotency proof is retained for a safe retry.";
      setBulkState({ ...operation, message, status: "error" });
      if (error instanceof DownloadQueueClientError && error.kind === "stale") {
        void onRefresh();
      }
    }
  };

  const confirmAction = async (item: DownloadQueueItem, action: DownloadQueueAction) => {
    if (!client.act || !client.loadEligibility) return;
    setActionState({ action, itemId: item.id, message: "", status: "submitting" });
    try {
      const eligibility = await client.loadEligibility();
      if (eligibility.status !== "ready") {
        const message =
          eligibility.status === "signed_out"
            ? "Your session ended. Sign in again before changing a transfer."
            : eligibility.status === "forbidden"
              ? "Operator access is required to change this transfer."
              : "The session could not be verified. No transfer state was changed.";
        setActionState({ action, itemId: item.id, message, status: "error" });
        return;
      }
      const input =
        action === "resume"
          ? ({
              action,
              connectorId: item.connectorId,
              expectedState: "paused",
              itemId: item.id,
            } as const)
          : ({
              action,
              connectorId: item.connectorId,
              expectedState: item.state as
                "checking" | "downloading" | "moving" | "queued" | "stalled",
              itemId: item.id,
            } as const);
      const result = await client.act(input, { csrfToken: eligibility.snapshot.csrfToken });
      queryClient.setQueryData<DownloadQueueResponse>(["download-queue"], (current) => {
        if (!current) return current;
        const items = current.items.map((candidate) =>
          candidate.id === result.item.id ? result.item : candidate,
        );
        return queueWithItems(current, items, result.verifiedAt);
      });
      setActionState({
        action,
        itemId: item.id,
        message: `${item.title} ${action === "pause" ? "paused" : "resumed"}${result.replayed ? "—the requested state was already verified." : "."}`,
        status: "success",
      });
    } catch (error) {
      const message =
        error instanceof DownloadQueueClientError
          ? error.message
          : "The download action could not be verified. No further change was attempted.";
      setActionState({ action, itemId: item.id, message, status: "error" });
      if (error instanceof DownloadQueueClientError && error.kind === "stale") {
        void onRefresh();
      }
    }
  };

  const confirmRemoval = async (item: DownloadQueueItem) => {
    if (
      !client.remove ||
      !client.loadEligibility ||
      removalState?.itemId !== item.id ||
      removalState.confirmation !== "REMOVE"
    ) {
      return;
    }
    const idempotencyKey = removalState.idempotencyKey;
    setRemovalState({ ...removalState, message: "", status: "submitting" });
    try {
      const eligibility = await client.loadEligibility();
      if (eligibility.status !== "ready") {
        const message =
          eligibility.status === "signed_out"
            ? "Your session ended. Sign in again before removing a transfer."
            : eligibility.status === "forbidden"
              ? "Operator access is required to remove this transfer."
              : "The session could not be verified. The transfer was not removed.";
        setRemovalState({ ...removalState, message, status: "error" });
        return;
      }
      const result = await client.remove(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        { csrfToken: eligibility.snapshot.csrfToken, idempotencyKey },
      );
      queryClient.setQueryData<DownloadQueueResponse>(["download-queue"], (current) => {
        if (!current) return current;
        return queueWithItems(
          current,
          current.items.filter((candidate) => candidate.id !== result.item.id),
          result.removedAt,
        );
      });
      setRemovalState(null);
      setOperationAnnouncement(
        `${item.title} removed from ${item.clientName}. Downloaded files were preserved.`,
      );
    } catch (error) {
      const message =
        error instanceof DownloadQueueClientError
          ? error.message
          : "The removal could not be verified. Refresh before trying again.";
      setRemovalState({ ...removalState, message, status: "error" });
      if (error instanceof DownloadQueueClientError && error.kind === "stale") {
        void onRefresh();
      }
    }
  };

  const promoteItem = async (item: DownloadQueueItem) => {
    if (!client.promote || !client.loadEligibility || actionLocked) return;
    clearBulkReturnFocus();
    setActionState(null);
    setBulkState(null);
    setRemovalState(null);
    setOperationAnnouncement("");
    setPromotionState({ itemId: item.id, message: "", status: "submitting" });
    try {
      const eligibility = await client.loadEligibility();
      if (eligibility.status !== "ready") {
        const message =
          eligibility.status === "signed_out"
            ? "Your session ended. Sign in again before prioritizing a transfer."
            : eligibility.status === "forbidden"
              ? "Operator access is required to prioritize this transfer."
              : "The session could not be verified. The queue order was not changed.";
        setPromotionState({ itemId: item.id, message, status: "error" });
        return;
      }
      const result = await client.promote(
        {
          connectorId: item.connectorId,
          expectedState: item.state,
          itemId: item.id,
        },
        { csrfToken: eligibility.snapshot.csrfToken },
      );
      queryClient.setQueryData<DownloadQueueResponse>(["download-queue"], (current) => {
        if (!current) return current;
        const items = itemsAfterPromotion(current.items, result.item);
        return queueWithItems(current, items, result.promotedAt);
      });
      setPromotionState(null);
      setOperationAnnouncement(
        result.replayed
          ? `${item.title} was already first in ${item.clientName}.`
          : `${item.title} moved to the front of ${item.clientName}.`,
      );
    } catch (error) {
      const message =
        error instanceof DownloadQueueClientError
          ? error.message
          : "The queue promotion could not be verified. No further change was attempted.";
      setPromotionState({ itemId: item.id, message, status: "error" });
      if (error instanceof DownloadQueueClientError && error.kind === "stale") {
        void onRefresh();
      }
    }
  };

  return (
    <PageFrame>
      <section className={styles.hero} aria-labelledby="download-queue-title">
        <div>
          <p className="eyebrow">Live transfer plane</p>
          <h1 id="download-queue-title">Every byte, in motion.</h1>
          <p>
            One verified view across torrent and Usenet clients—with exact progress, bounded
            telemetry, and no administrative credentials in the browser.
          </p>
        </div>
        <div
          className={styles.heroPulse}
          data-attention={queue.summary.attention > 0 || undefined}
          data-liquid-glass
        >
          <span aria-hidden="true">
            {queue.summary.attention > 0 ? <CircleAlert size={20} /> : <Activity size={20} />}
          </span>
          <div>
            <strong>
              {queue.summary.attention > 0
                ? `${queue.summary.attention} ${queue.summary.attention === 1 ? "transfer needs" : "transfers need"} attention`
                : queue.summary.downloading > 0
                  ? `${queue.summary.downloading} ${queue.summary.downloading === 1 ? "transfer" : "transfers"} moving`
                  : "Transfer plane quiet"}
            </strong>
            <small>{queue.clients.length} verified client connections</small>
          </div>
        </div>
      </section>

      {queue.state === "unconfigured" ? (
        <UnconfiguredQueue />
      ) : (
        <>
          <div className={styles.commandGlass} data-liquid-glass>
            <label className={styles.searchControl}>
              <span className="sr-only">Search downloads</span>
              <Search aria-hidden="true" size={17} />
              <input
                autoComplete="off"
                disabled={bulkState !== null}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a transfer or client"
                type="search"
                value={query}
              />
            </label>
            <div aria-label="Filter downloads" className={styles.filters} role="group">
              {FILTERS.map(({ label, value }) => (
                <button
                  aria-pressed={filter === value}
                  data-selected={filter === value || undefined}
                  disabled={bulkState !== null}
                  key={value}
                  onClick={() => setFilter(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
            <div aria-live="polite" className={styles.liveState} data-state={liveStatus}>
              <i aria-hidden="true" />
              <span>
                {liveStatus === "live"
                  ? "Live"
                  : liveStatus === "connecting"
                    ? "Connecting"
                    : liveStatus === "fallback"
                      ? "12s fallback"
                      : "Snapshot"}
              </span>
            </div>
            <button
              aria-label="Refresh download queue"
              className={styles.refresh}
              disabled={!refreshAvailable || isFetching}
              onClick={onRefresh}
              type="button"
            >
              {isFetching ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={17} />
              ) : (
                <RefreshCw aria-hidden="true" size={17} />
              )}
            </button>
          </div>

          {bulkAvailable ? (
            <section
              aria-labelledby="bulk-queue-controls-title"
              className={styles.bulkControls}
              data-liquid-glass
            >
              <div className={styles.bulkHeading}>
                <span aria-hidden="true">
                  <ListChecks size={18} />
                </span>
                <div>
                  <strong id="bulk-queue-controls-title">Current-view controls</strong>
                  <small>
                    {filtered ? "Filtered scope" : "All visible transfers"} · {visibleClientCount}{" "}
                    {visibleClientCount === 1 ? "client" : "clients"} · exact targets only
                  </small>
                </div>
              </div>
              <div className={styles.bulkButtons}>
                <button
                  aria-label={`Pause ${bulkPauseItems.length} active ${bulkPauseItems.length === 1 ? "transfer" : "transfers"}`}
                  disabled={actionLocked || bulkState !== null || bulkPauseItems.length === 0}
                  onClick={(event) => beginBulk("pause", bulkPauseItems, event.currentTarget)}
                  type="button"
                >
                  <Pause aria-hidden="true" size={16} />
                  <span>Pause active</span>
                  <strong>{String(bulkPauseItems.length).padStart(2, "0")}</strong>
                </button>
                <button
                  aria-label={`Resume ${bulkResumeItems.length} paused ${bulkResumeItems.length === 1 ? "transfer" : "transfers"}`}
                  disabled={actionLocked || bulkState !== null || bulkResumeItems.length === 0}
                  onClick={(event) => beginBulk("resume", bulkResumeItems, event.currentTarget)}
                  type="button"
                >
                  <Play aria-hidden="true" size={16} />
                  <span>Resume paused</span>
                  <strong>{String(bulkResumeItems.length).padStart(2, "0")}</strong>
                </button>
              </div>
              {bulkState ? (
                <div
                  aria-label="Bulk queue action"
                  className={styles.bulkDecision}
                  data-status={bulkState.status}
                  role={
                    bulkState.status === "confirming"
                      ? "group"
                      : bulkState.status === "error"
                        ? "alert"
                        : "status"
                  }
                >
                  <span aria-hidden="true" className={styles.bulkDecisionIcon}>
                    {bulkState.status === "submitting" ? (
                      <LoaderCircle className={styles.spinner} size={18} />
                    ) : bulkState.status === "result" ? (
                      <TriangleAlert size={18} />
                    ) : (
                      <ShieldCheck size={18} />
                    )}
                  </span>
                  <div className={styles.bulkDecisionCopy}>
                    <strong>
                      {bulkState.status === "confirming"
                        ? `${bulkState.action === "pause" ? "Pause" : "Resume"} ${bulkState.items.length} ${bulkState.items.length === 1 ? "transfer" : "transfers"}?`
                        : bulkState.status === "submitting"
                          ? `Revalidating ${bulkState.items.length} exact ${bulkState.items.length === 1 ? "target" : "targets"}…`
                          : bulkState.status === "result"
                            ? "Bulk action completed with exceptions"
                            : "Bulk action needs attention"}
                    </strong>
                    <p>
                      {bulkState.message ||
                        "Omnifin will recheck every opaque target before mutation, keep client concurrency bounded, and report each outcome independently."}
                    </p>
                  </div>
                  <div className={styles.bulkDecisionActions}>
                    {bulkState.status === "confirming" ? (
                      <>
                        <button autoFocus onClick={cancelBulk} type="button">
                          Cancel
                        </button>
                        <button data-primary onClick={() => void confirmBulk()} type="button">
                          {bulkState.action === "pause" ? "Confirm pause" : "Confirm resume"}
                        </button>
                      </>
                    ) : bulkState.status === "error" ? (
                      <>
                        <button onClick={cancelBulk} type="button">
                          Cancel
                        </button>
                        <button data-primary onClick={() => void confirmBulk()} type="button">
                          Retry safely
                        </button>
                      </>
                    ) : bulkState.status === "result" ? (
                      <button data-primary onClick={cancelBulk} type="button">
                        Review refreshed queue
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {queue.state === "degraded" ? (
            <div className={styles.degradedNotice} role="status">
              <TriangleAlert aria-hidden="true" size={19} />
              <span>
                <strong>Partial queue</strong>
                {queue.failures.length === 1
                  ? `${queue.failures[0]!.service === "qbittorrent" ? "qBittorrent" : "SABnzbd"} is unavailable. Verified transfers from other clients remain visible.`
                  : "Some clients are unavailable. Verified transfers from healthy clients remain visible."}
              </span>
            </div>
          ) : null}
          {stale ? (
            <div className={styles.staleNotice} role="status">
              <CloudOff aria-hidden="true" size={18} />
              <span>
                <strong>Live refresh interrupted</strong>
                Showing the last verified queue. No transfer state was changed.
              </span>
            </div>
          ) : null}
          {queue.truncated ? (
            <div className={styles.truncatedNotice} role="status">
              <Layers3 aria-hidden="true" size={18} />
              The queue is large. Showing the first 200 verified transfers.
            </div>
          ) : null}
          {operationAnnouncement ? (
            <div className={styles.operationNotice} role="status">
              <Check aria-hidden="true" size={18} />
              <span>{operationAnnouncement}</span>
            </div>
          ) : null}

          <section className={styles.metrics} aria-label="Download queue summary">
            <Metric
              detail={`${queue.summary.downloading} active`}
              icon={Gauge}
              label="Throughput"
              {...(queue.summary.totalRateBytesPerSecond > 0 ? { state: "good" as const } : {})}
              value={formatRate(queue.summary.totalRateBytesPerSecond)}
            />
            <Metric
              detail="across visible transfers"
              icon={HardDrive}
              label="Remaining"
              value={formatBytes(queue.summary.remainingBytes)}
            />
            <Metric
              detail={`${queue.summary.queued} waiting · ${queue.summary.paused} paused`}
              icon={Download}
              label="Transfers"
              value={String(queue.summary.total).padStart(2, "0")}
            />
            <Metric
              detail={queue.summary.attention > 0 ? "stalled or failed" : "no blocked transfers"}
              icon={queue.summary.attention > 0 ? CircleAlert : Check}
              label="Attention"
              state={queue.summary.attention > 0 ? "attention" : "good"}
              value={String(queue.summary.attention).padStart(2, "0")}
            />
          </section>

          <div className={styles.workspace}>
            <section className={styles.queuePanel} aria-labelledby="active-downloads-title">
              <header className={styles.sectionHeading}>
                <div>
                  <p className="section-kicker">Normalized queue</p>
                  <h2 id="active-downloads-title">Transfers</h2>
                </div>
                <span aria-label={`${visibleItems.length} visible transfers`}>
                  {String(visibleItems.length).padStart(2, "0")}
                </span>
              </header>
              {visibleItems.length === 0 ? (
                <EmptyQueue filtered={filtered} />
              ) : (
                <div className={styles.queueList}>
                  {visibleItems.map((item) => (
                    <QueueItem
                      actionAvailable={actionAvailable}
                      actionLocked={actionLocked}
                      actionState={actionState}
                      item={item}
                      key={item.id}
                      onBeginAction={beginAction}
                      onBeginRemoval={beginRemoval}
                      onCancelAction={cancelAction}
                      onCancelRemoval={cancelRemoval}
                      onChangeRemovalConfirmation={(confirmation) =>
                        setRemovalState((current) =>
                          current ? { ...current, confirmation } : current,
                        )
                      }
                      onConfirmAction={(target, action) => void confirmAction(target, action)}
                      onConfirmRemoval={(target) => void confirmRemoval(target)}
                      onPromote={(target) => void promoteItem(target)}
                      promotionAvailable={promotionAvailable}
                      promotionState={promotionState}
                      removalAvailable={removalAvailable}
                      removalState={removalState}
                    />
                  ))}
                </div>
              )}
            </section>
            <ClientPanel queue={queue} />
          </div>
          <footer className={styles.pageFooter}>
            <span>
              <Timer aria-hidden="true" size={14} /> Verified {formatTimestamp(queue.generatedAt)}
            </span>
            <span>Exact-item controls · credentials remain private</span>
          </footer>
        </>
      )}
    </PageFrame>
  );
}

function DownloadQueueContent({
  client,
  initialOutcome,
  live,
}: Required<Pick<DownloadQueueProperties, "client">> &
  Pick<DownloadQueueProperties, "initialOutcome" | "live">) {
  const refreshAvailable = live ?? initialOutcome === undefined;
  const initialQueue = initialOutcome?.status === "ready" ? initialOutcome.queue : undefined;
  const queryClient = useQueryClient();
  const [streamStatus, setStreamStatus] = useState<DownloadQueueLiveStatus>("connecting");
  const liveStatus: DownloadQueueLiveStatus | "snapshot" = !refreshAvailable
    ? "snapshot"
    : client.watch
      ? streamStatus
      : "fallback";
  const query = useQuery({
    enabled: refreshAvailable,
    initialData: initialQueue,
    queryFn: ({ signal }) => client.load(signal),
    queryKey: ["download-queue"],
    refetchInterval: refreshAvailable && liveStatus === "fallback" ? 12_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 8_000,
  });

  useEffect(() => {
    if (!refreshAvailable || !client.watch) return;
    return client.watch({
      onSnapshot: (event) => {
        queryClient.setQueryData<DownloadQueueResponse>(["download-queue"], event.queue);
        setStreamStatus("live");
      },
      onStatus: setStreamStatus,
    });
  }, [client, queryClient, refreshAvailable]);

  if (!refreshAvailable && initialOutcome) {
    if (
      initialOutcome.status === "forbidden" ||
      initialOutcome.status === "signed_out" ||
      initialOutcome.status === "unavailable"
    ) {
      return <BoundaryState status={initialOutcome.status} />;
    }
  }
  if (query.isPending) return <LoadingState />;
  if (!query.data) return <BoundaryState status={outcomeFromError(query.error)} />;
  return (
    <ReadyQueue
      client={client}
      isFetching={query.isFetching}
      liveStatus={liveStatus}
      onRefresh={() => void query.refetch()}
      queue={query.data}
      refreshAvailable={refreshAvailable}
      stale={query.isError}
    />
  );
}

export function DownloadQueue({
  client = downloadQueueClient,
  initialOutcome,
  live,
}: DownloadQueueProperties) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { gcTime: 5 * 60_000, retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <DownloadQueueContent
        client={client}
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
        {...(live === undefined ? {} : { live })}
      />
    </QueryClientProvider>
  );
}
