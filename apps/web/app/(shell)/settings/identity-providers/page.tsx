import {
  RECOVERY_PERMISSIONS,
  ROLE_PERMISSIONS,
  type OidcProviderAdmin,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { Metadata } from "next";

import { IdentityProviderConsoleLoader } from "../../../../components/identity-provider-console-loader";
import { IdentityProviderPageShell } from "../../../../components/identity-provider-page-shell";
import type { IdentityProviderAdminLoadOutcome } from "../../../../lib/identity-provider-admin";
import "../../../control-room.css";

export const metadata: Metadata = { title: "Identity providers" };
export const dynamic = "force-dynamic";

interface IdentityProvidersPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const testProvider: OidcProviderAdmin = {
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

const testPrincipal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-27T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Recovery administrator",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-26T13:00:00.000Z",
  issuedAt: "2026-07-26T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Recovery administrator",
      externalUserId: "jellyfin-admin-1",
      health: "linked",
      id: "jellyfin-link-admin",
      lastVerifiedAt: "2026-07-26T12:00:00.000Z",
      linkedAt: "2026-07-25T12:00:00.000Z",
      service: "jellyfin",
      username: "recovery-admin",
    },
  ],
  permissions: ROLE_PERMISSIONS.admin,
  role: "admin",
  sessionId: "session-admin-1",
  userId: "user-admin-1",
};

function testOutcome(
  view: string | string[] | undefined,
): IdentityProviderAdminLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (view === "forbidden" || view === "signed_out" || view === "unavailable") {
    return { status: view };
  }
  if (view !== "ready" && view !== "empty" && view !== "recovery") return undefined;
  const recoveryPrincipal: SessionPrincipal = {
    ...testPrincipal,
    accountState: "recovery",
    authenticationMethod: { kind: "recovery" },
    displayName: "Recovery access",
    linkedServices: [],
    permissions: [...RECOVERY_PERMISSIONS],
    userId: null,
  };
  return {
    snapshot: {
      csrfToken: "test_csrf_token_0123456789abcdefghijklmnopqrstuvwxyz",
      principal: view === "recovery" ? recoveryPrincipal : testPrincipal,
      providers:
        view === "empty"
          ? []
          : [{ ...testProvider, enabled: view === "recovery" ? true : testProvider.enabled }],
    },
    status: "ready",
  };
}

export default async function IdentityProvidersPage({
  searchParams,
}: IdentityProvidersPageProperties) {
  const parameters = await searchParams;
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  return (
    <IdentityProviderPageShell displayProfile={displayProfile}>
      <IdentityProviderConsoleLoader
        embedded
        initialMappings={
          process.env.OMNIFIN_TEST_MODE === "true"
            ? {
                "oidc-authentik": [
                  {
                    claimPath: ["groups"],
                    enabled: true,
                    id: "mapping-operators",
                    operator: "contains_any",
                    priority: 500,
                    providerId: "oidc-authentik",
                    role: "operator",
                    values: ["media-operators"],
                  },
                ],
              }
            : undefined
        }
        initialOutcome={testOutcome(parameters["test-view"])}
        publicBaseUrl={process.env.OMNIFIN_BASE_URL ?? "http://localhost:3000"}
      />
    </IdentityProviderPageShell>
  );
}
