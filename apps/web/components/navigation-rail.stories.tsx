import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { MobileNavigation, NavigationRail } from "./navigation-rail";

const meta = {
  component: NavigationRail,
  parameters: { layout: "fullscreen" },
  title: "Components/Primary navigation",
} satisfies Meta<typeof NavigationRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopRail: Story = {
  render: () => (
    <div className="navigation-preview navigation-preview--desktop">
      <NavigationRail />
    </div>
  ),
};

export const MobileBar: Story = {
  render: () => (
    <div className="navigation-preview navigation-preview--mobile">
      <MobileNavigation />
    </div>
  ),
};
