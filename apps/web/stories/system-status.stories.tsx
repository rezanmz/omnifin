import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { SystemStatus } from "../components/system-status";
import type { SystemStatusClient, SystemStatusLoadOutcome } from "../lib/system-status";
import {
  demoSystemStatus,
  demoSystemStatusGeneratedAt,
  demoSystemStatusPrincipal,
} from "../lib/system-status-demo";

const ready: SystemStatusLoadOutcome = {
  snapshot: { principal: demoSystemStatusPrincipal, status: demoSystemStatus },
  status: "ready",
};
const staticClient: SystemStatusClient = { load: async () => ready };

const meta = {
  args: { client: staticClient, initialOutcome: ready, live: false },
  argTypes: {
    client: { control: false },
    initialOutcome: { control: false },
  },
  component: SystemStatus,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/System health",
} satisfies Meta<typeof SystemStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("heading", { name: "Signal by signal" }),
    ).toBeVisible();
  },
};
export const ReadyLight: Story = { globals: { theme: "light" } };
export const Degraded: Story = {
  args: {
    initialOutcome: {
      snapshot: {
        principal: demoSystemStatusPrincipal,
        status: {
          ...demoSystemStatus,
          sources: demoSystemStatus.sources.map((source) =>
            source.service === "prowlarr"
              ? {
                  ...source,
                  failure: {
                    code: "timeout",
                    message: "Indexers did not answer before the connector timeout.",
                    occurredAt: demoSystemStatusGeneratedAt,
                    operation: "system.health",
                    retryable: true,
                    service: "prowlarr",
                  },
                  status: "unavailable" as const,
                }
              : source,
          ),
          state: "degraded",
          summary: { ...demoSystemStatus.summary, healthySources: 1, unavailableSources: 1 },
        },
      },
      status: "ready",
    },
  },
};
export const Unconfigured: Story = {
  args: {
    initialOutcome: {
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
    },
  },
};
export const Forbidden: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const Offline: Story = { args: { initialOutcome: { status: "unavailable" } } };
export const Loading: Story = {
  args: { client: { load: () => new Promise(() => undefined) }, live: true },
  render: ({ client }) => <SystemStatus client={client ?? staticClient} live />,
};
