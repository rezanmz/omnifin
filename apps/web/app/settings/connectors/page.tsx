import { ROLE_PERMISSIONS, type SessionPrincipal } from "@omnifin/contracts/auth";
import type { ConnectorAdmin } from "@omnifin/contracts/connectors";
import type { Metadata } from "next";

import { ConnectorControlRoomLoader } from "../../../components/connector-control-room-loader";
import { ConnectorPageShell } from "../../../components/connector-page-shell";
import type { ConnectorAdminLoadOutcome } from "../../../lib/connector-admin";
import "../../control-room.css";

export const metadata: Metadata = { title: "Service connections" };
export const dynamic = "force-dynamic";

interface ConnectorsPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const testPrincipal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Stack administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Stack administrator",
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

const testConnector: ConnectorAdmin = {
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

const radarrConnector: ConnectorAdmin = {
  ...testConnector,
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

function testOutcome(view: string | string[] | undefined): ConnectorAdminLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (view === "forbidden" || view === "signed_out" || view === "unavailable") {
    return { status: view };
  }
  if (!["ready", "empty", "degraded", "recovery"].includes(String(view))) return undefined;
  if (view === "recovery") {
    return {
      snapshot: {
        connectors: [{ ...testConnector, enabled: false }],
        csrfToken: "test_connector_csrf_0123456789abcdefghijklmnop",
        principal: {
          ...testPrincipal,
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
    };
  }
  return {
    snapshot: {
      connectors:
        view === "empty"
          ? []
          : view === "degraded"
            ? [radarrConnector, testConnector]
            : [testConnector, radarrConnector],
      csrfToken: "test_connector_csrf_0123456789abcdefghijklmnop",
      principal: testPrincipal,
      recoveryOnly: false,
    },
    status: "ready",
  };
}

export default async function ConnectorsPage({ searchParams }: ConnectorsPageProperties) {
  const parameters = await searchParams;
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  return (
    <ConnectorPageShell displayProfile={displayProfile}>
      <ConnectorControlRoomLoader embedded initialOutcome={testOutcome(parameters["test-view"])} />
    </ConnectorPageShell>
  );
}
