import type {
  ConnectorCapability,
  ConnectorFailureCode,
  ConnectorHealth,
  ConnectorService,
} from "@omnifin/contracts/connectors";
import { connectorHealthSchema } from "@omnifin/contracts/connectors";

import { SafeConnectorError, SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorAdapter, ConnectorClock, ConnectorTargetConfig } from "../types.js";
import { normalizeUpstreamVersion } from "./schemas.js";

const SYSTEM_CLOCK: ConnectorClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

function statusForFailure(code: ConnectorFailureCode): ConnectorHealth["status"] {
  if (
    code === "configuration_invalid" ||
    code === "destination_blocked" ||
    code === "invalid_credentials"
  ) {
    return "misconfigured";
  }
  if (code === "response_invalid" || code === "unsupported_version") return "degraded";
  return "unavailable";
}

interface ProbeVersionResult {
  value: string;
  additionalProtectedValues?: readonly string[];
}

export abstract class ProbeOnlyAdapter implements ConnectorAdapter {
  abstract readonly service: ConnectorService;
  readonly capabilities: readonly ConnectorCapability[] = ["connector.health", "connector.version"];

  readonly connectorId: string;
  readonly displayName: string;
  protected readonly config: ConnectorTargetConfig;
  protected readonly clock: ConnectorClock;

  private clientInstance: SafeHttpClient | undefined;
  readonly #protectedVersionValues: readonly string[];

  protected constructor(
    config: ConnectorTargetConfig,
    protectedVersionValues: readonly string[] = [],
  ) {
    this.connectorId = config.connectorId;
    this.displayName = config.displayName;
    this.config = config;
    this.clock = config.clock ?? SYSTEM_CLOCK;
    this.#protectedVersionValues = [...protectedVersionValues];
  }

  protected get client(): SafeHttpClient {
    this.clientInstance ??= new SafeHttpClient({
      service: this.service,
      baseUrl: this.config.baseUrl,
      allowInsecureHttp: this.config.insecureHttpApproved ?? false,
      tlsPolicy: this.config.tlsPolicy ?? "strict",
      ...(this.config.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: this.config.tlsCaCertificatePem }),
      ...(this.config.timeoutMs === undefined ? {} : { timeoutMs: this.config.timeoutMs }),
      ...(this.config.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: this.config.maxResponseBytes }),
      ...(this.config.transport === undefined ? {} : { transport: this.config.transport }),
      ...(this.config.resolveHost === undefined ? {} : { resolveHost: this.config.resolveHost }),
    });
    return this.clientInstance;
  }

  abstract probe(signal?: AbortSignal): Promise<ConnectorHealth>;

  protected async runProbe(
    operation: string,
    getVersion: () => Promise<string | ProbeVersionResult>,
  ): Promise<ConnectorHealth> {
    const startedAt = this.clock.monotonicNow();
    let health: ConnectorHealth;
    try {
      const result = await getVersion();
      const rawVersion = typeof result === "string" ? result : result.value;
      const additionalProtectedValues =
        typeof result === "string" ? [] : (result.additionalProtectedValues ?? []);
      const version = normalizeUpstreamVersion(rawVersion, [
        ...this.#protectedVersionValues,
        ...additionalProtectedValues,
      ]);
      if (version === null) {
        throw new SafeConnectorError({
          service: this.service,
          operation,
          code: "response_invalid",
          message: `${this.service} returned a response Omnifin could not safely interpret.`,
          retryable: false,
        });
      }
      const checkedAt = this.clock.now();
      health = {
        connectorId: this.connectorId,
        service: this.service,
        displayName: this.displayName,
        status: "healthy",
        checkedAt: checkedAt.toISOString(),
        latencyMs: Math.max(0, this.clock.monotonicNow() - startedAt),
        version,
        capabilities: [...this.capabilities],
        failure: null,
      };
    } catch (error) {
      const checkedAt = this.clock.now();
      const safeError =
        error instanceof SafeConnectorError
          ? error
          : new SafeConnectorError({
              service: this.service,
              operation,
              code: "upstream_error",
              message: `${this.service} connector probe failed.`,
              retryable: false,
            });
      health = {
        connectorId: this.connectorId,
        service: this.service,
        displayName: this.displayName,
        status: statusForFailure(safeError.code),
        checkedAt: checkedAt.toISOString(),
        latencyMs: Math.max(0, this.clock.monotonicNow() - startedAt),
        version: null,
        capabilities: [...this.capabilities],
        failure: safeError.toPartialFailure(checkedAt),
      };
    }
    return connectorHealthSchema.parse(health);
  }
}
