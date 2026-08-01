import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { ErrorRecoveryScreen } from "./error-recovery-screen";

const meta = {
  args: { onRetry: fn() },
  component: ErrorRecoveryScreen,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Error recovery",
} satisfies Meta<typeof ErrorRecoveryScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RouteFailure: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const RootFailure: Story = { args: { fatal: true } };
