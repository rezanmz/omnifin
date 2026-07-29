import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { RequestReview } from "../components/request-review";
import type { RequestReviewClient, RequestReviewLoadOutcome } from "../lib/request-review";
import {
  demoRequestReviews,
  emptyRequestReviewOutcome,
  readyRequestReviewOutcome,
} from "../lib/request-review-demo";

const ready = readyRequestReviewOutcome as Extract<RequestReviewLoadOutcome, { status: "ready" }>;

function storyClient(): RequestReviewClient {
  return {
    list: async (query) => ({ ...ready.snapshot.page, status: query.status }),
    load: async () => ready,
    review: async (requestId, input) => ({
      replayed: false,
      request: {
        ...demoRequestReviews.find((item) => item.id === requestId)!,
        status: input.decision === "approve" ? "approved" : "declined",
        updatedAt: "2026-07-28T16:21:00.000Z",
      },
    }),
  };
}

const meta = {
  args: { client: storyClient(), initialOutcome: ready },
  argTypes: { client: { control: false }, initialOutcome: { control: false } },
  component: RequestReview,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Request review",
} satisfies Meta<typeof RequestReview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const ReadyLight: Story = { globals: { theme: "light" } };
export const Historical: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "All" }));
    await expect(canvas.getByText("The Phoenician Scheme")).toBeVisible();
  },
};
export const ApprovalConfirmation: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByText("A House of Dynamite").closest("article")!;
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await expect(canvas.getByRole("dialog", { name: "Send this into acquisition?" })).toBeVisible();
  },
};
export const Empty: Story = { args: { initialOutcome: emptyRequestReviewOutcome } };
export const Loading: Story = {
  render: () => (
    <RequestReview client={{ ...storyClient(), load: async () => new Promise(() => undefined) }} />
  ),
};
export const Restricted: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const NotConfigured: Story = { args: { initialOutcome: { status: "not_configured" } } };
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const GatewayUnavailable: Story = { args: { initialOutcome: { status: "unavailable" } } };
