import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { demoDashboard } from "../lib/dashboard-data";
import { OperationsDock } from "./operations-dock";

const meta = {
  args: { operations: demoDashboard.operations },
  component: OperationsDock,
  decorators: [
    (Story) => (
      <div style={{ padding: 32 }}>
        <Story />
      </div>
    ),
  ],
  title: "Components/Operations dock",
} satisfies Meta<typeof OperationsDock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
export const Quiet: Story = { args: { operations: [] } };

export const ExpandedByKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: /2 acquisitions moving/i });
    await expect(toggle).toBeEnabled();
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByRole("button", { name: /The Far Meridian/i })).toBeInTheDocument();
  },
};
