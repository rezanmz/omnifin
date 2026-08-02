import {
  ROLE_PERMISSIONS,
  type SessionPrincipal,
  type UserAccessSummary,
} from "@omnifin/contracts/auth";
import type { Metadata } from "next";

import { UserAccessControlLoader } from "../../../components/user-access-control-loader";
import { UserAccessPageShell } from "../../../components/user-access-page-shell";
import type { UserAccessAdminLoadOutcome } from "../../../lib/user-access-admin";
import "../../application-shell.css";

export const metadata: Metadata = { title: "User access" };
export const dynamic = "force-dynamic";

interface UserAccessPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

const testPrincipal: SessionPrincipal = {
  absoluteExpiresAt: "2026-07-31T12:00:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "jellyfin" },
  displayName: "Rezan",
  externalIdentity: null,
  inactivityExpiresAt: "2026-07-30T13:00:00.000Z",
  issuedAt: "2026-07-30T12:00:00.000Z",
  linkedServices: [
    {
      displayName: "Rezan",
      externalUserId: "jellyfin-admin",
      health: "linked",
      id: "admin-jellyfin-link",
      lastVerifiedAt: "2026-07-30T11:58:00.000Z",
      linkedAt: "2026-07-20T12:00:00.000Z",
      service: "jellyfin",
      username: "rezan",
    },
  ],
  permissions: [...ROLE_PERMISSIONS.admin],
  role: "admin",
  sessionId: "admin-session",
  userId: "user-rezan",
};

const testUsers: readonly UserAccessSummary[] = [
  {
    activeSessions: 1,
    authenticationMethods: ["jellyfin"],
    createdAt: "2026-07-20T12:00:00.000Z",
    displayName: "Rezan",
    id: "user-rezan",
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
    createdAt: "2026-07-22T15:00:00.000Z",
    displayName: "Sloane Park",
    id: "user-sloane",
    jellyfinLinkHealth: "linked",
    lastActiveAt: "2026-07-30T11:42:00.000Z",
    role: "operator",
    roleSource: "oidc_mapping",
    status: "active",
    updatedAt: "2026-07-30T11:42:00.000Z",
  },
  {
    activeSessions: 1,
    authenticationMethods: ["jellyfin"],
    createdAt: "2026-07-24T09:20:00.000Z",
    displayName: "Morgan Lee",
    id: "user-morgan",
    jellyfinLinkHealth: "linked",
    lastActiveAt: "2026-07-30T09:14:00.000Z",
    role: "requester",
    roleSource: "manual",
    status: "active",
    updatedAt: "2026-07-29T18:10:00.000Z",
  },
  {
    activeSessions: 0,
    authenticationMethods: ["oidc", "jellyfin"],
    createdAt: "2026-07-25T18:00:00.000Z",
    displayName: "Jordan Kim",
    id: "user-jordan",
    jellyfinLinkHealth: "relink_required",
    lastActiveAt: "2026-07-27T21:08:00.000Z",
    role: "viewer",
    roleSource: "oidc_mapping",
    status: "disabled",
    updatedAt: "2026-07-28T16:00:00.000Z",
  },
];

function testOutcome(view: string | string[] | undefined): UserAccessAdminLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (view === "forbidden" || view === "signed_out" || view === "unavailable") {
    return { status: view };
  }
  if (view !== "ready" && view !== "empty") return undefined;
  return {
    snapshot: {
      csrfToken: "test_user_access_csrf_0123456789abcdefghijklmnop",
      principal: testPrincipal,
      users: view === "empty" ? [] : testUsers,
    },
    status: "ready",
  };
}

export default async function UserAccessPage({ searchParams }: UserAccessPageProperties) {
  const parameters = await searchParams;
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  const initialOutcome = testOutcome(parameters["test-view"]);
  return (
    <UserAccessPageShell displayProfile={displayProfile}>
      <UserAccessControlLoader
        embedded
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
      />
    </UserAccessPageShell>
  );
}
