import {
  oidcProviderCapabilitiesSchema,
  type OidcProviderCapabilities,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import {
  connectorHealthSchema,
  managedConnectorServiceSchema,
  type ConnectorHealth,
  type ManagedConnectorService,
} from "@omnifin/contracts/connectors";
import {
  stackVerificationCapabilities,
  stackVerificationCheckIds,
  stackVerificationFindingCodes,
  stackVerificationResponseSchema,
  type StackVerificationCapability,
  type StackVerificationCheck,
  type StackVerificationFinding,
  type StackVerificationFindingCode,
  type StackVerificationResponse,
} from "@omnifin/contracts/setup";

import { requirePermission } from "../auth/authorization.js";
import type { DatabaseHandle } from "../db/client.js";

const MAX_CONNECTORS = 100;
const MAX_OIDC_PROVIDERS = 50;
const PROBE_CONCURRENCY = 4;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_VERSION_PATTERN = /^v?[0-9]{1,8}(?:\.[0-9]{1,8}){1,5}$/u;

interface ConnectorRow {
  enabled: number;
  id: string;
  type: string;
}

interface OidcProviderRow {
  enabled: number;
  id: string;
}

export interface StackVerificationContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export type StackVerificationProbeResult<T> =
  { kind: "completed"; value: T } | { finding: StackVerificationFindingCode; kind: "unavailable" };

export interface StackVerificationDependencies {
  clock?: () => Date;
  probeConnector: (
    connectorId: string,
    context: StackVerificationContext,
  ) => Promise<StackVerificationProbeResult<ConnectorHealth>>;
  validateOidcProvider: (
    providerId: string,
    context: StackVerificationContext,
  ) => Promise<StackVerificationProbeResult<OidcProviderCapabilities>>;
}

export type StackVerificationErrorReason = "integrity_failure" | "storage_failure";

export class StackVerificationError extends Error {
  public readonly reason: StackVerificationErrorReason;

  public constructor(reason: StackVerificationErrorReason, options?: ErrorOptions) {
    super("Stack verification could not be completed.", options);
    this.name = "StackVerificationError";
    this.reason = reason;
  }
}

interface ProbeReading {
  capabilities: readonly StackVerificationCapability[];
  enabled: boolean;
  findingCodes: readonly StackVerificationFindingCode[];
  ready: boolean;
  service: (typeof stackVerificationCheckIds)[number];
  version: string | null;
}

function assertContext(context: StackVerificationContext) {
  requirePermission(context.principal, "connectors.manage");
  requirePermission(context.principal, "recovery.oidc.manage");
  if (
    !IDENTIFIER_PATTERN.test(context.principal.sessionId) ||
    (context.requestId !== undefined &&
      (context.requestId.length < 1 || context.requestId.length > 128)) ||
    (context.ipAddress !== undefined && context.ipAddress.length > 256)
  ) {
    throw new StackVerificationError("integrity_failure");
  }
}

function connectorFinding(health: ConnectorHealth): StackVerificationFindingCode | undefined {
  return (
    health.failure?.code ?? (health.status === "healthy" ? undefined : "verification_unavailable")
  );
}

function oidcCapabilities(capabilities: OidcProviderCapabilities): StackVerificationCapability[] {
  return [
    "oidc.authorization_code",
    "oidc.pkce_s256",
    ...(capabilities.userInfo ? (["oidc.userinfo"] as const) : []),
    ...(capabilities.logout.rpInitiated ? (["oidc.logout.rp_initiated"] as const) : []),
    ...(capabilities.logout.frontChannel ? (["oidc.logout.front_channel"] as const) : []),
    ...(capabilities.logout.backChannel ? (["oidc.logout.back_channel"] as const) : []),
  ];
}

function stateFor(configuredCount: number, readyCount: number): StackVerificationCheck["state"] {
  if (configuredCount === 0) return "not_configured";
  if (readyCount === configuredCount) return "ready";
  return readyCount === 0 ? "attention" : "partial";
}

function canonicalCapabilities(values: readonly StackVerificationCapability[]) {
  const unique = new Set(values);
  return stackVerificationCapabilities.filter((capability) => unique.has(capability));
}

function canonicalFindings(values: readonly StackVerificationFindingCode[]) {
  const counts = new Map<StackVerificationFindingCode, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return stackVerificationFindingCodes.flatMap((code) => {
    const count = counts.get(code);
    return count === undefined ? [] : ([{ code, count }] satisfies StackVerificationFinding[]);
  });
}

async function mapBounded<T, R>(
  values: readonly T[],
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await worker(values[index]!);
      }
    }),
  );
  return results;
}

export class StackVerificationService {
  readonly #clock: () => Date;
  readonly #database: DatabaseHandle;
  readonly #probeConnector: StackVerificationDependencies["probeConnector"];
  readonly #validateOidcProvider: StackVerificationDependencies["validateOidcProvider"];

  public constructor(database: DatabaseHandle, dependencies: StackVerificationDependencies) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#database = database;
    this.#probeConnector = dependencies.probeConnector;
    this.#validateOidcProvider = dependencies.validateOidcProvider;
  }

  public async run(context: StackVerificationContext): Promise<StackVerificationResponse> {
    assertContext(context);
    const { connectors, oidcProviders } = this.#rows();
    const tasks = [
      ...oidcProviders.map((row) => ({ kind: "oidc" as const, row })),
      ...connectors.map((row) => ({ kind: "connector" as const, row })),
    ];
    const readings = await mapBounded(tasks, async (task): Promise<ProbeReading> => {
      if (task.kind === "oidc") return await this.#verifyOidc(task.row, context);
      return await this.#verifyConnector(task.row, context);
    });
    const checks = stackVerificationCheckIds.map((id): StackVerificationCheck => {
      const matching = readings.filter((reading) => reading.service === id);
      const readyCount = matching.filter(({ ready }) => ready).length;
      return {
        attemptedCount: matching.length,
        capabilities: canonicalCapabilities(matching.flatMap(({ capabilities }) => capabilities)),
        configuredCount: matching.length,
        enabledCount: matching.filter(({ enabled }) => enabled).length,
        findings: canonicalFindings(matching.flatMap(({ findingCodes }) => findingCodes)),
        id,
        readyCount,
        state: stateFor(matching.length, readyCount),
        versions: [
          ...new Set(matching.flatMap(({ version }) => (version === null ? [] : [version]))),
        ].sort((left, right) => left.localeCompare(right)),
      };
    });
    const configuredCount = checks.reduce((total, check) => total + check.configuredCount, 0);
    const readyCount = checks.reduce((total, check) => total + check.readyCount, 0);
    let generatedAt: Date;
    try {
      generatedAt = this.#clock();
    } catch (error) {
      throw new StackVerificationError("integrity_failure", { cause: error });
    }
    if (!Number.isSafeInteger(generatedAt.getTime()) || generatedAt.getTime() < 0) {
      throw new StackVerificationError("integrity_failure");
    }
    const parsed = stackVerificationResponseSchema.safeParse({
      checks,
      configuredCount,
      format: "omnifin-stack-verification",
      generatedAt: generatedAt.toISOString(),
      readyCount,
      schemaVersion: 1,
      scope: "local_diagnostic",
      state: stateFor(configuredCount, readyCount),
    });
    if (!parsed.success) {
      throw new StackVerificationError("integrity_failure", { cause: parsed.error });
    }
    return parsed.data;
  }

  #rows() {
    let connectors: ConnectorRow[];
    let oidcProviders: OidcProviderRow[];
    try {
      ({ connectors, oidcProviders } = this.#database.sqlite.transaction(() => ({
        connectors: this.#database.sqlite
          .prepare("select id, type, enabled from connector_configs order by type, id limit ?")
          .all(MAX_CONNECTORS + 1) as ConnectorRow[],
        oidcProviders: this.#database.sqlite
          .prepare("select id, enabled from oidc_providers order by id limit ?")
          .all(MAX_OIDC_PROVIDERS + 1) as OidcProviderRow[],
      }))());
    } catch (error) {
      throw new StackVerificationError("storage_failure", { cause: error });
    }
    if (connectors.length > MAX_CONNECTORS || oidcProviders.length > MAX_OIDC_PROVIDERS) {
      throw new StackVerificationError("integrity_failure");
    }
    for (const row of connectors) {
      if (
        !IDENTIFIER_PATTERN.test(row.id) ||
        !managedConnectorServiceSchema.safeParse(row.type).success ||
        ![0, 1].includes(row.enabled)
      ) {
        throw new StackVerificationError("integrity_failure");
      }
    }
    for (const row of oidcProviders) {
      if (!IDENTIFIER_PATTERN.test(row.id) || ![0, 1].includes(row.enabled)) {
        throw new StackVerificationError("integrity_failure");
      }
    }
    return { connectors, oidcProviders };
  }

  async #verifyConnector(
    row: ConnectorRow,
    context: StackVerificationContext,
  ): Promise<ProbeReading> {
    const service = managedConnectorServiceSchema.parse(row.type) as ManagedConnectorService;
    const enabled = row.enabled === 1;
    let result: StackVerificationProbeResult<ConnectorHealth>;
    try {
      result = await this.#probeConnector(row.id, context);
    } catch {
      result = { finding: "verification_unavailable", kind: "unavailable" };
    }
    if (result.kind === "unavailable") {
      return {
        capabilities: [],
        enabled,
        findingCodes: [...(enabled ? [] : ["disabled" as const]), result.finding],
        ready: false,
        service,
        version: null,
      };
    }
    const health = connectorHealthSchema.safeParse(result.value);
    if (!health.success || health.data.service !== service || health.data.connectorId !== row.id) {
      return {
        capabilities: [],
        enabled,
        findingCodes: [...(enabled ? [] : ["disabled" as const]), "verification_unavailable"],
        ready: false,
        service,
        version: null,
      };
    }
    const rawVersion = health.data.version;
    const version =
      rawVersion !== null && SAFE_VERSION_PATTERN.test(rawVersion) ? rawVersion : null;
    return {
      capabilities: health.data.capabilities,
      enabled,
      findingCodes: [
        ...(enabled ? [] : ["disabled" as const]),
        ...(connectorFinding(health.data) ? [connectorFinding(health.data)!] : []),
        ...(rawVersion !== null && version === null ? (["version_redacted"] as const) : []),
      ],
      ready: enabled && health.data.status === "healthy",
      service,
      version,
    };
  }

  async #verifyOidc(
    row: OidcProviderRow,
    context: StackVerificationContext,
  ): Promise<ProbeReading> {
    const enabled = row.enabled === 1;
    let result: StackVerificationProbeResult<OidcProviderCapabilities>;
    try {
      result = await this.#validateOidcProvider(row.id, context);
    } catch {
      result = { finding: "verification_unavailable", kind: "unavailable" };
    }
    const capabilities =
      result.kind === "completed" ? oidcProviderCapabilitiesSchema.safeParse(result.value) : null;
    return result.kind === "completed" && capabilities?.success
      ? {
          capabilities: oidcCapabilities(capabilities.data),
          enabled,
          findingCodes: enabled ? [] : ["disabled"],
          ready: enabled,
          service: "oidc",
          version: null,
        }
      : {
          capabilities: [],
          enabled,
          findingCodes: [
            ...(enabled ? [] : ["disabled" as const]),
            result.kind === "unavailable" ? result.finding : "verification_unavailable",
          ],
          ready: false,
          service: "oidc",
          version: null,
        };
  }
}
