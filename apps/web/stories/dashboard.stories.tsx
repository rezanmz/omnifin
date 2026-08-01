import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DashboardScreen } from "../components/dashboard-screen";
import { OnboardingDashboard } from "../components/onboarding-dashboard";
import { demoDashboard } from "../lib/dashboard-data";
import { setupReadinessDemo } from "../lib/setup-readiness-demo";

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
  render: () => <OnboardingDashboard initialOutcome={setupReadinessDemo("partial")} />,
};
export const FirstRunTenFoot: Story = {
  args: { data: demoDashboard },
  render: () => (
    <OnboardingDashboard displayProfile="ten-foot" initialOutcome={setupReadinessDemo("partial")} />
  ),
};
export const FirstRunNeedsCore: Story = {
  args: { data: demoDashboard },
  render: () => <OnboardingDashboard initialOutcome={setupReadinessDemo("needs-core")} />,
};
export const FirstRunReady: Story = {
  args: { data: demoDashboard },
  render: () => <OnboardingDashboard initialOutcome={setupReadinessDemo("ready")} />,
};
export const FirstRunProviderUnavailable: Story = {
  args: { data: demoDashboard },
  render: () => <OnboardingDashboard initialOutcome={setupReadinessDemo("provider-unavailable")} />,
};
export const FirstRunDeploymentAttention: Story = {
  args: { data: demoDashboard },
  render: () => <OnboardingDashboard initialOutcome={setupReadinessDemo("deployment-attention")} />,
};
export const FirstRunDeploymentUnavailable: Story = {
  args: { data: demoDashboard },
  render: () => (
    <OnboardingDashboard initialOutcome={setupReadinessDemo("deployment-unavailable")} />
  ),
};
export const FirstRunSignedOut: Story = {
  args: { data: demoDashboard },
  render: () => <OnboardingDashboard initialOutcome={setupReadinessDemo("signed-out")} />,
};
