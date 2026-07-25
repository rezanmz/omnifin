import type {
  ConnectorCapability,
  ConnectorHealth,
  ConnectorService,
} from "@omnifin/contracts/connectors";

import type { HostResolver } from "./security/destination.js";
import type { ResolvedHostAddress } from "./security/destination.js";

export interface ConnectorTransportInit {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers: Headers;
  body?: Uint8Array;
  signal: AbortSignal;
}

export type ConnectorTransport = (
  url: URL,
  init: ConnectorTransportInit,
  pinnedAddresses: readonly ResolvedHostAddress[],
) => Promise<Response>;

export interface ConnectorClock {
  now: () => Date;
  monotonicNow: () => number;
}

export interface ConnectorTargetConfig {
  connectorId: string;
  displayName: string;
  baseUrl: string;
  /** An administrator must explicitly approve plain HTTP for a target. */
  insecureHttpApproved?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** A transport seam for deterministic tests; production uses the DNS-pinned Node transport. */
  transport?: ConnectorTransport;
  resolveHost?: HostResolver;
  clock?: ConnectorClock;
}

export interface ApiKeyConnectorConfig extends ConnectorTargetConfig {
  apiKey: string;
}

export interface OptionalApiKeyConnectorConfig extends ConnectorTargetConfig {
  apiKey?: string;
}

export interface ConnectorAdapter {
  readonly service: ConnectorService;
  readonly capabilities: readonly ConnectorCapability[];
  probe(signal?: AbortSignal): Promise<ConnectorHealth>;
}
