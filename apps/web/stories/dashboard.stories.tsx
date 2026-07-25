import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DashboardScreen } from "../components/dashboard-screen";
import { OnboardingDashboard } from "../components/onboarding-dashboard";
import { demoDashboard } from "../lib/dashboard-data";

const meta = {
  component: DashboardScreen,
  parameters: { layout: "fullscreen" },
  title: "Screens/Dashboard",
} satisfies Meta<typeof DashboardScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = { args: { data: demoDashboard } };
export const ConfiguredTenFoot: Story = {
  args: { data: demoDashboard, displayProfile: "ten-foot" },
};
export const FirstRun: Story = {
  args: { data: demoDashboard },
  render: () => <OnboardingDashboard />,
};
export const FirstRunTenFoot: Story = {
  args: { data: demoDashboard },
  render: () => <OnboardingDashboard displayProfile="ten-foot" />,
};
