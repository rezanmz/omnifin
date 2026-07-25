import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { demoDashboard } from "../lib/dashboard-data";
import { MediaRail } from "./media-rail";

const meta = {
  args: { items: demoDashboard.continueWatching, title: "Continue watching" },
  component: MediaRail,
  decorators: [
    (Story) => (
      <div style={{ padding: 32 }}>
        <Story />
      </div>
    ),
  ],
  title: "Components/Media rail",
} satisfies Meta<typeof MediaRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithProgress: Story = {};
export const Discovery: Story = {
  args: { items: demoDashboard.discovery, title: "Made for tonight" },
};
export const Empty: Story = { args: { items: [], title: "Continue watching" } };

export const DirectionalKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const firstPoster = canvas.getByRole("button", { name: /Open Ember Coast/i });
    firstPoster.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("button", { name: /Open The Quiet Archive/i })).toHaveFocus();
  },
};
