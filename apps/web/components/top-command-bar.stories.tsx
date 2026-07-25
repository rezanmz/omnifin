import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { TopCommandBar } from "./top-command-bar";

const meta = {
  args: { connectionStatus: "healthy" },
  component: TopCommandBar,
  decorators: [
    (Story) => (
      <div style={{ minHeight: 120 }}>
        <Story />
      </div>
    ),
  ],
  title: "Components/Top command bar",
} satisfies Meta<typeof TopCommandBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {};
export const Attention: Story = { args: { connectionStatus: "attention" } };
export const Offline: Story = { args: { connectionStatus: "offline" } };
