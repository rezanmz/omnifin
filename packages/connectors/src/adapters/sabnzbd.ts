import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { DOWNLOAD_QUEUE_MAX_ITEMS } from "@omnifin/contracts/downloads";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type {
  ConnectorDownloadQueueResult,
  DownloadQueueMutation,
  DownloadQueueRemoval,
} from "../downloads.js";
import { SafeConnectorError } from "../http/safe-http-client.js";
import type { OptionalApiKeyConnectorConfig } from "../types.js";

const sabnzbdVersionSchema = z.object({
  version: upstreamVersionSchema,
});

const numberLikeSchema = z
  .union([
    z.number().finite().nonnegative(),
    z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d+)?$/u),
  ])
  .transform(Number)
  .pipe(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER));

const megabyteLikeSchema = numberLikeSchema.pipe(
  z.number().max(Math.floor(Number.MAX_SAFE_INTEGER / 1_048_576)),
);

const sabnzbdSlotSchema = z.object({
  cat: z.string().max(1_024).nullish(),
  filename: z.string().trim().min(1).max(4_096),
  mb: megabyteLikeSchema,
  mbleft: megabyteLikeSchema,
  nzo_id: z.string().trim().min(1).max(512),
  percentage: numberLikeSchema.pipe(z.number().max(100)),
  status: z.string().trim().min(1).max(64),
  timeleft: z.string().trim().max(64).nullish(),
});

const sabnzbdQueueSchema = z.object({
  queue: z.object({
    kbpersec: numberLikeSchema.nullish(),
    slots: z.array(sabnzbdSlotSchema).max(DOWNLOAD_QUEUE_MAX_ITEMS + 1),
  }),
});

const sabnzbdQueueActionSchema = z.object({
  nzo_ids: z.array(z.string().trim().min(1).max(512)).max(1).optional(),
  status: z.boolean(),
});
const sabnzbdQueueIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,512}$/u);

function cleanText(value: string, maximum: number) {
  const segment = value.split(/[\\/]/u).at(-1) ?? value;
  const cleaned = segment.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || "Untitled download").slice(0, maximum);
}

function optionalText(value: string | null | undefined) {
  const cleaned = value?.replace(/[\p{Cc}\p{Cf}\\/]/gu, "").trim();
  return cleaned ? cleaned.slice(0, 80) : null;
}

function queueState(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "downloading" || normalized === "fetching") return "downloading" as const;
  if (normalized === "queued" || normalized === "propagating") return "queued" as const;
  if (normalized === "paused") return "paused" as const;
  if (normalized === "failed") return "failed" as const;
  return "unknown" as const;
}

function parseEta(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{1,4}):(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const total = hours * 3_600 + minutes * 60 + seconds;
  return total <= 31_536_000 ? total : null;
}

export class SabnzbdAdapter extends ProbeOnlyAdapter {
  readonly service = "sabnzbd" as const;
  override readonly capabilities;
  readonly #apiKey: string | null;

  constructor(config: OptionalApiKeyConnectorConfig) {
    const apiKey = config.apiKey?.trim() || null;
    super(config, apiKey ? [apiKey] : []);
    this.#apiKey = apiKey;
    this.capabilities = apiKey
      ? ([
          "connector.health",
          "connector.version",
          "download.queue.read",
          "download.queue.mutate",
        ] as const)
      : (["connector.health", "connector.version"] as const);
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const version = await this.client.requestJson("api", sabnzbdVersionSchema, {
        operation: "probe",
        query: {
          mode: "version",
          output: "json",
          ...(this.#apiKey ? { apikey: this.#apiKey } : {}),
        },
        ...(signal ? { signal } : {}),
      });
      return version.version;
    });
  }

  async readDownloadQueue(signal?: AbortSignal): Promise<ConnectorDownloadQueueResult> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "download.queue",
        code: "configuration_invalid",
        message: "SABnzbd queue access requires a configured API key.",
        retryable: false,
      });
    }
    const response = await this.client.requestJson("api", sabnzbdQueueSchema, {
      operation: "download.queue",
      query: {
        apikey: this.#apiKey,
        limit: String(DOWNLOAD_QUEUE_MAX_ITEMS + 1),
        mode: "queue",
        output: "json",
        start: "0",
      },
      ...(signal ? { signal } : {}),
    });
    const selected = response.queue.slots.slice(0, DOWNLOAD_QUEUE_MAX_ITEMS);
    const globalRate = Math.round((response.queue.kbpersec ?? 0) * 1_024);
    const activeIndexes = selected
      .map((slot, index) => ({ index, state: queueState(slot.status) }))
      .filter(({ state }) => state === "downloading")
      .map(({ index }) => index);
    const perActiveRate =
      activeIndexes.length > 0 ? Math.floor(globalRate / activeIndexes.length) : 0;
    const remainder = globalRate - perActiveRate * activeIndexes.length;
    return {
      generatedAt: this.clock.now().toISOString(),
      items: selected.map((slot, index) => {
        const sizeBytes = Math.round(slot.mb * 1_048_576);
        return {
          addedAt: null,
          category: optionalText(slot.cat),
          etaSeconds: parseEta(slot.timeleft),
          externalId: slot.nzo_id,
          leechers: null,
          progress: slot.percentage / 100,
          rateBytesPerSecond:
            perActiveRate > 0 && activeIndexes.includes(index)
              ? perActiveRate + (index === activeIndexes[0] ? remainder : 0)
              : 0,
          remainingBytes: Math.min(sizeBytes, Math.round(slot.mbleft * 1_048_576)),
          seeders: null,
          sizeBytes,
          state: queueState(slot.status),
          title: cleanText(slot.filename, 300),
        };
      }),
      truncated: response.queue.slots.length > DOWNLOAD_QUEUE_MAX_ITEMS,
    };
  }

  async updateDownloadQueueItem(input: DownloadQueueMutation, signal?: AbortSignal): Promise<void> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "download.queue.action",
        code: "configuration_invalid",
        message: "SABnzbd queue controls require a configured API key.",
        retryable: false,
      });
    }
    const externalId = sabnzbdQueueIdSchema.parse(input.externalId);
    const response = await this.client.requestJson("api", sabnzbdQueueActionSchema, {
      operation: "download.queue.action",
      query: {
        apikey: this.#apiKey,
        mode: "queue",
        name: input.action,
        output: "json",
        value: externalId,
      },
      ...(signal ? { signal } : {}),
    });
    if (!response.status || (response.nzo_ids && response.nzo_ids[0] !== externalId)) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "download.queue.action",
        code: "response_invalid",
        message: "SABnzbd did not confirm the exact queue item action.",
        retryable: false,
      });
    }
  }

  async removeDownloadQueueItem(input: DownloadQueueRemoval, signal?: AbortSignal): Promise<void> {
    if (!this.#apiKey) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "download.queue.remove",
        code: "configuration_invalid",
        message: "SABnzbd queue removal requires a configured API key.",
        retryable: false,
      });
    }
    const externalId = sabnzbdQueueIdSchema.parse(input.externalId);
    const response = await this.client.requestJson("api", sabnzbdQueueActionSchema, {
      operation: "download.queue.remove",
      query: {
        apikey: this.#apiKey,
        mode: "queue",
        name: "delete",
        output: "json",
        value: externalId,
      },
      ...(signal ? { signal } : {}),
    });
    if (!response.status || response.nzo_ids?.length !== 1 || response.nzo_ids[0] !== externalId) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "download.queue.remove",
        code: "response_invalid",
        message: "SABnzbd did not confirm the exact queue item removal.",
        retryable: false,
      });
    }
  }
}
