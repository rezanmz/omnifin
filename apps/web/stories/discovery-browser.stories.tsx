import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { DiscoveryBrowser } from "../components/discovery-browser";
import { DiscoveryBrowseClientError } from "../lib/discovery-browse";
import {
  demoBrowseCriteria,
  demoBrowseResponse,
  emptyBrowseResponse,
} from "../lib/discovery-browse-demo";

const meta = {
  args: { initialCriteria: demoBrowseCriteria, live: false },
  component: DiscoveryBrowser,
  parameters: { layout: "fullscreen" },
  title: "Screens/Browse discovery",
} satisfies Meta<typeof DiscoveryBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = { args: { initialResponse: demoBrowseResponse } };
export const Empty: Story = { args: { initialResponse: emptyBrowseResponse } };
export const Loading: Story = { args: {} };
export const Unavailable: Story = {
  args: {
    client: {
      load: async () =>
        Promise.reject(
          new DiscoveryBrowseClientError(
            "unavailable",
            "service_unavailable",
            "Browse is temporarily unavailable.",
          ),
        ),
    },
    live: true,
  },
};
