import type { OperationalService, SystemSignalSeverity } from "@omnifin/contracts/system";

export interface ConnectorSystemSignal {
  externalId: string;
  message: string;
  severity: SystemSignalSeverity;
  sourceLabel: string;
}

export interface ConnectorStorageCapacity {
  externalId: string;
  freeBytes: number;
  totalBytes: number;
}

export interface SystemHealthReader {
  readonly service: OperationalService;
  readSystemHealth(signal?: AbortSignal): Promise<readonly ConnectorSystemSignal[]>;
}

export interface StorageCapacityReader {
  readonly service: Extract<OperationalService, "radarr" | "sonarr">;
  readStorageCapacity(signal?: AbortSignal): Promise<readonly ConnectorStorageCapacity[]>;
}
