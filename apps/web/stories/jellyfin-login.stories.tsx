import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { JellyfinCredentialScreen } from "../components/jellyfin-credential-screen";

const meta = {
  component: JellyfinCredentialScreen,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Authentication/Jellyfin sign in",
} satisfies Meta<typeof JellyfinCredentialScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const InvalidCredentials: Story = { args: { initialStatus: "invalid_credentials" } };
export const Unavailable: Story = { args: { initialStatus: "unavailable" } };
export const Submitting: Story = { args: { initialStatus: "submitting" } };
export const QuickConnectReady: Story = {
  args: { initialMethod: "quick-connect" },
};
export const QuickConnectGenerating: Story = {
  args: { initialMethod: "quick-connect", initialQuickConnectStatus: "starting" },
};
export const QuickConnectWaiting: Story = {
  args: {
    autoPollQuickConnect: false,
    initialMethod: "quick-connect",
    initialNow: Date.parse("2026-07-26T12:00:00.000Z"),
    initialQuickConnectTransaction: {
      code: "AB-1234",
      expiresAt: "2026-07-26T12:05:00.000Z",
      pollAfterMs: 2_000,
      transactionId: "storybook-quick-connect",
    },
  },
};
export const QuickConnectExpired: Story = {
  args: { initialMethod: "quick-connect", initialQuickConnectStatus: "expired" },
};
export const QuickConnectUnavailable: Story = {
  args: { initialMethod: "quick-connect", initialQuickConnectStatus: "unavailable" },
};
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
