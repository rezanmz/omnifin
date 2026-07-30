import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { DiscoveryDashboard } from "../components/discovery-dashboard";
import { DiscoveryFeedClientError } from "../lib/discovery-feed";
import {
  degradedDiscoveryFeed,
  demoDiscoveryFeed,
  emptyDiscoveryFeed,
  unavailableDiscoveryFeed,
} from "../lib/discovery-feed-demo";

const meta = {
  args: { live: false, showContinueWatching: false },
  component: DiscoveryDashboard,
  decorators: [
    (Story) => (
      <main className="dashboard" style={{ minHeight: "100vh", paddingTop: 24 }}>
        <Story />
      </main>
    ),
  ],
  parameters: { layout: "fullscreen" },
  title: "Screens/Connected discovery",
} satisfies Meta<typeof DiscoveryDashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = { args: { initialFeed: demoDiscoveryFeed } };
export const Degraded: Story = { args: { initialFeed: degradedDiscoveryFeed } };
export const Empty: Story = { args: { initialFeed: emptyDiscoveryFeed } };
export const Unavailable: Story = { args: { initialFeed: unavailableDiscoveryFeed } };
export const Loading: Story = {
  args: {
    client: { load: async () => await new Promise<never>(() => undefined) },
    live: true,
  },
};
export const SignedOut: Story = {
  args: {
    client: {
      load: async () =>
        Promise.reject(
          new DiscoveryFeedClientError(
            "signed_out",
            "authentication_required",
            "Sign in required.",
          ),
        ),
    },
    live: true,
  },
};
