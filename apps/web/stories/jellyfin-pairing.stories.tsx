import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { JellyfinCredentialScreen } from "../components/jellyfin-credential-screen";

const readySession = {
  csrfToken: "storybook_pairing_csrf_token_0123456789abcdefgh",
  status: "ready" as const,
};

const meta = {
  args: { initialPairingSession: readySession, intent: "pair" },
  component: JellyfinCredentialScreen,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Authentication/Jellyfin pairing",
} satisfies Meta<typeof JellyfinCredentialScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Password: Story = {};
export const IdentityConflict: Story = { args: { initialStatus: "identity_conflict" } };
export const SessionExpired: Story = {
  args: { initialPairingSession: { status: "signed_out" } },
};
export const IneligibleAccount: Story = {
  args: { initialPairingSession: { status: "ineligible" } },
};
export const GatewayUnavailable: Story = {
  args: { initialPairingSession: { status: "unavailable" } },
};
export const QuickConnect: Story = {
  args: {
    autoPollQuickConnect: false,
    initialMethod: "quick-connect",
    initialNow: Date.parse("2026-07-26T12:00:00.000Z"),
    initialQuickConnectTransaction: {
      code: "CD-5678",
      expiresAt: "2026-07-26T12:05:00.000Z",
      pollAfterMs: 2_000,
      transactionId: "storybook-pairing-quick-connect",
    },
  },
};
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
