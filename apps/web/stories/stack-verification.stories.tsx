import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { within } from "storybook/test";

import { CinematicBackdrop } from "../components/cinematic-backdrop";
import { LiquidGlassEnvironment } from "../components/liquid-glass-environment";
import { StackVerificationPanel } from "../components/stack-verification-panel";
import { stackVerificationDemo } from "../lib/stack-verification-demo";

const meta = {
  argTypes: {
    downloadReport: { control: false },
    initialOutcome: { control: false },
    runVerification: { control: false },
  },
  component: StackVerificationPanel,
  decorators: [
    (Story) => (
      <div className="onboarding-layout">
        <LiquidGlassEnvironment />
        <CinematicBackdrop />
        <main className="onboarding" style={{ paddingBlock: 48 }}>
          <Story />
        </main>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  tags: ["test"],
  title: "Components/Stack verification",
} satisfies Meta<typeof StackVerificationPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Running: Story = {
  args: { runVerification: async () => await new Promise(() => undefined) },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Run stack verification" }),
    );
  },
};

export const Ready: Story = {
  args: { initialOutcome: { report: stackVerificationDemo("ready"), status: "ready" } },
};

export const ReadyLight: Story = {
  args: { initialOutcome: { report: stackVerificationDemo("ready"), status: "ready" } },
  globals: { theme: "light" },
};

export const NeedsAttention: Story = {
  args: { initialOutcome: { report: stackVerificationDemo("attention"), status: "ready" } },
};

export const Unconfigured: Story = {
  args: { initialOutcome: { report: stackVerificationDemo("unconfigured"), status: "ready" } },
};

export const TemporarilyUnavailable: Story = {
  args: { initialOutcome: { status: "unavailable" } },
};

export const AlreadyRunning: Story = {
  args: { initialOutcome: { status: "in_progress" } },
};

export const AdministratorRequired: Story = {
  args: { initialOutcome: { status: "forbidden" } },
};

export const SignedOut: Story = {
  args: { initialOutcome: { status: "signed_out" } },
};
