import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { DownloadQueue } from "../components/download-queue";
import type { DownloadQueueClient, DownloadQueueLoadOutcome } from "../lib/download-queue";
import { demoDownloadQueue, demoDownloadQueueGeneratedAt } from "../lib/download-queue-demo";

const ready: DownloadQueueLoadOutcome = { queue: demoDownloadQueue, status: "ready" };

const staticClient: DownloadQueueClient = {
  act: async () => {
    throw new Error("Story actions stop at confirmation.");
  },
  load: async () => demoDownloadQueue,
  loadEligibility: async () => ({ status: "unavailable" }),
};

const meta = {
  args: { client: staticClient, initialOutcome: ready, live: false },
  argTypes: {
    client: { control: false },
    initialOutcome: { control: false },
  },
  component: DownloadQueue,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Download queue",
} satisfies Meta<typeof DownloadQueue>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const ReadyLight: Story = { globals: { theme: "light" } };
export const AttentionFilter: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Attention" }));
    await expect(canvas.getByText("Glass.Horizon.2025.1080p.BluRay")).toBeVisible();
    await expect(canvas.queryByText("Signal.S01E07.1080p.WEB-DL")).not.toBeInTheDocument();
  },
};
export const PauseConfirmation: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Pause The.Far.Meridian.2026.2160p.WEB-DL" }),
    );
    await expect(canvas.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await expect(canvas.getByText("Pause this transfer?")).toBeVisible();
  },
};
export const ResumeConfirmation: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Resume Signal.S01E07.1080p.WEB-DL" }),
    );
    await expect(canvas.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await expect(canvas.getByText("Resume this transfer?")).toBeVisible();
  },
};
export const Empty: Story = {
  args: {
    initialOutcome: {
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
    },
  },
};
export const Degraded: Story = {
  args: {
    initialOutcome: {
      queue: {
        ...demoDownloadQueue,
        clients: [
          demoDownloadQueue.clients[0]!,
          {
            ...demoDownloadQueue.clients[1]!,
            failure: {
              code: "timeout",
              message: "SABnzbd did not respond before the deadline.",
              occurredAt: demoDownloadQueueGeneratedAt,
              operation: "download.queue",
              retryable: true,
              service: "sabnzbd",
            },
            itemCount: 0,
            rateBytesPerSecond: 0,
            status: "unavailable",
          },
        ],
        failures: [
          {
            code: "timeout",
            message: "SABnzbd did not respond before the deadline.",
            occurredAt: demoDownloadQueueGeneratedAt,
            operation: "download.queue",
            retryable: true,
            service: "sabnzbd",
          },
        ],
        items: demoDownloadQueue.items.filter((item) => item.client === "qbittorrent"),
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
    },
  },
};
export const Unconfigured: Story = {
  args: {
    initialOutcome: {
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
    },
  },
};
export const Forbidden: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const Loading: Story = {
  args: {
    client: { load: () => new Promise(() => undefined) },
    live: true,
  },
  render: ({ client }) => <DownloadQueue client={client ?? staticClient} live />,
};
