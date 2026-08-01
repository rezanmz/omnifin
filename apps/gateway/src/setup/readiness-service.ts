import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorHealthSchema,
  managedConnectorServiceSchema,
  type ManagedConnectorService,
} from "@omnifin/contracts/connectors";
import {
  setupReadinessResponseSchema,
  type SetupReadinessResponse,
  type SetupReadinessStep,
} from "@omnifin/contracts/setup";

import { requirePermission } from "../auth/authorization.js";
import type { DatabaseHandle } from "../db/client.js";

const MAX_CONNECTORS = 250;
const MAX_OIDC_PROVIDERS = 50;

interface ConnectorReadinessRow {
  capabilitySnapshotJson: string;
  enabled: number;
  healthState: string;
  id: string;
  type: string;
}

interface OidcReadinessRow {
  discoveryState: string;
  enabled: number;
}

interface ReadinessRows {
  connectors: readonly ConnectorReadinessRow[];
  oidcProviders: readonly OidcReadinessRow[];
}

export interface SetupReadinessContext {
  principal: SessionPrincipal;
}

export interface SetupReadinessDependencies {
  clock?: () => Date;
}

export type SetupReadinessErrorReason = "integrity_failure" | "storage_failure";

export class SetupReadinessError extends Error {
  public readonly reason: SetupReadinessErrorReason;

  public constructor(reason: SetupReadinessErrorReason, options?: ErrorOptions) {
    super("Setup readiness could not be retrieved.", options);
    this.name = "SetupReadinessError";
    this.reason = reason;
  }
}

function stateFor(configuredCount: number, readyCount: number): SetupReadinessStep["state"] {
  if (configuredCount === 0) return "not_configured";
  if (readyCount === 0) return "attention";
  return readyCount === configuredCount ? "ready" : "partial";
}

function step(
  id: SetupReadinessStep["id"],
  configuredCount: number,
  readyCount: number,
): SetupReadinessStep {
  return { configuredCount, id, readyCount, state: stateFor(configuredCount, readyCount) };
}

function isStoredConnectorReady(row: ConnectorReadinessRow) {
  if (
    typeof row.id !== "string" ||
    typeof row.capabilitySnapshotJson !== "string" ||
    ![0, 1].includes(row.enabled)
  ) {
    throw new SetupReadinessError("integrity_failure");
  }
  const service = managedConnectorServiceSchema.safeParse(row.type);
  if (!service.success) throw new SetupReadinessError("integrity_failure");
  if (!["unknown", "healthy", "degraded", "offline"].includes(row.healthState)) {
    throw new SetupReadinessError("integrity_failure");
  }
  if (row.enabled !== 1 || row.healthState !== "healthy") return false;

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.capabilitySnapshotJson) as unknown;
  } catch (error) {
    throw new SetupReadinessError("integrity_failure", { cause: error });
  }
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new SetupReadinessError("integrity_failure");
  }
  const record = snapshot as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new SetupReadinessError("integrity_failure");
  const health = connectorHealthSchema.safeParse(record.health);
  if (
    !health.success ||
    health.data.connectorId !== row.id ||
    health.data.service !== service.data ||
    health.data.status !== "healthy"
  ) {
    throw new SetupReadinessError("integrity_failure");
  }
  return true;
}

function connectorStep(
  id: SetupReadinessStep["id"],
  services: readonly ManagedConnectorService[],
  rows: readonly ConnectorReadinessRow[],
  readiness: ReadonlyMap<ConnectorReadinessRow, boolean>,
) {
  const matching = rows.filter((row) => services.includes(row.type as ManagedConnectorService));
  return step(id, matching.length, matching.filter((row) => readiness.get(row) === true).length);
}

function oidcStep(rows: readonly OidcReadinessRow[]) {
  for (const row of rows) {
    if (
      ![0, 1].includes(row.enabled) ||
      !["unchecked", "ready", "failed"].includes(row.discoveryState)
    ) {
      throw new SetupReadinessError("integrity_failure");
    }
  }
  return step(
    "oidc",
    rows.length,
    rows.filter((row) => row.enabled === 1 && row.discoveryState === "ready").length,
  );
}

export class SetupReadinessService {
  readonly #clock: () => Date;
  readonly #database: DatabaseHandle;

  public constructor(database: DatabaseHandle, dependencies: SetupReadinessDependencies = {}) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#database = database;
  }

  public read(context: SetupReadinessContext): SetupReadinessResponse {
    requirePermission(context.principal, "connectors.manage");
    requirePermission(context.principal, "recovery.oidc.manage");

    let rows: ReadinessRows;
    try {
      rows = this.#database.sqlite.transaction(() => {
        const connectors = this.#database.sqlite
          .prepare(
            `select id,
                    type,
                    enabled,
                    health_state as healthState,
                    capability_snapshot_json as capabilitySnapshotJson
             from connector_configs
             order by type, id
             limit ?`,
          )
          .all(MAX_CONNECTORS + 1) as ConnectorReadinessRow[];
        const oidcProviders = this.#database.sqlite
          .prepare(
            `select enabled, discovery_state as discoveryState
             from oidc_providers
             order by id
             limit ?`,
          )
          .all(MAX_OIDC_PROVIDERS + 1) as OidcReadinessRow[];
        return { connectors, oidcProviders };
      })();
    } catch (error) {
      throw new SetupReadinessError("storage_failure", { cause: error });
    }
    if (rows.connectors.length > MAX_CONNECTORS || rows.oidcProviders.length > MAX_OIDC_PROVIDERS) {
      throw new SetupReadinessError("integrity_failure");
    }

    const connectorReadiness = new Map(
      rows.connectors.map((row) => [row, isStoredConnectorReady(row)] as const),
    );
    let generatedAt: Date;
    try {
      generatedAt = this.#clock();
    } catch (error) {
      throw new SetupReadinessError("integrity_failure", { cause: error });
    }
    if (!Number.isFinite(generatedAt.getTime())) {
      throw new SetupReadinessError("integrity_failure");
    }
    const linkedJellyfin = context.principal.linkedServices.filter(
      (link) => link.service === "jellyfin",
    );
    const steps: SetupReadinessStep[] = [
      step(
        "identity",
        linkedJellyfin.length,
        linkedJellyfin.filter((link) => link.health === "linked").length,
      ),
      connectorStep("jellyfin", ["jellyfin"], rows.connectors, connectorReadiness),
      oidcStep(rows.oidcProviders),
      connectorStep("discovery", ["seerr"], rows.connectors, connectorReadiness),
      connectorStep("acquisition", ["radarr", "sonarr"], rows.connectors, connectorReadiness),
      connectorStep("indexers", ["prowlarr"], rows.connectors, connectorReadiness),
      connectorStep("subtitles", ["bazarr"], rows.connectors, connectorReadiness),
      connectorStep("downloads", ["qbittorrent", "sabnzbd"], rows.connectors, connectorReadiness),
    ];
    const essentialCompleted = steps
      .slice(0, 2)
      .filter(({ state }) => state === "ready" || state === "partial").length;
    const optionalReady = steps
      .slice(2)
      .filter(({ state }) => state === "ready" || state === "partial").length;
    const parsed = setupReadinessResponseSchema.safeParse({
      coreReady: essentialCompleted === 2,
      essentialCompleted,
      essentialTotal: 2,
      generatedAt: generatedAt.toISOString(),
      optionalReady,
      optionalTotal: 6,
      steps,
    });
    if (!parsed.success) {
      throw new SetupReadinessError("integrity_failure", { cause: parsed.error });
    }
    return parsed.data;
  }
}
