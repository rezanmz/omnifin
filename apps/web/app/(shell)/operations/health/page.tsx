import type { PartialFailure } from "@omnifin/contracts/connectors";
import type { Metadata } from "next";

import { ApplicationShellEnhancements } from "../../../../components/application-shell-enhancements";
import { SystemStatus } from "../../../../components/system-status";
import { ThemeProvider } from "../../../../components/theme-provider";
import type { SystemStatusLoadOutcome } from "../../../../lib/system-status";
import {
  demoSystemStatus,
  demoSystemStatusGeneratedAt,
  demoSystemStatusPrincipal,
} from "../../../../lib/system-status-demo";
import { readThemePreference } from "../../../../lib/theme-server";
import "../../../globals.css";

export const metadata: Metadata = { title: "System health" };
export const dynamic = "force-dynamic";

interface SystemStatusPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const unavailableFailure: PartialFailure = {
  code: "timeout",
  message: "Indexers did not answer before the connector timeout.",
  occurredAt: demoSystemStatusGeneratedAt,
  operation: "system.health",
  retryable: true,
  service: "prowlarr",
};

function testOutcome(view: string | string[] | undefined): SystemStatusLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (["forbidden", "signed_out", "unavailable"].includes(String(view))) {
    return { status: String(view) } as Exclude<SystemStatusLoadOutcome, { status: "ready" }>;
  }
  if (view === "unconfigured") {
    return {
      snapshot: {
        principal: demoSystemStatusPrincipal,
        status: {
          generatedAt: demoSystemStatusGeneratedAt,
          sources: [],
          state: "unconfigured",
          summary: {
            attentionSources: 0,
            criticalStorage: 0,
            errorSignals: 0,
            healthySources: 0,
            noticeSignals: 0,
            sources: 0,
            unavailableSources: 0,
            warningSignals: 0,
            warningStorage: 0,
          },
        },
      },
      status: "ready",
    };
  }
  if (view === "degraded") {
    return {
      snapshot: {
        principal: demoSystemStatusPrincipal,
        status: {
          ...demoSystemStatus,
          sources: demoSystemStatus.sources.map((source) =>
            source.service === "prowlarr"
              ? {
                  ...source,
                  failure: unavailableFailure,
                  status: "unavailable" as const,
                }
              : source,
          ),
          state: "degraded",
          summary: {
            ...demoSystemStatus.summary,
            healthySources: 1,
            unavailableSources: 1,
          },
        },
      },
      status: "ready",
    };
  }
  return view === "ready"
    ? {
        snapshot: { principal: demoSystemStatusPrincipal, status: demoSystemStatus },
        status: "ready",
      }
    : undefined;
}

export default async function SystemHealthPage({ searchParams }: SystemStatusPageProperties) {
  const parameters = await searchParams;
  const preference = await readThemePreference();
  const test = testOutcome(parameters["test-view"]);
  const demo =
    test === undefined && process.env.OMNIFIN_DEMO_MODE === "true"
      ? ({
          snapshot: { principal: demoSystemStatusPrincipal, status: demoSystemStatus },
          status: "ready",
        } as const)
      : undefined;
  const outcome = test ?? demo;

  return (
    <>
      <ApplicationShellEnhancements initialPreference={preference} />
      <ThemeProvider initialPreference={preference}>
        <SystemStatus
          {...(outcome === undefined ? {} : { initialOutcome: outcome, live: false })}
        />
      </ThemeProvider>
    </>
  );
}
