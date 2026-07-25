import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ConnectionPulse } from "./connection-pulse";

const meta = {
  component: ConnectionPulse,
  parameters: { layout: "centered" },
  title: "Components/Connection pulse",
} satisfies Meta<typeof ConnectionPulse>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = { args: { status: "healthy" } };
export const Attention: Story = { args: { status: "attention" } };
export const Offline: Story = { args: { status: "offline" } };
