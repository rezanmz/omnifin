import type { Metadata } from "next";

import { DownloadQueue } from "../../../../components/download-queue";
import { ThemeProvider } from "../../../../components/theme-provider";
import type { DownloadQueueLoadOutcome } from "../../../../lib/download-queue";
import { demoDownloadQueue, demoDownloadQueueGeneratedAt } from "../../../../lib/download-queue-demo";
import { readThemePreference } from "../../../../lib/theme-server";
import "../../../globals.css";

export const metadata: Metadata = { title: "Download queue" };
export const dynamic = "force-dynamic";

interface DownloadQueuePageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

function testOutcome(view: string | string[] | undefined): DownloadQueueLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (["forbidden", "signed_out", "unavailable"].includes(String(view))) {
    return { status: String(view) } as Exclude<DownloadQueueLoadOutcome, { status: "ready" }>;
  }
  if (view === "empty") {
    return {
      queue: {
        ...demoDownloadQueue,
        clients: demoDownloadQueue.clients.map((client) => ({
          ...client,
          itemCount: 0,
          rateBytesPerSecond: 0,
        })),
        items: [],
        summary: {
          attention: 0,
          downloading: 0,
          paused: 0,
          queued: 0,
          remainingBytes: 0,
          total: 0,
          totalRateBytesPerSecond: 0,
        },
      },
      status: "ready",
    };
  }
  if (view === "unconfigured") {
    return {
      queue: {
        clients: [],
        failures: [],
        generatedAt: demoDownloadQueueGeneratedAt,
        items: [],
        state: "unconfigured",
        summary: {
          attention: 0,
          downloading: 0,
          paused: 0,
          queued: 0,
          remainingBytes: 0,
          total: 0,
          totalRateBytesPerSecond: 0,
        },
        truncated: false,
      },
      status: "ready",
    };
  }
  if (view === "degraded") {
    const failure = {
      code: "timeout" as const,
      message: "SABnzbd did not respond before the deadline.",
      occurredAt: demoDownloadQueueGeneratedAt,
      operation: "download.queue",
      retryable: true,
      service: "sabnzbd" as const,
    };
    const items = demoDownloadQueue.items.filter((item) => item.client === "qbittorrent");
    return {
      queue: {
        ...demoDownloadQueue,
        clients: [
          {
            ...demoDownloadQueue.clients[0]!,
            itemCount: 2,
            rateBytesPerSecond: 48_600_000,
          },
          {
            ...demoDownloadQueue.clients[1]!,
            failure,
            itemCount: 0,
            rateBytesPerSecond: 0,
            status: "unavailable",
          },
        ],
        failures: [failure],
        items,
        state: "degraded",
        summary: {
          attention: 1,
          downloading: 1,
          paused: 0,
          queued: 0,
          remainingBytes: 13_600_000_000,
          total: 2,
          totalRateBytesPerSecond: 48_600_000,
        },
      },
      status: "ready",
    };
  }
  return view === "ready" ? { queue: demoDownloadQueue, status: "ready" } : undefined;
}

export default async function DownloadQueuePage({ searchParams }: DownloadQueuePageProperties) {
  const parameters = await searchParams;
  const preference = await readThemePreference();
  const test = testOutcome(parameters["test-view"]);
  const demo =
    test === undefined && process.env.OMNIFIN_DEMO_MODE === "true"
      ? ({ queue: demoDownloadQueue, status: "ready" } as const)
      : undefined;
  const outcome = test ?? demo;

  return (
    <ThemeProvider initialPreference={preference}>
      <DownloadQueue {...(outcome === undefined ? {} : { initialOutcome: outcome, live: false })} />
    </ThemeProvider>
  );
}
