import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { DOWNLOAD_QUEUE_MAX_ITEMS } from "@omnifin/contracts/downloads";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import type {
  ConnectorDownloadQueueResult,
  DownloadQueueMutation,
  DownloadQueuePromotion,
  DownloadQueueRemoval,
} from "../downloads.js";
import { SafeConnectorError } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

export interface QBittorrentAdapterConfig extends ConnectorTargetConfig {
  username: string;
  password: string;
}

export function isQBittorrentLoginResponseAccepted(status: number, body: string): boolean {
  const normalizedBody = body.trim();
  return (status === 200 && normalizedBody === "Ok.") || (status === 204 && normalizedBody === "");
}

export function readQBittorrentSessionCookie(setCookie: string | null): string | null {
  if (!setCookie || setCookie.length > 16_384) return null;
  const pair = setCookie.split(";", 1)[0]?.trim();
  const separator = pair?.indexOf("=") ?? -1;
  if (!pair || separator <= 0) return null;
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  if (name !== "SID") {
    const port = name.match(/^QBT_SID_([1-9]\d{0,4})$/u)?.[1];
    if (!port || Number(port) > 65_535) return null;
  }
  return /^(?=.{1,512}$)[A-Za-z0-9._~+\/-]+={0,2}$/u.test(value) ? `${name}=${value}` : null;
}

const torrentSchema = z.object({
  added_on: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  amount_left: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  category: z.string().max(1_024).nullish(),
  dlspeed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  eta: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  hash: z.string().regex(/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/u),
  name: z.string().min(1).max(4_096),
  num_leechs: z.number().int().nonnegative().max(2_147_483_647).nullish(),
  num_seeds: z.number().int().nonnegative().max(2_147_483_647).nullish(),
  priority: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).nullish(),
  progress: z.number().finite().min(0).max(1),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.string().trim().min(1).max(64),
});

const torrentListSchema = z.array(torrentSchema).max(DOWNLOAD_QUEUE_MAX_ITEMS + 1);
const torrentHashSchema = z.string().regex(/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/u);

const activeStates = new Set([
  "allocating",
  "checkingDL",
  "checkingResumeData",
  "downloading",
  "error",
  "forcedDL",
  "metaDL",
  "missingFiles",
  "moving",
  "pausedDL",
  "queuedDL",
  "stalledDL",
  "stoppedDL",
]);

function cleanText(value: string, maximum: number) {
  const segment = value.split(/[\\/]/u).at(-1) ?? value;
  const cleaned = segment.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || "Untitled download").slice(0, maximum);
}

function optionalText(value: string | null | undefined) {
  const cleaned = value?.replace(/[\p{Cc}\p{Cf}\\/]/gu, "").trim();
  return cleaned ? cleaned.slice(0, 80) : null;
}

function itemState(value: string) {
  if (value === "error" || value === "missingFiles") return "failed" as const;
  if (value === "pausedDL" || value === "stoppedDL") return "paused" as const;
  if (value === "queuedDL" || value === "metaDL") return "queued" as const;
  if (["allocating", "checkingDL", "checkingResumeData"].includes(value)) {
    return "checking" as const;
  }
  if (value === "moving") return "moving" as const;
  if (value === "stalledDL") return "stalled" as const;
  if (value === "downloading" || value === "forcedDL") return "downloading" as const;
  return "unknown" as const;
}

function timestamp(seconds: number | null | undefined) {
  if (!seconds) return null;
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function etaSeconds(value: number | null | undefined) {
  return value !== undefined && value !== null && value < 8_640_000 ? value : null;
}

export class QBittorrentAdapter extends ProbeOnlyAdapter {
  readonly service = "qbittorrent" as const;
  override readonly capabilities = [
    "connector.health",
    "connector.version",
    "download.queue.read",
    "download.queue.mutate",
  ] as const;
  readonly #username: string;
  readonly #password: string;

  constructor(config: QBittorrentAdapterConfig) {
    super(config, [config.username, config.password]);
    this.#username = config.username;
    this.#password = config.password;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const cookie = await this.authenticate(signal);

      const version = await this.client.requestText("api/v2/app/version", {
        operation: "probe",
        headers: this.authenticatedHeaders(cookie),
        ...(signal ? { signal } : {}),
      });
      return {
        value: version.body,
        additionalProtectedValues: [cookie.slice(cookie.indexOf("=") + 1)],
      };
    });
  }

  async readDownloadQueue(signal?: AbortSignal): Promise<ConnectorDownloadQueueResult> {
    const cookie = await this.authenticate(signal);
    const torrents = await this.client.requestJson("api/v2/torrents/info", torrentListSchema, {
      operation: "download.queue",
      headers: this.authenticatedHeaders(cookie),
      query: {
        filter: "all",
        limit: String(DOWNLOAD_QUEUE_MAX_ITEMS + 1),
        offset: "0",
        reverse: "true",
        sort: "added_on",
      },
      ...(signal ? { signal } : {}),
    });
    const active = torrents.filter(
      (torrent) => torrent.progress < 1 || activeStates.has(torrent.state),
    );
    const selected = active.slice(0, DOWNLOAD_QUEUE_MAX_ITEMS);
    return {
      generatedAt: this.clock.now().toISOString(),
      items: selected.map((torrent) => ({
        addedAt: timestamp(torrent.added_on),
        category: optionalText(torrent.category),
        etaSeconds: etaSeconds(torrent.eta),
        externalId: torrent.hash.toLowerCase(),
        leechers: torrent.num_leechs ?? null,
        progress: torrent.progress,
        queuePosition:
          torrent.priority !== undefined && torrent.priority !== null && torrent.priority > 0
            ? torrent.priority - 1
            : null,
        rateBytesPerSecond: torrent.dlspeed ?? 0,
        remainingBytes: Math.min(
          torrent.size,
          torrent.amount_left ?? Math.max(0, Math.round(torrent.size * (1 - torrent.progress))),
        ),
        seeders: torrent.num_seeds ?? null,
        sizeBytes: torrent.size,
        state: itemState(torrent.state),
        title: cleanText(torrent.name, 300),
      })),
      truncated:
        active.length > DOWNLOAD_QUEUE_MAX_ITEMS || torrents.length > DOWNLOAD_QUEUE_MAX_ITEMS,
    };
  }

  async updateDownloadQueueItem(input: DownloadQueueMutation, signal?: AbortSignal): Promise<void> {
    const externalId = torrentHashSchema.parse(input.externalId).toLowerCase();
    const cookie = await this.authenticate(signal);
    const version = await this.client.requestText("api/v2/app/version", {
      operation: "download.queue.action",
      headers: this.authenticatedHeaders(cookie),
      ...(signal ? { signal } : {}),
    });
    const versionMatch = /^v?(\d+)(?:\.\d+){1,3}(?:[^\p{Cc}\p{Cf}]*)?$/u.exec(version.body.trim());
    if (!versionMatch?.[1]) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "download.queue.action",
        code: "unsupported_version",
        message: "qbittorrent returned a version that cannot be safely controlled.",
        retryable: false,
      });
    }
    const major = Number(versionMatch[1]);
    if (!Number.isSafeInteger(major) || major < 4) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "download.queue.action",
        code: "unsupported_version",
        message: "qbittorrent does not support safe queue controls at this version.",
        retryable: false,
      });
    }
    const command =
      input.action === "pause" ? (major >= 5 ? "stop" : "pause") : major >= 5 ? "start" : "resume";
    await this.client.requestText(`api/v2/torrents/${command}`, {
      operation: "download.queue.action",
      method: "POST",
      headers: {
        ...this.authenticatedHeaders(cookie),
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ hashes: externalId }),
      ...(signal ? { signal } : {}),
    });
  }

  async removeDownloadQueueItem(input: DownloadQueueRemoval, signal?: AbortSignal): Promise<void> {
    const externalId = torrentHashSchema.parse(input.externalId).toLowerCase();
    const cookie = await this.authenticate(signal);
    await this.client.requestText("api/v2/torrents/delete", {
      operation: "download.queue.remove",
      method: "POST",
      headers: {
        ...this.authenticatedHeaders(cookie),
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ hashes: externalId, deleteFiles: "false" }),
      ...(signal ? { signal } : {}),
    });
  }

  async promoteDownloadQueueItem(
    input: DownloadQueuePromotion,
    signal?: AbortSignal,
  ): Promise<void> {
    const externalId = torrentHashSchema.parse(input.externalId).toLowerCase();
    const cookie = await this.authenticate(signal);
    await this.client.requestText("api/v2/torrents/topPrio", {
      operation: "download.queue.promote",
      method: "POST",
      headers: {
        ...this.authenticatedHeaders(cookie),
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ hashes: externalId }),
      ...(signal ? { signal } : {}),
    });
  }

  private authenticatedHeaders(cookie: string) {
    return { Cookie: cookie, Origin: this.client.origin, Referer: `${this.client.origin}/` };
  }

  private async authenticate(signal?: AbortSignal) {
    const form = new URLSearchParams({ username: this.#username, password: this.#password });
    const login = await this.client.requestText("api/v2/auth/login", {
      operation: "authenticate",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Origin: this.client.origin,
        Referer: `${this.client.origin}/`,
      },
      body: form,
      ...(signal ? { signal } : {}),
    });

    const cookie = readQBittorrentSessionCookie(login.headers.get("set-cookie"));
    if (!isQBittorrentLoginResponseAccepted(login.status, login.body) || !cookie) {
      throw new SafeConnectorError({
        service: this.service,
        operation: "authenticate",
        code: "invalid_credentials",
        message: "qbittorrent rejected the configured credentials.",
        retryable: false,
      });
    }
    return cookie;
  }
}
