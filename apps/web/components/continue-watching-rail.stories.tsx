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

function feedWithItemCount(count: number) {
  return {
    ...demoContinueWatchingFeed,
    items: Array.from({ length: count }, (_, index) => {
      const template =
        demoContinueWatchingFeed.items[index % demoContinueWatchingFeed.items.length]!;
      return {
        ...template,
        media: {
          ...template.media,
          artwork: {
            ...template.media.artwork,
            backdropPath: null,
            posterPath: null,
          },
          id: `media_${String(index + 1).padStart(22, "0")}`,
          title: index < 2 ? template.media.title : `${template.media.title} ${index + 1}`,
        },
      };
    }),
  };
}

export const OneItem: Story = {
  args: { initialOutcome: { feed: feedWithItemCount(1), status: "ready" } },
};
export const TwoItems: Story = {};
export const ManyItems: Story = {
  args: { initialOutcome: { feed: feedWithItemCount(7), status: "ready" } },
};
export const OneItemLight: Story = {
  args: { initialOutcome: { feed: feedWithItemCount(1), status: "ready" } },
  globals: { theme: "light" },
};
export const TwoItemsLight: Story = { globals: { theme: "light" } };
export const ManyItemsLight: Story = {
  args: { initialOutcome: { feed: feedWithItemCount(7), status: "ready" } },
  globals: { theme: "light" },
};
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
