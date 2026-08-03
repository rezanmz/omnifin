import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { demoDashboard } from "../lib/dashboard-data";
import { DirectionalNavigationGroup } from "./directional-navigation-group";
import { HeroSpotlight } from "./hero-spotlight";

const openDetails = fn();
const openRequest = fn();

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
    actionRegion: (
      <DirectionalNavigationGroup className="hero-spotlight__actions">
        <button className="button button--primary" onClick={openDetails} type="button">
          View details
        </button>
        <button className="button button--glass" onClick={openRequest} type="button">
          Request title
        </button>
      </DirectionalNavigationGroup>
    ),
    artworkPath: `/api/discovery/artwork/discovery_art_${"a".repeat(22)}`,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "View details" }));
    await expect(openDetails).toHaveBeenCalledOnce();
  },
};
