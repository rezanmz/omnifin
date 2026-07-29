import type { DownloadQueueAction, DownloadQueueItemState } from "@omnifin/contracts/downloads";

export interface ConnectorDownloadQueueItem {
  addedAt: string | null;
  category: string | null;
  etaSeconds: number | null;
  externalId: string;
  leechers: number | null;
  progress: number;
  queuePosition?: number | null;
  rateBytesPerSecond: number;
  remainingBytes: number;
  seeders: number | null;
  sizeBytes: number;
  state: DownloadQueueItemState;
  title: string;
}

export interface ConnectorDownloadQueueResult {
  generatedAt: string;
  items: ConnectorDownloadQueueItem[];
  truncated: boolean;
}

export interface DownloadQueueReader {
  readDownloadQueue(signal?: AbortSignal): Promise<ConnectorDownloadQueueResult>;
}

export interface DownloadQueueMutation {
  action: DownloadQueueAction;
  externalId: string;
}

export interface DownloadQueueRemoval {
  externalId: string;
}

export interface DownloadQueuePromotion {
  externalId: string;
}

export interface DownloadQueueController extends DownloadQueueReader {
  promoteDownloadQueueItem(input: DownloadQueuePromotion, signal?: AbortSignal): Promise<void>;
  removeDownloadQueueItem(input: DownloadQueueRemoval, signal?: AbortSignal): Promise<void>;
  updateDownloadQueueItem(input: DownloadQueueMutation, signal?: AbortSignal): Promise<void>;
}
