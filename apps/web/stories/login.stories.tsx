import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { AuthProvider } from "@omnifin/contracts/auth";
import { LoginScreen } from "../components/login-screen";

const oidcProvider = {
  displayName: "Authentik",
  id: "authentik",
  issuer: "https://identity.example.test/application/o/omnifin/",
  jitProvisioningEnabled: true,
  kind: "oidc" as const,
  state: "available" as const,
  supportsBackChannelLogout: true,
  supportsFrontChannelLogout: true,
  supportsRpInitiatedLogout: true,
} satisfies AuthProvider;
const jellyfinProvider = {
  displayName: "Jellyfin",
  id: "jellyfin",
  kind: "jellyfin" as const,
  pairingRequiredAfterOidc: true as const,
  passwordLoginAvailable: true,
  quickConnectAvailable: true,
  state: "available" as const,
} satisfies AuthProvider;
const configuredProviders = [oidcProvider, jellyfinProvider] satisfies readonly AuthProvider[];
const maximumDisplayName = `Identity ${"A".repeat(151)}`;
const manyProviders = Array.from({ length: 50 }, (_, index) => ({
  ...oidcProvider,
  displayName: index === 0 ? maximumDisplayName : `Identity provider ${index + 1}`,
  id: `identity-${index + 1}`,
  state: index === 24 ? ("misconfigured" as const) : ("available" as const),
})) satisfies readonly AuthProvider[];

const meta = {
  component: LoginScreen,
  parameters: { layout: "fullscreen" },
  title: "Screens/Login",
} satisfies Meta<typeof LoginScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = { args: { providers: configuredProviders } };
export const ProviderUnavailable: Story = {
  args: {
    providers: [
      oidcProvider,
      {
        ...oidcProvider,
        displayName: "Backup identity",
        id: "backup",
        state: "unavailable",
      },
    ],
  },
};
export const ProviderMisconfigured: Story = {
  args: {
    providers: [
      oidcProvider,
      {
        ...oidcProvider,
        displayName: "Provider requiring repair",
        id: "repair-required",
        state: "misconfigured",
      },
    ],
  },
};
export const MaximumDisplayName: Story = {
  args: {
    providers: [{ ...oidcProvider, displayName: maximumDisplayName, id: "maximum-name" }],
  },
};
export const ManyProviders: Story = { args: { providers: manyProviders } };
export const AuthenticationError: Story = {
  args: { authError: "invalid_request", providers: configuredProviders },
};
export const SessionLimitReached: Story = {
  args: { authError: "session_limit_reached", providers: configuredProviders },
};
export const Unconfigured: Story = { args: { providers: [] } };
export const ControlPlaneUnavailable: Story = {
  args: { providerLoadState: "unavailable", providers: [] },
};
export const TenFoot: Story = {
  args: { displayProfile: "ten-foot", providers: configuredProviders },
};
