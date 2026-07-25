import type { Meta, StoryObj } from "@storybook/nextjs-vite";
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
