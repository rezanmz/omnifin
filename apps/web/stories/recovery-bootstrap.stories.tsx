import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { RecoveryBootstrapEntry } from "../components/recovery-bootstrap-entry";

const meta = {
  component: RecoveryBootstrapEntry,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Authentication/First administrator recovery",
} satisfies Meta<typeof RecoveryBootstrapEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SecretEntry: Story = { args: { initialState: "idle" } };
export const Denied: Story = { args: { initialState: "denied" } };
export const RateLimited: Story = { args: { initialState: "rate_limited" } };
export const Unavailable: Story = { args: { initialState: "unavailable" } };
export const JellyfinAdministratorProof: Story = {
  args: {
    initialProof: { csrfToken: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG" },
  },
};
