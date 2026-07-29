import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AcquisitionMonitoringPanel } from "../components/acquisition-monitoring-panel";

const monitored = {
  monitored: true,
  target: { kind: "movie" as const, mediaId: 42, service: "radarr" as const },
  verifiedAt: "2026-07-28T12:00:00.000Z",
};

const meta = {
  args: {
    onBegin: () => undefined,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onRetry: () => undefined,
    state: { data: monitored, kind: "ready" },
    title: "The Far Meridian",
  },
  argTypes: {
    onBegin: { control: false },
    onCancel: { control: false },
    onConfirm: { control: false },
    onRetry: { control: false },
    state: { control: false },
  },
  component: AcquisitionMonitoringPanel,
  decorators: [
    (Story) => (
      <div style={{ margin: "40px auto", maxWidth: 530, padding: 20 }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Acquisition monitoring",
} satisfies Meta<typeof AcquisitionMonitoringPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enabled: Story = {};

export const EnabledLight: Story = { globals: { theme: "light" } };

export const Paused: Story = {
  args: { state: { data: { ...monitored, monitored: false }, kind: "ready" } },
};

export const Confirmation: Story = {
  args: { state: { data: monitored, kind: "confirming" } },
};

export const Submitting: Story = {
  args: { state: { data: monitored, kind: "submitting" } },
};

export const Loading: Story = { args: { state: { kind: "loading" } } };

export const ConfigurationUnavailable: Story = {
  args: { state: { errorKind: "configuration", kind: "error" } },
};

export const TemporarilyOffline: Story = {
  args: { state: { errorKind: "unavailable", kind: "error" } },
};

export const SignedOut: Story = {
  args: { state: { errorKind: "signed_out", kind: "error" } },
};
