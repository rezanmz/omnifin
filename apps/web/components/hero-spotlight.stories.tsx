import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { demoDashboard } from "../lib/dashboard-data";
import { HeroSpotlight } from "./hero-spotlight";

const meta = {
  args: { hero: demoDashboard.hero },
  component: HeroSpotlight,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 1400, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
  title: "Components/Hero spotlight",
} satisfies Meta<typeof HeroSpotlight>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ConnectedArtwork: Story = {
  args: {
    artworkPath: `/api/discovery/artwork/discovery_art_${"a".repeat(22)}`,
    onDetails: fn(),
    onRequest: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "View details" }));
    await expect(args.onDetails).toHaveBeenCalledOnce();
  },
};
