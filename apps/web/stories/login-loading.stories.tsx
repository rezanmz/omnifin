import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LoginScreenSkeleton } from "../components/login-screen";

const meta = {
  component: LoginScreenSkeleton,
  parameters: { layout: "fullscreen" },
  title: "Screens/Login/Loading",
} satisfies Meta<typeof LoginScreenSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {};
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
