import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DashboardScreen } from "../components/dashboard-screen";
import { OnboardingDashboard } from "../components/onboarding-dashboard";
import StandaloneApplicationShell from "../components/standalone-application-shell";
import { demoDashboard } from "../lib/dashboard-data";
import { setupReadinessDemo } from "../lib/setup-readiness-demo";

const meta = {
  component: DashboardScreen,
  parameters: { layout: "fullscreen" },
  title: "Screens/Dashboard",
} satisfies Meta<typeof DashboardScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {
  args: { data: demoDashboard },
  render: (properties) => (
    <StandaloneApplicationShell
      accent={properties.data.hero.accent}
      current="discover"
      displayProfile="standard"
      status="attention"
      themePreference="system"
    >
      <DashboardScreen {...properties} />
    </StandaloneApplicationShell>
  ),
};
export const ConfiguredTenFoot: Story = {
  args: { data: demoDashboard, displayProfile: "ten-foot" },
  render: (properties) => (
    <StandaloneApplicationShell
      accent={properties.data.hero.accent}
      current="discover"
      displayProfile="ten-foot"
      status="attention"
      themePreference="system"
    >
      <DashboardScreen {...properties} />
    </StandaloneApplicationShell>
  ),
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
