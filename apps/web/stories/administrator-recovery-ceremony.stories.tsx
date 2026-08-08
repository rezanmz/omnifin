import type { AuthProvider } from "@omnifin/contracts/auth";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AdministratorRecoveryCeremony } from "../components/administrator-recovery-ceremony";
import { ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT } from "../lib/administrator-recovery";

const preview = {
  activeSessions: 3,
  authenticationMethods: ["jellyfin", "oidc"] as ("jellyfin" | "oidc")[],
  displayName: "Primary administrator",
  id: "administrator-primary",
  updatedAt: "2026-08-08T13:45:00.000Z",
};
const providers = [
  {
    displayName: "Jellyfin",
    id: "jellyfin",
    kind: "jellyfin",
    pairingRequiredAfterOidc: true,
    passwordLoginAvailable: true,
    quickConnectAvailable: true,
    state: "available",
  },
  {
    displayName: "Home identity",
    id: "home-identity",
    issuer: "https://identity.example.test/application/o/omnifin/",
    jitProvisioningEnabled: false,
    kind: "oidc",
    state: "available",
    supportsBackChannelLogout: true,
    supportsFrontChannelLogout: true,
    supportsRpInitiatedLogout: true,
  },
] satisfies readonly AuthProvider[];
const baseArgs = {
  csrfToken: "administrator_recovery_csrf_0123456789abcdefghij",
  initialPreview: preview,
  initialProviders: providers,
} as const;

const meta = {
  component: AdministratorRecoveryCeremony,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Authentication/Sole administrator recovery",
} satisfies Meta<typeof AdministratorRecoveryCeremony>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Preview: Story = { args: baseArgs };
export const Confirmation: Story = {
  args: { ...baseArgs, initialStep: "confirmation" },
};
export const PasswordProof: Story = {
  args: {
    ...baseArgs,
    initialConfirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
    initialStep: "proof",
  },
};
export const QuickConnectPending: Story = {
  args: {
    ...baseArgs,
    autoPollQuickConnect: false,
    initialConfirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
    initialMethod: "quick-connect",
    initialQuickConnectTransaction: {
      code: "AB-1234",
      expiresAt: "2026-08-08T14:05:00.000Z",
      pollAfterMs: 2_000,
      transactionId: "storybook-replacement-quick-connect",
    },
    initialStep: "proof",
  },
};
export const ExistingAccountOidc: Story = {
  args: {
    ...baseArgs,
    initialConfirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
    initialMethod: "oidc",
    initialStep: "proof",
  },
};
export const DeniedProof: Story = {
  args: { ...baseArgs, initialState: "denied" },
};
export const RateLimited: Story = {
  args: { ...baseArgs, initialState: "rate_limited" },
};
export const StaleTarget: Story = {
  args: { csrfToken: baseArgs.csrfToken, initialState: "stale_target" },
};
export const TargetUnavailable: Story = {
  args: { csrfToken: baseArgs.csrfToken, initialState: "target_unavailable" },
};
export const SessionUnconfirmed: Story = {
  args: { initialState: "session_unconfirmed" },
};
export const Success: Story = {
  args: { initialState: "success", onAuthenticated: () => undefined },
};
export const TenFoot: Story = {
  args: { ...baseArgs, displayProfile: "ten-foot" },
};
