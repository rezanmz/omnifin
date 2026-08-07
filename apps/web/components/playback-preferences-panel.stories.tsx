import { DEFAULT_PLAYBACK_PREFERENCES } from "@omnifin/contracts/playback";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { PlaybackPreferencesPanel } from "./playback-preferences-panel";

const meta = {
  args: {
    initialResponse: {
      networkClass: "home",
      preferences: DEFAULT_PLAYBACK_PREFERENCES,
      revision: 0,
      updatedAt: null,
    },
  },
  component: PlaybackPreferencesPanel,
  parameters: { layout: "fullscreen" },
  title: "Settings/Playback preferences",
} satisfies Meta<typeof PlaybackPreferencesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConservativeDefaults: Story = {};

export const CustomizedProfile: Story = {
  args: {
    initialResponse: {
      networkClass: "remote",
      preferences: {
        ...DEFAULT_PLAYBACK_PREFERENCES,
        audio: { languages: ["fa", "en-CA"], preferOriginalLanguage: true },
        quality: {
          defaultNetworkPolicy: "auto",
          homeMaxBitrate: 80_000_000,
          remoteMaxBitrate: 4_000_000,
        },
        subtitles: {
          ...DEFAULT_PLAYBACK_PREFERENCES.subtitles,
          languages: ["en-CA", "fa"],
        },
      },
      revision: 7,
      updatedAt: "2026-08-03T20:15:00.000Z",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Persian")).toHaveLength(2);
    await userEvent.click(canvas.getByRole("switch", { name: "Allow commentary tracks" }));
    await expect(canvas.getByText("Unsaved playback changes")).toBeVisible();
  },
};
