import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DashboardState } from "./dashboard-state";

const meta = {
  component: DashboardState,
  decorators: [
    (Story) => (
      <div style={{ minHeight: "100vh", padding: 32 }}>
        <Story />
      </div>
    ),
  ],
  title: "Screens/Dashboard states",
} satisfies Meta<typeof DashboardState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { kind: "loading" } };
export const Empty: Story = { args: { kind: "empty" } };
export const Offline: Story = { args: { kind: "offline" } };
export const PermissionDenied: Story = { args: { kind: "permission-denied" } };
export const Stale: Story = { args: { kind: "stale" } };
export const RecoverableError: Story = { args: { kind: "recoverable-error" } };
export const TerminalError: Story = { args: { kind: "terminal-error" } };
export const Unsupported: Story = { args: { kind: "unsupported" } };
