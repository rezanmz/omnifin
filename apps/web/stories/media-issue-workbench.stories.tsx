import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { MediaIssueWorkbench } from "../components/media-issue-workbench";
import type { MediaIssueClient, MediaIssueLoadOutcome } from "../lib/media-issues";
import {
  degradedMediaIssueOutcome,
  demoMediaIssues,
  emptyMediaIssueOutcome,
  readyMediaIssueOutcome,
} from "../lib/media-issues-demo";

const ready = readyMediaIssueOutcome as Extract<MediaIssueLoadOutcome, { status: "ready" }>;

function storyClient(): MediaIssueClient {
  return {
    list: async (query) => ({ ...ready.snapshot.page, source: query.source, status: query.status }),
    load: async () => ready,
    updateStatus: async (issueId, input) => ({
      issue: {
        ...demoMediaIssues.find((issue) => issue.id === issueId)!,
        status: input.status,
        updatedAt: "2026-07-28T20:13:00.000Z",
      },
      replayed: false,
    }),
  };
}

const meta = {
  args: { client: storyClient(), initialOutcome: ready },
  argTypes: { client: { control: false }, initialOutcome: { control: false } },
  component: MediaIssueWorkbench,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Media issue workbench",
} satisfies Meta<typeof MediaIssueWorkbench>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const ReadyLight: Story = { globals: { theme: "light" } };
export const Resolved: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Resolved" }));
    await expect(canvas.getByText("Signal / Noise")).toBeVisible();
  },
};
export const ResolutionConfirmation: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByText("Northern Lights").closest("article")!;
    await userEvent.click(within(card).getByRole("button", { name: "Resolve" }));
    await expect(canvas.getByRole("dialog", { name: "Mark issue resolved?" })).toBeVisible();
  },
};
export const Empty: Story = { args: { initialOutcome: emptyMediaIssueOutcome } };
export const Degraded: Story = { args: { initialOutcome: degradedMediaIssueOutcome } };
export const Loading: Story = {
  render: () => (
    <MediaIssueWorkbench
      client={{ ...storyClient(), load: async () => new Promise(() => undefined) }}
    />
  ),
};
export const Restricted: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const GatewayUnavailable: Story = { args: { initialOutcome: { status: "unavailable" } } };
