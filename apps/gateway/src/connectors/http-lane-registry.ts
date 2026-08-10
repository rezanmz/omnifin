import type { ConnectorService } from "@omnifin/contracts/connectors";
import {
  ConnectorHttpLane,
  type ConnectorHttpLaneOptions,
} from "@omnifin/connectors/http/connector-http-lane";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";

export interface ConnectorHttpLaneLifecycle {
  laneFor(service: ConnectorService, connectorId: string): ConnectorHttpLane;
  retire(service: ConnectorService, connectorId: string): void;
  close(): void;
}

export interface ConnectorHttpLaneRegistryOptions {
  /** Test seam; production lanes are always created with keep-alive enabled. */
  createLane?: (service: ConnectorService) => ConnectorHttpLane;
}

function keyFor(service: ConnectorService, connectorId: string) {
  return `${service}\0${connectorId}`;
}

export class ConnectorHttpLaneRegistry implements ConnectorHttpLaneLifecycle {
  readonly #lanes = new Map<string, ConnectorHttpLane>();
  readonly #createLane: (service: ConnectorService) => ConnectorHttpLane;
  #closed = false;

  public constructor(options: ConnectorHttpLaneRegistryOptions = {}) {
    this.#createLane =
      options.createLane ??
      ((service) =>
        new ConnectorHttpLane({
          keepAlive: true,
          service,
        } satisfies ConnectorHttpLaneOptions));
  }

  public laneFor(service: ConnectorService, connectorId: string) {
    if (this.#closed) {
      throw new SafeConnectorError({
        code: "unreachable",
        message: "The connector HTTP lane registry is closed.",
        operation: "configuration",
        retryable: false,
        service,
      });
    }
    const key = keyFor(service, connectorId);
    const existing = this.#lanes.get(key);
    if (existing) return existing;
    const lane = this.#createLane(service);
    this.#lanes.set(key, lane);
    return lane;
  }

  public retire(service: ConnectorService, connectorId: string) {
    const key = keyFor(service, connectorId);
    const lane = this.#lanes.get(key);
    if (!lane) return;
    this.#lanes.delete(key);
    try {
      lane.close();
    } catch {
      // Retirement is best effort after the owning transaction has committed.
    }
  }

  public close() {
    if (this.#closed) return;
    this.#closed = true;
    const lanes = [...this.#lanes.values()];
    this.#lanes.clear();
    for (const lane of lanes) lane.close();
  }
}
