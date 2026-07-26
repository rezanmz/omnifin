import type { ServiceIdentityLink, SessionPrincipal } from "@omnifin/contracts/auth";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AccountSecurityPanel } from "../components/account-security-panel";

const link: ServiceIdentityLink = {
  displayName: "Riley",
  externalUserId: "jellyfin-user-1",
  health: "linked",
  id: "jellyfin-link-1",
  lastVerifiedAt: "2026-07-26T12:00:00.000Z",
  linkedAt: "2026-07-25T12:00:00.000Z",
  service: "jellyfin",
  username: "riley",
};
const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "authentik" },
  displayName: "Riley Morgan",
  externalIdentity: {
    displayClaims: { displayName: "Riley Morgan" },
    issuer: "https://identity.example.test/application/o/omnifin/",
    providerId: "authentik",
    subject: "immutable-subject",
  },
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [link],
  permissions: ["media.view", "playback.use", "identities.self.manage", "sessions.self.revoke"],
  role: "viewer",
  sessionId: "session-1",
  userId: "user-1",
};
const ready = {
  snapshot: {
    csrfToken: "storybook_account_csrf_token_0123456789abcdefghij",
    links: [link],
    principal,
  },
  status: "ready" as const,
};

const meta = {
  args: { initialOutcome: ready },
  component: AccountSecurityPanel,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Account security",
} satisfies Meta<typeof AccountSecurityPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
export const ProviderLogoutConfirmation: Story = {
  args: { initialConfirmation: "provider" },
};
export const LogoutEverywhereConfirmation: Story = {
  args: { initialConfirmation: "logout" },
};
export const LinkRequired: Story = {
  args: {
    initialOutcome: {
      snapshot: {
        ...ready.snapshot,
        links: [],
        principal: {
          ...principal,
          accountState: "pending_link",
          linkedServices: [],
          permissions: ["identities.self.manage", "sessions.self.revoke"],
        },
      },
      status: "ready",
    },
  },
};
export const JellyfinUnavailable: Story = {
  args: {
    initialOutcome: {
      snapshot: {
        ...ready.snapshot,
        links: [{ ...link, health: "unavailable" }],
      },
      status: "ready",
    },
  },
};
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const GatewayUnavailable: Story = {
  args: { initialOutcome: { status: "unavailable" } },
};
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
