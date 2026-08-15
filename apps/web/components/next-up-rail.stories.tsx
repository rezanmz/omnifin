import type { PlaybackContextResponse } from "@omnifin/contracts/playback";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fn } from "storybook/test";

import { demoContinueWatchingFeed } from "../lib/continue-watching-demo";
import { NextUpRail } from "./next-up-rail";

const sourceReferenceId = demoContinueWatchingFeed.items[0]!.media.id;
const nextReferenceId = `media_${"n".repeat(22)}`;
const continuation: PlaybackContextResponse = {
  currentDurationSeconds: 2_700,
  generatedAt: "2026-08-14T12:30:00.000Z",
  mediaReferenceId: sourceReferenceId,
  nextEpisode: {
    artworkPath: null,
    durationSeconds: 2_400,
    episodeNumber: 4,
    mediaReferenceId: nextReferenceId,
    seasonNumber: 2,
    seriesTitle: "Northern Lights",
    title: "Beyond the signal",
  },
  nextState: "ready",
  segments: [],
  segmentsState: "empty",
};

const meta = {
  args: {
    client: { loadContext: async () => continuation },
    enabled: true,
    feed: demoContinueWatchingFeed,
    onSelect: fn(),
  },
  component: NextUpRail,
  decorators: [
    (Story) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return (
        <QueryClientProvider client={queryClient}>
          <div style={{ padding: 32 }}>
            <Story />
          </div>
        </QueryClientProvider>
      );
    },
  ],
  title: "Components/Next up rail",
} satisfies Meta<typeof NextUpRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playable: Story = {};
export const Requestable: Story = {
  args: {
    client: {
      loadContext: async () => ({
        ...continuation,
        nextEpisode: { ...continuation.nextEpisode!, durationSeconds: null },
        nextState: "requestable",
      }),
    },
  },
};
export const Empty: Story = {
  args: {
    client: { loadContext: async () => ({ ...continuation, nextEpisode: null, nextState: "end" }) },
  },
};
