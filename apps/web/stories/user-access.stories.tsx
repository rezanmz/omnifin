import {
  ROLE_PERMISSIONS,
  type SessionPrincipal,
  type UserAccessSummary,
} from "@omnifin/contracts/auth";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { UserAccessControl } from "../components/user-access-control";
import type { UserAccessAdminLoadOutcome } from "../lib/user-access-admin";

const principal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-31T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Administration",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-30T13:00:00.000Z",
  issuedAt: "2026-07-30T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Administration",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-link",
      lastVerifiedAt: "2026-07-30T12:00:00.000Z",
      linkedAt: "2026-07-28T12:00:00.000Z",
      service: "jellyfin",
      username: "administrator",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.admin],
  role: "admin",
  sessionId: "admin-session",
  userId: "admin-user",
};
const users: readonly UserAccessSummary[] = [
  {
    activeSessions: 1,
    authenticationMethods: ["jellyfin"],
    createdAt: "2026-07-28T12:00:00.000Z",
    displayName: "Administration",
    id: "admin-user",
    jellyfinLinkHealth: "linked",
    lastActiveAt: "2026-07-30T12:00:00.000Z",
    role: "admin",
    roleSource: "manual",
    status: "active",
    updatedAt: "2026-07-30T12:00:00.000Z",
  },
  {
    activeSessions: 2,
    authenticationMethods: ["oidc", "jellyfin"],
    createdAt: "2026-07-29T12:00:00.000Z",
    displayName: "Sloane Park",
    id: "operator-user",
    jellyfinLinkHealth: "linked",
    lastActiveAt: "2026-07-30T11:30:00.000Z",
    role: "operator",
    roleSource: "oidc_mapping",
    status: "active",
    updatedAt: "2026-07-30T11:30:00.000Z",
  },
  {
    activeSessions: 1,
    authenticationMethods: ["jellyfin"],
    createdAt: "2026-07-29T14:00:00.000Z",
    displayName: "Morgan Lee",
    id: "requester-user",
    jellyfinLinkHealth: "linked",
    lastActiveAt: "2026-07-30T09:15:00.000Z",
    role: "requester",
    roleSource: "manual",
    status: "active",
    updatedAt: "2026-07-30T09:15:00.000Z",
  },
];
const ready: UserAccessAdminLoadOutcome = {
  snapshot: {
    csrfToken: "storybook_user_access_csrf_0123456789abcdefghijk",
    principal,
    users,
  },
  status: "ready",
};

const meta = {
  args: { initialOutcome: ready },
  component: UserAccessControl,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/User access",
} satisfies Meta<typeof UserAccessControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const ProviderManaged: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Sloane Park/i }));
    await expect(canvas.getByText(/role comes from an OIDC claim mapping/i)).toBeVisible();
  },
};
export const ReviewChange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Morgan Lee/i }));
    await userEvent.click(canvas.getByRole("button", { name: /viewer.*Browse and play/i }));
    await expect(canvas.getByRole("region", { name: "Review access change" })).toBeVisible();
  },
};
export const Empty: Story = {
  args: {
    initialOutcome: { snapshot: { ...ready.snapshot, users: [] }, status: "ready" },
  },
};
export const Restricted: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const GatewayUnavailable: Story = {
  args: { initialOutcome: { status: "unavailable" } },
};
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
