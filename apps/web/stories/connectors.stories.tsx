import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { ConnectorAdmin } from "@omnifin/contracts/connectors";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { ConnectorControlRoom } from "../components/connector-control-room";
import type { ConnectorAdminLoadOutcome } from "../lib/connector-admin";

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
const jellyfin: ConnectorAdmin = {
  baseUrl: "https://jellyfin.example.test",
  createdAt: "2026-07-25T12:00:00.000Z",
  credentialKind: "none",
  credentialsConfigured: true,
  displayName: "Living Room Jellyfin",
  enabled: true,
  healthState: "healthy",
  id: "jellyfin-primary",
  insecureHttpApproved: false,
  lastProbe: {
    capabilities: [
      "connector.health",
      "connector.version",
      "identity.authenticate",
      "identity.quick_connect",
      "media.library.read",
      "media.playback",
      "media.watch_state",
    ],
    checkedAt: "2026-07-26T12:00:00.000Z",
    connectorId: "jellyfin-primary",
    displayName: "Living Room Jellyfin",
    failure: null,
    latencyMs: 18,
    service: "jellyfin",
    status: "healthy",
    version: "10.10.7",
  },
  revision: "revision_0123456789abcdef",
  service: "jellyfin",
  tlsCaCertificateConfigured: false,
  tlsPolicy: "strict",
  updatedAt: "2026-07-26T12:00:00.000Z",
};
const radarr: ConnectorAdmin = {
  ...jellyfin,
  baseUrl: "https://radarr.example.test",
  credentialKind: "api_key",
  displayName: "Radarr",
  enabled: false,
  healthState: "degraded",
  id: "radarr-primary",
  lastProbe: {
    capabilities: ["connector.health", "connector.version", "acquisition.search"],
    checkedAt: "2026-07-26T11:52:00.000Z",
    connectorId: "radarr-primary",
    displayName: "Radarr",
    failure: {
      code: "timeout",
      message: "Radarr did not answer before the connector deadline.",
      occurredAt: "2026-07-26T11:52:00.000Z",
      operation: "connector.probe",
      retryable: true,
      service: "radarr",
    },
    latencyMs: 5000,
    service: "radarr",
    status: "degraded",
    version: "5.27.5",
  },
  revision: "revision_1234567890abcdef",
  service: "radarr",
};
const ready: ConnectorAdminLoadOutcome = {
  snapshot: {
    connectors: [jellyfin, radarr],
    csrfToken: "storybook_connector_csrf_0123456789abcdefghij",
    principal,
    recoveryOnly: false,
  },
  status: "ready",
};

const meta = {
  args: { initialOutcome: ready },
  component: ConnectorControlRoom,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Service connections",
} satisfies Meta<typeof ConnectorControlRoom>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Empty: Story = {
  args: { initialOutcome: { snapshot: { ...ready.snapshot, connectors: [] }, status: "ready" } },
};
export const Degraded: Story = {
  args: {
    initialOutcome: {
      snapshot: { ...ready.snapshot, connectors: [radarr, jellyfin] },
      status: "ready",
    },
  },
};
export const RecoveryBoundary: Story = {
  args: {
    initialOutcome: {
      snapshot: {
        ...ready.snapshot,
        connectors: [{ ...jellyfin, enabled: false }],
        principal: {
          ...principal,
          accountState: "recovery",
          authenticationMethod: { kind: "recovery" },
          linkedServices: [],
          permissions: [
            "recovery.oidc.manage",
            "recovery.jellyfin.manage",
            "recovery.sessions.revoke",
          ],
          userId: null,
        },
        recoveryOnly: true,
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
