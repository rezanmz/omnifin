import type { SeerrIssueRecord } from "@omnifin/connectors/issues/seerr-issue-client";
import { ROLE_PERMISSIONS, sessionPrincipalSchema } from "@omnifin/contracts/auth";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import {
  IssueWorkbenchService,
  type IssueWorkbenchConnector,
} from "../src/media/issue-workbench-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const now = new Date("2026-07-28T17:15:00.000Z");
const upstreamIssue: SeerrIssueRecord = {
  category: "subtitles",
  createdAt: "2026-07-28T16:30:00.000Z",
  episodeNumber: 3,
  kind: "episode",
  positionSeconds: null,
  reportedBy: "Mara Chen",
  seasonNumber: 2,
  status: "open",
  summary: "Captions drift after the opening scene.",
  title: "Northern Lights",
  updatedAt: "2026-07-28T16:35:00.000Z",
  upstreamId: 73,
  year: 2026,
};

function config(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 86),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

const principal = sessionPrincipalSchema.parse({
  absoluteExpiresAt: "2026-08-27T17:15:00.000Z",
  accountState: "active",
  authenticationMethod: { kind: "oidc", providerId: "oidc-home" },
  displayName: "Stack operator",
  externalIdentity: {
    displayClaims: { displayName: "Stack operator" },
    issuer: "https://identity.example.test/application/o/omnifin/",
    providerId: "oidc-home",
    subject: "operator-subject",
  },
  inactivityExpiresAt: "2026-07-28T18:15:00.000Z",
  issuedAt: now.toISOString(),
  linkedServices: [
    {
      displayName: "Home Jellyfin",
      externalUserId: "jellyfin-user-1",
      health: "linked",
      id: "operator-link",
      lastVerifiedAt: now.toISOString(),
      linkedAt: now.toISOString(),
      service: "jellyfin",
      username: "operator",
    },
  ],
  permissions: ROLE_PERMISSIONS.operator,
  role: "operator",
  sessionId: "operator-session",
  userId: "operator-user",
});

function harness(connector: IssueWorkbenchConnector) {
  const appConfig = config();
  const database = openDatabase(":memory:");
  database.migrate();
  database.sqlite
    .prepare(
      `insert into users (
         id, display_name, status, role, role_source, created_at, updated_at
       ) values ('operator-user', 'Stack operator', 'active', 'operator', 'manual', ?, ?)`,
    )
    .run(now.getTime(), now.getTime());
  const encryptedCredentials = new EnvelopeCipher(appConfig.encryptionKey).encrypt(
    JSON.stringify({
      credentials: { apiKey: "private-api-key", kind: "api_key" },
      schemaVersion: 1,
    }),
    "connector_credentials:seerr:seerr-main",
  );
  database.sqlite
    .prepare(
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials,
         capability_snapshot_json, health_state, enabled, created_at, updated_at
       ) values ('seerr-main', 'seerr', 'Seerr', 'https://seerr.example.test/', ?,
                 ?, 'healthy', 1, ?, ?)`,
    )
    .run(
      encryptedCredentials,
      JSON.stringify({
        health: {
          capabilities: ["connector.health", "connector.version", "issue.read", "issue.manage"],
          checkedAt: now.toISOString(),
          connectorId: "seerr-main",
          displayName: "Seerr",
          failure: null,
          latencyMs: 12,
          service: "seerr",
          status: "healthy",
          version: "2.7.3",
        },
        schemaVersion: 1,
      }),
      now.getTime(),
      now.getTime(),
    );
  database.sqlite
    .prepare(
      `insert into connector_configs (
         id, type, display_name, base_url, encrypted_credentials,
         capability_snapshot_json, health_state, enabled, created_at, updated_at
       ) values ('jellyfin-main', 'jellyfin', 'Jellyfin', 'https://jellyfin.example.test/',
                 'fixture', '{}', 'healthy', 1, ?, ?)`,
    )
    .run(now.getTime(), now.getTime());
  database.sqlite
    .prepare(
      `insert into service_identity_links (
         id, user_id, service, connector_id, external_server_id, external_user_id,
         external_username, external_display_name, encrypted_access_token, device_id,
         token_created_at, health_state, created_at, updated_at
       ) values ('fixture-link', 'operator-user', 'jellyfin', 'jellyfin-main',
                 'server-1', 'jellyfin-user-1', 'operator', 'Stack operator',
                 'fixture-token', 'fixture-device', ?, 'linked', ?, ?)`,
    )
    .run(now.getTime(), now.getTime(), now.getTime());
  let token = 0;
  const service = new IssueWorkbenchService(database, appConfig, {
    clock: () => now,
    createClient: () => connector,
    createToken: () => Buffer.alloc(16, ++token).toString("base64url"),
  });
  return { appConfig, database, service };
}

const context = { principal, requestId: "issue-request-1" };

describe("issue workbench external mutation safety", () => {
  it("reconciles a lost Seerr response with an exact read and replays success", async () => {
    const listIssues = vi.fn<IssueWorkbenchConnector["listIssues"]>(async () => ({
      items: [upstreamIssue],
      truncated: false,
    }));
    const readIssue = vi
      .fn<NonNullable<IssueWorkbenchConnector["readIssue"]>>()
      .mockResolvedValueOnce(upstreamIssue)
      .mockResolvedValueOnce({ ...upstreamIssue, status: "resolved" });
    const updateIssueStatus = vi.fn<IssueWorkbenchConnector["updateIssueStatus"]>(async () => {
      throw new Error("response lost after commit");
    });
    const { database, service } = harness({ listIssues, readIssue, updateIssueStatus });
    try {
      const page = await service.list({ limit: 20, source: "seerr", status: "open" }, context);
      const issueId = page.items[0]!.id;
      const first = await service.updateStatus(
        issueId,
        { status: "resolved" },
        "issue-key-lost-response",
        context,
      );
      const replay = await service.updateStatus(
        issueId,
        { status: "resolved" },
        "issue-key-lost-response",
        context,
      );

      expect(first).toMatchObject({ issue: { status: "resolved" }, replayed: false });
      expect(replay).toEqual({ issue: first.issue, replayed: true });
      expect(updateIssueStatus).toHaveBeenCalledOnce();
      expect(readIssue).toHaveBeenCalledTimes(2);
      expect(
        database.sqlite.prepare("select state from external_mutation_dispatches").get(),
      ).toEqual({ state: "succeeded" });
    } finally {
      database.close();
    }
  });

  it("fails closed on a nonmatching issue readback without a second setter call", async () => {
    const listIssues = vi.fn<IssueWorkbenchConnector["listIssues"]>(async () => ({
      items: [upstreamIssue],
      truncated: false,
    }));
    const readIssue = vi.fn<NonNullable<IssueWorkbenchConnector["readIssue"]>>(
      async () => upstreamIssue,
    );
    const updateIssueStatus = vi.fn<IssueWorkbenchConnector["updateIssueStatus"]>(async () => {
      throw new Error("response lost while another operator changed the issue");
    });
    const { database, service } = harness({ listIssues, readIssue, updateIssueStatus });
    try {
      const issueId = (await service.list({ limit: 20, source: "seerr", status: "open" }, context))
        .items[0]!.id;
      const update = () =>
        service.updateStatus(
          issueId,
          { status: "resolved" },
          "issue-key-intervening-change",
          context,
        );

      await expect(update()).rejects.toMatchObject({ reason: "media_issue_reconcile_required" });
      await expect(update()).rejects.toMatchObject({ reason: "media_issue_reconcile_required" });

      expect(updateIssueStatus).toHaveBeenCalledOnce();
      expect(readIssue).toHaveBeenCalledTimes(3);
      expect(
        database.sqlite.prepare("select state from external_mutation_dispatches").get(),
      ).toEqual({ state: "reconcile_required" });
    } finally {
      database.close();
    }
  });

  it("keeps Omnifin-only status changes out of the external dispatch journal", async () => {
    const connector: IssueWorkbenchConnector = {
      listIssues: vi.fn(async () => ({ items: [], truncated: false })),
      updateIssueStatus: vi.fn(async () => upstreamIssue),
    };
    const { appConfig, database, service } = harness(connector);
    const referenceId = `media_${"m".repeat(22)}`;
    const issueId = `issue_${"l".repeat(22)}`;
    try {
      const cipher = new EnvelopeCipher(appConfig.encryptionKey);
      database.sqlite
        .prepare(
          `insert into media_references (
             id, user_id, service_identity_link_id, link_revision, item_digest,
             encrypted_payload, last_used_at, expires_at, created_at, updated_at
           ) values (?, 'operator-user', 'fixture-link', 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          referenceId,
          "d".repeat(22),
          cipher.encrypt(
            JSON.stringify({
              artwork: {},
              episodeNumber: null,
              itemId: "jellyfin-movie-1",
              kind: "movie",
              schemaVersion: 2,
              seasonNumber: null,
              title: "The Long Meridian",
              year: 2026,
            }),
            `media_reference:jellyfin:${referenceId}`,
          ),
          now.getTime(),
          now.getTime() + 86_400_000,
          now.getTime(),
          now.getTime(),
        );
      database.sqlite
        .prepare(
          `insert into media_issues (
             id, user_id, service_identity_link_id, media_reference_id,
             playback_session_id, category, position_seconds, state, created_at, updated_at
           ) values (?, 'operator-user', 'fixture-link', ?, ?, 'buffering',
                     42, 'open', ?, ?)`,
        )
        .run(issueId, referenceId, `playback_${"p".repeat(22)}`, now.getTime(), now.getTime());

      await expect(
        service.updateStatus(issueId, { status: "resolved" }, "issue-key-local-only", context),
      ).resolves.toMatchObject({ issue: { source: "omnifin", status: "resolved" } });
      expect(
        database.sqlite.prepare("select count(*) as count from external_mutation_dispatches").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
