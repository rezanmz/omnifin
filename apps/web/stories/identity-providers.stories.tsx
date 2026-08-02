import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  type OidcProviderAdmin,
  type RoleMapping,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { IdentityProviderConsole } from "../components/identity-provider-console";
import type { IdentityProviderAdminLoadOutcome } from "../lib/identity-provider-admin";

const provider: OidcProviderAdmin = {
  allowJitProvisioning: true,
  approvedEndpointOrigins: ["https://identity.example.test"],
  clientId: "omnifin-web",
  clientSecretConfigured: true,
  createdAt: "2026-07-25T12:00:00.000Z",
  discoveryCheckedAt: "2026-07-26T12:00:00.000Z",
  discoveryState: "ready",
  displayName: "Authentik",
  enabled: false,
  id: "oidc-authentik",
  idTokenSigningAlg: "RS256",
  issuer: "https://identity.example.test/application/o/omnifin/",
  scopes: ["openid", "profile", "email", "groups"],
  slug: "authentik",
  tokenEndpointAuthMethod: "client_secret_basic",
  updatedAt: "2026-07-26T12:00:00.000Z",
};
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administration",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administration",
      externalUserId: "jellyfin-admin-1",
      health: "linked",
      id: "jellyfin-link-admin",
      lastVerifiedAt: "2026-07-26T12:00:00.000Z",
      linkedAt: "2026-07-25T12:00:00.000Z",
      service: "jellyfin",
      username: "admin",
    },
  ],
  permissions: ROLE_PERMISSIONS.admin,
  role: "admin",
  sessionId: "session-admin-1",
  userId: "user-admin-1",
};
const mapping: RoleMapping = {
  claimPath: ["groups"],
  enabled: true,
  id: "mapping-operators",
  operator: "contains_any",
  priority: 500,
  providerId: provider.id,
  role: "operator",
  values: ["media-operators"],
};
const ready: IdentityProviderAdminLoadOutcome = {
  snapshot: {
    csrfToken: "storybook_identity_provider_csrf_0123456789abcdef",
    principal,
    providers: [provider],
  },
  status: "ready",
};
const empty: IdentityProviderAdminLoadOutcome = {
  snapshot: { ...ready.snapshot, providers: [] },
  status: "ready",
};

const meta = {
  args: {
    initialMappings: { [provider.id]: [mapping] },
    initialOutcome: ready,
    publicBaseUrl: "https://omnifin.example.test",
  },
  component: IdentityProviderConsole,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Identity providers",
} satisfies Meta<typeof IdentityProviderConsole>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const EditingRoleMapping: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Edit groups mapping" }));
    await expect(canvas.getByRole("heading", { name: "Edit role mapping" })).toBeVisible();
    await expect(canvas.getByText(/Manual roles remain unchanged/u)).toBeVisible();
  },
};
export const EditingRoleMappingLight: Story = {
  globals: { theme: "light" },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Edit groups mapping" }));
    await expect(canvas.getByRole("heading", { name: "Edit role mapping" })).toBeVisible();
    await expect(canvas.getByText(/Manual roles remain unchanged/u)).toBeVisible();
  },
};
export const GuidedAuthentikConnection: Story = {
  args: { initialMappings: {}, initialOutcome: empty },
};
export const RecoveryAdministratorClaim: Story = {
  args: {
    initialMappings: { [provider.id]: [] },
    initialOutcome: {
      snapshot: {
        ...ready.snapshot,
        principal: {
          ...principal,
          accountState: "recovery",
          authenticationMethod: { kind: "recovery" },
          displayName: "Recovery access",
          linkedServices: [],
          permissions: [...RECOVERY_PERMISSIONS],
          userId: null,
        },
        providers: [{ ...provider, enabled: true }],
      },
      status: "ready",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Continue with OIDC" })).toBeEnabled();
    await expect(canvas.getByText(/Media and playback stay locked/u)).toBeVisible();
  },
};
export const DiscoveryAttention: Story = {
  args: {
    initialOutcome: {
      snapshot: {
        ...ready.snapshot,
        providers: [
          {
            ...provider,
            discoveryCheckedAt: "2026-07-26T11:45:00.000Z",
            discoveryState: "failed",
          },
        ],
      },
      status: "ready",
    },
  },
};
export const Restricted: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const GatewayUnavailable: Story = {
  args: { initialOutcome: { status: "unavailable" } },
};
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
