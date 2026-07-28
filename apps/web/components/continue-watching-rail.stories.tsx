import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import {
  demoContinueWatchingFeed,
  emptyContinueWatchingFeed,
  unavailableContinueWatchingFeed,
} from "../lib/continue-watching-demo";
import { ContinueWatchingRail } from "./continue-watching-rail";

const meta = {
  args: {
    initialOutcome: { feed: demoContinueWatchingFeed, status: "ready" },
    live: false,
  },
  component: ContinueWatchingRail,
  decorators: [
    (Story) => (
      <div style={{ padding: 32 }}>
        <Story />
      </div>
    ),
  ],
  title: "Components/Continue Watching rail",
} satisfies Meta<typeof ContinueWatchingRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Empty: Story = {
  args: { initialOutcome: { feed: emptyContinueWatchingFeed, status: "ready" } },
};
export const Unavailable: Story = {
  args: { initialOutcome: { feed: unavailableContinueWatchingFeed, status: "ready" } },
};
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const Restricted: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const Loading: Story = {
  render: () => (
    <ContinueWatchingRail client={{ load: () => new Promise<never>(() => undefined) }} live />
  ),
};
