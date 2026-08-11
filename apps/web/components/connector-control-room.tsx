"use client";

import type {
  ConnectorAdmin,
  ConnectorCreateRequest,
  ConnectorUpdateRequest,
} from "@omnifin/contracts/connectors";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Cable,
  Check,
  CircleAlert,
  CloudOff,
  Gauge,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Router,
  Server,
  ShieldCheck,
  Trash2,
  Wifi,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import {
  ConnectorAdminClientError,
  connectorAdminClient,
  type ConnectorAdminClient,
  type ConnectorAdminLoadOutcome,
} from "../lib/connector-admin";
import styles from "./connector-control-room.module.css";
import { connectorServicePresentation } from "./connector-presentation";
import { ConnectorPageShell } from "./connector-page-shell";
import { JellyfinProvisioningSettings } from "./jellyfin-provisioning-settings";

const LazyConnectorForm = dynamic(
  () => import("./connector-form").then((module_) => module_.ConnectorForm),
  {
    loading: () => (
      <div
        aria-busy="true"
        aria-label="Loading connector editor"
        className={styles.formSkeleton}
        role="status"
      />
    ),
    ssr: false,
  },
);
export interface ConnectorControlRoomProperties {
  client?: ConnectorAdminClient;
  displayProfile?: DisplayProfile;
  embedded?: boolean;
  initialOutcome?: ConnectorAdminLoadOutcome | undefined;
}

function statusLabel(connector: ConnectorAdmin) {
  if (!connector.enabled && connector.healthState === "healthy") return "Ready";
  if (!connector.enabled) return "Standby";
  if (connector.healthState === "healthy") return "Online";
  if (connector.healthState === "degraded") return "Degraded";
  if (connector.healthState === "offline") return "Offline";
  return "Checking";
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "Not checked";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Unknown";
  const months = [
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
  ];
  const hour = timestamp.getUTCHours();
  const displayHour = hour % 12 || 12;
  const minute = String(timestamp.getUTCMinutes()).padStart(2, "0");
  const period = hour < 12 ? "AM" : "PM";
  return `${months[timestamp.getUTCMonth()]} ${timestamp.getUTCDate()}, ${displayHour}:${minute} ${period} UTC`;
}

function userFacingError(error: unknown) {
  if (error instanceof ConnectorAdminClientError) return error.message;
  return "The operation could not be completed. No unconfirmed settings were applied.";
}

function SignalPath({ connector }: { connector: ConnectorAdmin }) {
  const tlsLabel = connector.tlsPolicy === "strict" ? "Strict TLS" : "Pinned CA";
  const destinationLabel = connector.insecureHttpApproved ? "HTTP approved" : "Destination guarded";
  const service = connectorServicePresentation[connector.service];
  return (
    <section className={styles.signalPath} aria-labelledby="signal-path-title">
      <div className={styles.sectionHeading}>
        <div>
          <p className="section-kicker">Signal path</p>
          <h3 id="signal-path-title">Trust before traffic.</h3>
        </div>
        <ShieldCheck aria-hidden="true" size={20} />
      </div>
      <ol>
        <li data-state="ready">
          <span>
            <Router aria-hidden="true" size={18} />
          </span>
          <div>
            <strong>Gateway</strong>
            <small>Secrets isolated</small>
          </div>
        </li>
        <li data-state={connector.insecureHttpApproved ? "attention" : "ready"}>
          <span>
            <BadgeCheck aria-hidden="true" size={18} />
          </span>
          <div>
            <strong>Resolution</strong>
            <small>{destinationLabel}</small>
          </div>
        </li>
        <li data-state={connector.insecureHttpApproved ? "attention" : "ready"}>
          <span>
            <LockKeyhole aria-hidden="true" size={18} />
          </span>
          <div>
            <strong>Transport</strong>
            <small>{connector.insecureHttpApproved ? "Unencrypted" : tlsLabel}</small>
          </div>
        </li>
        <li data-state={connector.healthState === "healthy" ? "ready" : "idle"}>
          <span>
            <service.icon aria-hidden="true" size={18} />
          </span>
          <div>
            <strong>{service.label}</strong>
            <small>{statusLabel(connector)}</small>
          </div>
        </li>
      </ol>
    </section>
  );
}

function DetailWorkspace({
  busyAction,
  connector,
  deleteConfirmation,
  onDelete,
  onEdit,
  onProbe,
  onSetDeleteConfirmation,
  onToggle,
  recoveryOnly,
  csrfToken,
}: {
  busyAction: string | null;
  connector: ConnectorAdmin;
  deleteConfirmation: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onProbe: () => void;
  onSetDeleteConfirmation: (value: boolean) => void;
  onToggle: () => void;
  recoveryOnly: boolean;
  csrfToken: string;
}) {
  const presentation = connectorServicePresentation[connector.service];
  const Icon = presentation.icon;
  const probe = connector.lastProbe;
  const canEnable = connector.enabled || connector.healthState === "healthy";
  return (
    <div>
      <header className={styles.workspaceHeading}>
        <div className={styles.serviceIdentity} data-service={connector.service}>
          <span>
            <Icon aria-hidden="true" size={27} />
          </span>
          <div>
            <p className="section-kicker">{presentation.description}</p>
            <h2>{connector.displayName}</h2>
            <p>{connector.baseUrl}</p>
          </div>
        </div>
        <span className={styles.stateBadge} data-state={connector.healthState}>
          <span aria-hidden="true" /> {statusLabel(connector)}
        </span>
      </header>

      <div className={styles.actionBar}>
        <button
          className={styles.primaryButton}
          disabled={busyAction !== null}
          onClick={onProbe}
          type="button"
        >
          {busyAction === "probe" ? (
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
          ) : (
            <Activity aria-hidden="true" size={16} />
          )}
          Probe signal
        </button>
        <button
          className={styles.secondaryButton}
          disabled={busyAction !== null}
          onClick={onEdit}
          type="button"
        >
          <Pencil aria-hidden="true" size={16} /> Edit
        </button>
        <button
          className={connector.enabled ? styles.secondaryButton : styles.liveButton}
          disabled={busyAction !== null || !canEnable}
          onClick={onToggle}
          title={!canEnable ? "Run a successful probe before enabling this connector." : undefined}
          type="button"
        >
          {busyAction === "toggle" ? (
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
          ) : connector.enabled ? (
            <CloudOff aria-hidden="true" size={16} />
          ) : (
            <Wifi aria-hidden="true" size={16} />
          )}
          {connector.enabled ? "Move to standby" : "Bring online"}
        </button>
      </div>

      {recoveryOnly ? (
        <aside className={styles.recoveryNotice}>
          <KeyRound aria-hidden="true" size={19} />
          <div>
            <strong>Recovery boundary active</strong>
            <p>Only Jellyfin connectivity can be inspected or repaired in this session.</p>
          </div>
        </aside>
      ) : null}

      <SignalPath connector={connector} />

      <section className={styles.telemetry} aria-label="Connector telemetry">
        <article>
          <Gauge aria-hidden="true" size={18} />
          <span>
            <small>Latency</small>
            <strong>{probe ? `${Math.round(probe.latencyMs)} ms` : "—"}</strong>
          </span>
        </article>
        <article>
          <Server aria-hidden="true" size={18} />
          <span>
            <small>Version</small>
            <strong>{probe?.version ?? "Unknown"}</strong>
          </span>
        </article>
        <article>
          <Cable aria-hidden="true" size={18} />
          <span>
            <small>Capabilities</small>
            <strong>{probe?.capabilities.length ?? 0}</strong>
          </span>
        </article>
        <article>
          <RefreshCw aria-hidden="true" size={18} />
          <span>
            <small>Last probe</small>
            <strong>{formatTimestamp(probe?.checkedAt)}</strong>
          </span>
        </article>
      </section>

      {probe?.failure ? (
        <div className={styles.failurePanel} role="alert">
          <CircleAlert aria-hidden="true" size={21} />
          <div>
            <strong>{probe.failure.message}</strong>
            <p>
              {probe.failure.retryable
                ? "The operation can be retried safely."
                : "Review configuration before retrying."}
            </p>
            <code>{probe.failure.code}</code>
          </div>
        </div>
      ) : null}

      <div className={styles.detailGrid}>
        <section aria-labelledby="capabilities-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className="section-kicker">Negotiated surface</p>
              <h3 id="capabilities-title">Capabilities</h3>
            </div>
            <Cable aria-hidden="true" size={19} />
          </div>
          {probe?.capabilities.length ? (
            <ul className={styles.capabilityList}>
              {probe.capabilities.map((capability) => (
                <li key={capability}>
                  <Check aria-hidden="true" size={13} />
                  {capability.replaceAll(".", " · ")}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.quietCopy}>
              Probe this connector to negotiate its normalized capabilities.
            </p>
          )}
        </section>
        <section aria-labelledby="security-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className="section-kicker">Guardrails</p>
              <h3 id="security-title">Security posture</h3>
            </div>
            <LockKeyhole aria-hidden="true" size={19} />
          </div>
          <dl className={styles.securityList}>
            <div>
              <dt>Credentials</dt>
              <dd>
                {connector.credentialKind === "none"
                  ? "Not required"
                  : connector.credentialsConfigured
                    ? `${connector.credentialKind.replaceAll("_", " ")} sealed`
                    : "Not configured"}
              </dd>
            </div>
            <div>
              <dt>TLS policy</dt>
              <dd>
                {connector.tlsPolicy === "strict" ? "Strict verification" : "Pinned private CA"}
              </dd>
            </div>
            <div>
              <dt>Plain HTTP</dt>
              <dd>{connector.insecureHttpApproved ? "Explicitly approved" : "Blocked"}</dd>
            </div>
            <div>
              <dt>Configuration</dt>
              <dd>{connector.enabled ? "Active" : "Disabled by default"}</dd>
            </div>
            {connector.service === "radarr" || connector.service === "sonarr" ? (
              <div>
                <dt>Browser actions</dt>
                <dd>{connector.publicUiUrl ? "Configured separately" : "Not configured"}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      </div>

      {connector.service === "jellyfin" ? (
        <JellyfinProvisioningSettings key={connector.id} connector={connector} csrfToken={csrfToken} />
      ) : null}

      <section className={styles.dangerZone}>
        <div>
          <p className="section-kicker">Removal</p>
          <h3>Disconnect service</h3>
          <p>
            Disable the connector first. Stored credentials and probe history are deleted with it.
          </p>
        </div>
        {deleteConfirmation ? (
          <div
            className={styles.deleteConfirm}
            role="group"
            aria-label="Confirm connector deletion"
          >
            <button
              className={styles.secondaryButton}
              onClick={() => onSetDeleteConfirmation(false)}
              type="button"
            >
              Keep connector
            </button>
            <button
              className={styles.dangerButton}
              disabled={busyAction !== null}
              onClick={onDelete}
              type="button"
            >
              {busyAction === "delete" ? (
                <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
              ) : (
                <Trash2 aria-hidden="true" size={16} />
              )}{" "}
              Delete permanently
            </button>
          </div>
        ) : (
          <button
            className={styles.dangerButton}
            disabled={connector.enabled}
            onClick={() => onSetDeleteConfirmation(true)}
            type="button"
          >
            <Trash2 aria-hidden="true" size={16} /> Delete
          </button>
        )}
      </section>
    </div>
  );
}

function ConnectorControlRoomContent({
  client,
  initialOutcome,
}: Required<Pick<ConnectorControlRoomProperties, "client">> &
  Pick<ConnectorControlRoomProperties, "initialOutcome">) {
  const [outcome, setOutcome] = useState<ConnectorAdminLoadOutcome | undefined>(initialOutcome);
  const [loading, setLoading] = useState(initialOutcome === undefined);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialOutcome?.status === "ready" ? (initialOutcome.snapshot.connectors[0]?.id ?? null) : null,
  );
  const [view, setView] = useState<"create" | "detail" | "edit">("detail");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const refreshOutcome = useCallback(async () => {
    setLoading(true);
    try {
      const next = await client.load();
      setOutcome(next);
      setSelectedId(next.status === "ready" ? (next.snapshot.connectors[0]?.id ?? null) : null);
    } catch {
      setOutcome({ status: "unavailable" });
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (initialOutcome !== undefined) return;
    let active = true;
    void client
      .load()
      .then((next) => {
        if (!active) return;
        setOutcome(next);
        setSelectedId(next.status === "ready" ? (next.snapshot.connectors[0]?.id ?? null) : null);
      })
      .catch(() => {
        if (!active) return;
        setOutcome({ status: "unavailable" });
        setSelectedId(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, initialOutcome]);

  const snapshot = outcome?.status === "ready" ? outcome.snapshot : null;
  const connectors = snapshot?.connectors ?? [];
  const selected =
    connectors.find((connector) => connector.id === selectedId) ?? connectors[0] ?? null;
  const effectiveView = connectors.length === 0 ? "create" : view;
  const healthyCount = connectors.filter((connector) => connector.healthState === "healthy").length;
  const attentionCount = connectors.filter(
    (connector) => connector.healthState === "degraded" || connector.healthState === "offline",
  ).length;

  const updateConnectors = (
    transform: (current: readonly ConnectorAdmin[]) => readonly ConnectorAdmin[],
  ) => {
    setOutcome((current) =>
      current?.status === "ready"
        ? {
            ...current,
            snapshot: { ...current.snapshot, connectors: transform(current.snapshot.connectors) },
          }
        : current,
    );
  };

  const replaceConnector = (next: ConnectorAdmin) => {
    updateConnectors((current) =>
      current.map((connector) => (connector.id === next.id ? next : connector)),
    );
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    setOperationError(null);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setOperationError(userFacingError(error));
      if (error instanceof ConnectorAdminClientError && error.kind === "session_changed") {
        setOutcome({ status: "signed_out" });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const createConnector = async (input: ConnectorCreateRequest | ConnectorUpdateRequest) => {
    if (!snapshot || !("id" in input)) return;
    await run("create", async () => {
      const created = await client.create(input, snapshot.csrfToken);
      updateConnectors((current) =>
        [...current, created].sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        ),
      );
      setSelectedId(created.id);
      setView("detail");
      setNotice(
        `${created.displayName} was saved in standby. Probe the signal before bringing it online.`,
      );
    });
  };

  const editConnector = async (input: ConnectorCreateRequest | ConnectorUpdateRequest) => {
    if (!snapshot || !selected || !("revision" in input)) return;
    await run("edit", async () => {
      const updated = await client.update(selected.id, input, snapshot.csrfToken);
      replaceConnector(updated);
      setView("detail");
      setNotice("Configuration saved. Run a fresh probe before bringing the connector online.");
    });
  };

  const probeConnector = () => {
    if (!snapshot || !selected) return;
    void run("probe", async () => {
      const probed = await client.probe(selected.id, snapshot.csrfToken);
      replaceConnector(probed);
      setNotice(
        probed.healthState === "healthy"
          ? `${probed.displayName} answered with a healthy, verified signal.`
          : `${probed.displayName} responded with ${probed.healthState} health.`,
      );
    });
  };

  const toggleConnector = () => {
    if (!snapshot || !selected) return;
    void run("toggle", async () => {
      const updated = await client.update(
        selected.id,
        { enabled: !selected.enabled, revision: selected.revision },
        snapshot.csrfToken,
      );
      replaceConnector(updated);
      setNotice(
        updated.enabled
          ? `${updated.displayName} is online.`
          : `${updated.displayName} moved to standby.`,
      );
    });
  };

  const deleteConnector = () => {
    if (!snapshot || !selected) return;
    void run("delete", async () => {
      const result = await client.delete(selected.id, selected.revision, snapshot.csrfToken);
      updateConnectors((current) =>
        current.filter((connector) => connector.id !== result.deletedConnectorId),
      );
      setSelectedId(null);
      setDeleteConfirmation(false);
      setNotice(
        `${selected.displayName} was disconnected and its sealed credentials were deleted.`,
      );
    });
  };

  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
      return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.parentElement?.querySelectorAll("button") ?? []);
    const targetIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown" || event.key === "ArrowRight"
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[targetIndex]?.focus();
  };

  if (loading) {
    return (
      <section aria-busy="true" aria-label="Loading service connections" className={styles.console}>
        <div className={`${styles.serviceRail} ${styles.skeleton}`} />
        <div className={`${styles.workspace} ${styles.skeleton}`} />
      </section>
    );
  }
  if (outcome?.status === "signed_out") {
    return (
      <section className={styles.statePanel} role="status">
        <KeyRound aria-hidden="true" size={29} />
        <div>
          <h2>Your administrative session ended.</h2>
          <p>Sign in again before changing service connections.</p>
          <Link className={styles.primaryButton} href="/login">
            Sign in <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </div>
      </section>
    );
  }
  if (outcome?.status === "forbidden") {
    return (
      <section className={styles.statePanel} role="alert">
        <LockKeyhole aria-hidden="true" size={29} />
        <div>
          <h2>This control room is restricted.</h2>
          <p>Your current role cannot inspect or change upstream service credentials.</p>
          <Link className={styles.secondaryButton} href="/settings">
            Return to account settings
          </Link>
        </div>
      </section>
    );
  }
  if (outcome?.status === "unavailable" || !snapshot) {
    return (
      <section className={styles.statePanel} role="alert">
        <CloudOff aria-hidden="true" size={29} />
        <div>
          <h2>The gateway signal is unavailable.</h2>
          <p>No settings were changed. Restore the gateway connection, then retry.</p>
          <button
            className={styles.primaryButton}
            onClick={() => void refreshOutcome()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} /> Retry connection
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      {notice ? (
        <div className={styles.notice} role="status">
          <Check aria-hidden="true" size={16} />
          {notice}
          <button aria-label="Dismiss notice" onClick={() => setNotice(null)} type="button">
            ×
          </button>
        </div>
      ) : null}
      {operationError ? (
        <div className={styles.operationError} role="alert">
          <CircleAlert aria-hidden="true" size={17} />
          {operationError}
          <button aria-label="Dismiss error" onClick={() => setOperationError(null)} type="button">
            ×
          </button>
        </div>
      ) : null}
      <section className={styles.console}>
        <aside className={styles.serviceRail}>
          <div className={styles.railHeading}>
            <div>
              <p className="section-kicker">Service constellation</p>
              <h2>{connectors.length ? "Signals" : "No signals yet"}</h2>
            </div>
            <button
              aria-label="Add service connection"
              className={styles.addButton}
              disabled={snapshot.recoveryOnly && connectors.length > 0}
              onClick={() => setView("create")}
              type="button"
            >
              <Plus aria-hidden="true" size={17} />
            </button>
          </div>
          <div className={styles.stackSummary} aria-label="Stack connection summary">
            <span>
              <strong>{healthyCount}</strong>
              <small>Healthy</small>
            </span>
            <span>
              <strong>{attentionCount}</strong>
              <small>Attention</small>
            </span>
            <span>
              <strong>{connectors.length}</strong>
              <small>Total</small>
            </span>
          </div>
          {connectors.length ? (
            <nav aria-label="Configured services" className={styles.serviceList}>
              {connectors.map((connector, index) => {
                const presentation = connectorServicePresentation[connector.service];
                const Icon = presentation.icon;
                return (
                  <button
                    aria-current={
                      effectiveView === "detail" && selected?.id === connector.id
                        ? "true"
                        : undefined
                    }
                    data-service={connector.service}
                    key={connector.id}
                    onClick={() => {
                      setSelectedId(connector.id);
                      setView("detail");
                      setDeleteConfirmation(false);
                    }}
                    onKeyDown={(event) => moveFocus(event, index)}
                    type="button"
                  >
                    <span className={styles.serviceIcon}>
                      <Icon aria-hidden="true" size={20} />
                    </span>
                    <span>
                      <strong>{connector.displayName}</strong>
                      <small>{presentation.description}</small>
                    </span>
                    <i aria-hidden="true" data-state={connector.healthState} />
                  </button>
                );
              })}
            </nav>
          ) : (
            <div className={styles.railEmpty}>
              <Cable aria-hidden="true" size={22} />
              <p>Your service map begins with a verified connection.</p>
            </div>
          )}
          <footer>
            <ShieldCheck aria-hidden="true" size={16} />
            <span>
              <strong>Browser-safe view</strong>
              <small>Credentials remain sealed</small>
            </span>
          </footer>
        </aside>

        <section className={styles.workspace}>
          {effectiveView === "create" ? (
            <LazyConnectorForm
              busy={busyAction === "create"}
              mode="create"
              onCancel={connectors.length ? () => setView("detail") : undefined}
              onSubmit={createConnector}
              recoveryOnly={snapshot.recoveryOnly}
            />
          ) : effectiveView === "edit" && selected ? (
            <LazyConnectorForm
              busy={busyAction === "edit"}
              connector={selected}
              mode="edit"
              onCancel={() => setView("detail")}
              onSubmit={editConnector}
              recoveryOnly={snapshot.recoveryOnly}
            />
          ) : selected ? (
            <DetailWorkspace
              busyAction={busyAction}
              connector={selected}
              deleteConfirmation={deleteConfirmation}
              onDelete={deleteConnector}
              onEdit={() => setView("edit")}
              onProbe={probeConnector}
              onSetDeleteConfirmation={setDeleteConfirmation}
              onToggle={toggleConnector}
              recoveryOnly={snapshot.recoveryOnly}
              csrfToken={snapshot.csrfToken}
            />
          ) : null}
        </section>
      </section>
    </>
  );
}

export function ConnectorControlRoom({
  client = connectorAdminClient,
  displayProfile = "standard",
  embedded = false,
  initialOutcome,
}: ConnectorControlRoomProperties) {
  const administration = (
    <ConnectorControlRoomContent client={client} initialOutcome={initialOutcome} />
  );
  return embedded ? (
    administration
  ) : (
    <ConnectorPageShell displayProfile={displayProfile}>{administration}</ConnectorPageShell>
  );
}
