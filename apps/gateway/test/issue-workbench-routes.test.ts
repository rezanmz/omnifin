import {
  SeerrIssueError,
  type SeerrIssueRecord,
} from "@omnifin/connectors/issues/seerr-issue-client";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import {
  mediaIssueWorkbenchItemSchema,
  mediaIssueWorkbenchPageSchema,
} from "@omnifin/contracts/issues";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, SESSION_CSRF_HEADER } from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import {
  connectorConfigs,
  mediaIssues,
  mediaReferences,
  serviceIdentityLinks,
  users,
} from "../src/db/schema.js";
import {
  IssueWorkbenchService,
  IssueWorkbenchServiceError,
  type IssueWorkbenchConnector,
  type IssueWorkbenchServiceErrorReason,
} from "../src/media/issue-workbench-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseUrl = "https://omnifin.example";
const now = new Date("2026-07-28T17:15:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL(baseUrl),
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

function sessionDependencies() {
  let identifier = 0;
  let token = 0;
  return {
    clock: () => now,
    createId: () => `issue-route-session-${++identifier}`,
    createToken: () => Buffer.alloc(32, ++token).toString("base64url"),
  };
}

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

async function harness(
  options: {
    listIssues?: IssueWorkbenchConnector["listIssues"];
    role?: "operator" | "viewer";
    updateIssueStatus?: IssueWorkbenchConnector["updateIssueStatus"];
  } = {},
) {
  const config = testConfig();
  const listIssues =
    options.listIssues ??
    vi.fn<IssueWorkbenchConnector["listIssues"]>(async () => ({
      items: [upstreamIssue],
      truncated: false,
    }));
  const updateIssueStatus =
    options.updateIssueStatus ??
    vi.fn<IssueWorkbenchConnector["updateIssueStatus"]>(async (_id, input) => ({
      ...upstreamIssue,
      status: input.status,
      updatedAt: now.toISOString(),
    }));
  let token = 0;
  const app = await createApp({
    config,
    issueWorkbenchDependencies: {
      clock: () => now,
      createClient: () => ({ listIssues, updateIssueStatus }),
      createToken: () => Buffer.alloc(16, ++token).toString("base64url"),
    },
    sessionDependencies: sessionDependencies(),
  });
  app.database.db
    .insert(connectorConfigs)
    .values([
      {
        baseUrl: "https://jellyfin.example.test/",
        capabilitySnapshotJson: JSON.stringify({ schemaVersion: 1 }),
        createdAt: now,
        displayName: "Jellyfin",
        enabled: true,
        encryptedCredentials: "v2.fixture-jellyfin-credentials",
        healthState: "healthy",
        id: "jellyfin-main",
        type: "jellyfin",
        updatedAt: now,
      },
      {
        baseUrl: "https://seerr.example.test/",
        capabilitySnapshotJson: JSON.stringify({
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
        createdAt: now,
        displayName: "Seerr",
        enabled: true,
        encryptedCredentials: new EnvelopeCipher(config.encryptionKey).encrypt(
          JSON.stringify({
            credentials: { apiKey: "route-private-api-key", kind: "api_key" },
            schemaVersion: 1,
          }),
          "connector_credentials:seerr:seerr-main",
        ),
        healthState: "healthy",
        id: "seerr-main",
        type: "seerr",
        updatedAt: now,
      },
    ])
    .run();
  app.database.db
    .insert(users)
    .values({
      createdAt: now,
      displayName: "Stack operator",
      id: "operator-user",
      role: options.role ?? "operator",
      roleSource: "manual",
      status: "active",
      updatedAt: now,
    })
    .run();
  app.database.db
    .insert(serviceIdentityLinks)
    .values({
      connectorId: "jellyfin-main",
      createdAt: now,
      deviceId: "operator-device",
      encryptedAccessToken: "v2.fixture-access-token",
      externalDisplayName: "Stack operator",
      externalServerId: "jellyfin-server",
      externalUserId: "jellyfin-user-1",
      externalUsername: "operator",
      healthState: "linked",
      id: "operator-link",
      lastVerifiedAt: now,
      service: "jellyfin",
      tokenCreatedAt: now,
      updatedAt: now,
      userId: "operator-user",
    })
    .run();
  const session = app.sessionService.createSession({
    attribution: {
      authMethod: "jellyfin",
      serviceIdentityLinkId: "operator-link",
      userId: "operator-user",
    },
  });
  const cookie = `${SESSION_COOKIE_NAME}=${session.sessionToken}`;
  const mutationHeaders = {
    [SESSION_CSRF_HEADER]: session.csrfToken,
    cookie,
    "idempotency-key": "route-issue-key-0001",
    origin: baseUrl,
  };
  return { app, config, cookie, listIssues, mutationHeaders, updateIssueStatus };
}

function seedLocalIssue(app: Awaited<ReturnType<typeof createApp>>, config: AppConfig) {
  const referenceId = `media_${"m".repeat(22)}`;
  const issueId = `issue_${"l".repeat(22)}`;
  const cipher = new EnvelopeCipher(config.encryptionKey);
  app.database.db
    .insert(mediaReferences)
    .values({
      createdAt: now,
      encryptedPayload: cipher.encrypt(
        JSON.stringify({
          artwork: { backdropItemId: null, posterItemId: null },
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
      expiresAt: new Date(now.getTime() + 86_400_000),
      id: referenceId,
      itemDigest: "d".repeat(22),
      lastUsedAt: now,
      linkRevision: 0,
      serviceIdentityLinkId: "operator-link",
      updatedAt: now,
      userId: "operator-user",
    })
    .run();
  app.database.db
    .insert(mediaIssues)
    .values({
      category: "buffering",
      createdAt: now,
      encryptedDescription: cipher.encrypt(
        "Playback stops after the second scene.",
        `media_issue_description:${issueId}`,
      ),
      id: issueId,
      mediaReferenceId: referenceId,
      playbackSessionId: `playback_${"p".repeat(22)}`,
      positionSeconds: 615,
      serviceIdentityLinkId: "operator-link",
      state: "open",
      updatedAt: now,
      userId: "operator-user",
    })
    .run();
  return issueId;
}

describe("issue workbench routes", () => {
  it("returns normalized Seerr issues behind stable opaque references", async () => {
    const { app, cookie, listIssues } = await harness();
    try {
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues?limit=10&source=seerr&status=open",
      });

      expect(response.statusCode, response.body).toBe(200);
      const page = mediaIssueWorkbenchPageSchema.parse(response.json());
      expect(page).toMatchObject({
        items: [expect.objectContaining({ source: "seerr", title: "Northern Lights" })],
        sourceStates: { omnifin: "available", seerr: "available" },
      });
      expect(page.items[0]?.id).toMatch(/^issue_[A-Za-z0-9_-]{22}$/u);
      expect(page.items[0]?.id).not.toContain(String(upstreamIssue.upstreamId));
      expect(page.items[0]).not.toHaveProperty("upstreamId");
      expect(response.body).not.toContain("route-private-api-key");
      expect(listIssues).toHaveBeenCalledWith(
        { limit: 10, status: "open" },
        expect.any(AbortSignal),
      );
      expect(response.headers["cache-control"]).toBe("no-store");

      const repeated = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues?limit=10&source=seerr&status=open",
      });
      expect(mediaIssueWorkbenchPageSchema.parse(repeated.json()).items[0]?.id).toBe(
        page.items[0]?.id,
      );
    } finally {
      await app.close();
    }
  });

  it("resolves the opaque Seerr reference once and durably replays the decision", async () => {
    const { app, cookie, mutationHeaders, updateIssueStatus } = await harness();
    try {
      const listed = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues?source=seerr",
      });
      const issueId = mediaIssueWorkbenchPageSchema.parse(listed.json()).items[0]!.id;
      const first = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { status: "resolved" },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers["idempotency-replayed"]).toBe("false");
      expect(mediaIssueWorkbenchItemSchema.parse(first.json()).status).toBe("resolved");

      const replay = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { status: "resolved" },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(updateIssueStatus).toHaveBeenCalledTimes(1);
      expect(updateIssueStatus).toHaveBeenCalledWith(
        73,
        { status: "resolved" },
        expect.any(AbortSignal),
      );

      const conflict = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { status: "open" },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(conflict.statusCode).toBe(409);
      expect(apiErrorSchema.parse(conflict.json()).error.code).toBe("idempotency_key_conflict");
      expect(updateIssueStatus).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("lists and resolves locally captured playback issues", async () => {
    const { app, config, cookie, mutationHeaders } = await harness();
    const issueId = seedLocalIssue(app, config);
    try {
      const listed = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues?source=omnifin",
      });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(mediaIssueWorkbenchPageSchema.parse(listed.json()).items[0]).toMatchObject({
        id: issueId,
        source: "omnifin",
        summary: "Playback stops after the second scene.",
        title: "The Long Meridian",
      });

      const resolved = await app.inject({
        headers: { ...mutationHeaders, "idempotency-key": "route-local-issue-key" },
        method: "POST",
        payload: { status: "resolved" },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(resolved.statusCode, resolved.body).toBe(200);
      expect(mediaIssueWorkbenchItemSchema.parse(resolved.json()).status).toBe("resolved");
      expect(
        app.database.sqlite
          .prepare("select state, resolved_by_user_id as resolvedBy from media_issues where id = ?")
          .get(issueId),
      ).toEqual({ resolvedBy: "operator-user", state: "resolved" });
    } finally {
      await app.close();
    }
  });

  it("preserves local results when Seerr is temporarily unavailable", async () => {
    const listIssues = vi.fn<IssueWorkbenchConnector["listIssues"]>(async () => {
      throw new Error("private upstream timeout detail");
    });
    const { app, config, cookie } = await harness({ listIssues });
    seedLocalIssue(app, config);
    try {
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues?source=all",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(mediaIssueWorkbenchPageSchema.parse(response.json())).toMatchObject({
        items: [expect.objectContaining({ source: "omnifin", title: "The Long Meridian" })],
        sourceStates: { omnifin: "available", seerr: "unavailable" },
      });
      expect(response.body).not.toContain("private upstream timeout detail");
    } finally {
      await app.close();
    }
  });

  it("fails closed when an opaque Seerr reference is tampered", async () => {
    const { app, cookie, mutationHeaders, updateIssueStatus } = await harness();
    try {
      const listed = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues?source=seerr",
      });
      const issueId = mediaIssueWorkbenchPageSchema.parse(listed.json()).items[0]!.id;
      app.database.sqlite
        .prepare("update external_issue_references set encrypted_upstream_id = ? where id = ?")
        .run("v2.tampered-reference", issueId);

      const response = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { status: "resolved" },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(response.statusCode).toBe(503);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "media_issue_configuration_unavailable",
      );
      expect(updateIssueStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects missing CSRF, extra mutation fields, and viewer access before Seerr", async () => {
    const operator = await harness();
    try {
      const listed = await operator.app.inject({
        headers: { cookie: operator.cookie },
        method: "GET",
        url: "/v1/issues?source=seerr",
      });
      const issueId = mediaIssueWorkbenchPageSchema.parse(listed.json()).items[0]!.id;
      const withoutCsrf = Object.fromEntries(
        Object.entries(operator.mutationHeaders).filter(([name]) => name !== SESSION_CSRF_HEADER),
      );
      const denied = await operator.app.inject({
        headers: withoutCsrf,
        method: "POST",
        payload: { status: "resolved" },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("csrf_denied");

      const invalid = await operator.app.inject({
        headers: operator.mutationHeaders,
        method: "POST",
        payload: { status: "resolved", upstreamId: 73 },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(invalid.statusCode).toBe(400);
      expect(operator.updateIssueStatus).not.toHaveBeenCalled();
    } finally {
      await operator.app.close();
    }

    const viewer = await harness({ role: "viewer" });
    try {
      const denied = await viewer.app.inject({
        headers: { cookie: viewer.cookie },
        method: "GET",
        url: "/v1/issues",
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("permission_denied");
      expect(viewer.listIssues).not.toHaveBeenCalled();
    } finally {
      await viewer.app.close();
    }
  });

  it("fails closed when a stale Seerr conflict cannot be exactly reconciled", async () => {
    const privateMessage = "private stale issue detail";
    const updateIssueStatus = vi.fn<IssueWorkbenchConnector["updateIssueStatus"]>(async () => {
      const error = new SeerrIssueError("issue_conflict");
      Object.defineProperty(error, "privateMessage", { value: privateMessage });
      throw error;
    });
    const { app, cookie, mutationHeaders } = await harness({ updateIssueStatus });
    try {
      const listed = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues?source=seerr",
      });
      const issueId = mediaIssueWorkbenchPageSchema.parse(listed.json()).items[0]!.id;
      const response = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { status: "resolved" },
        url: `/v1/issues/${issueId}/status`,
      });
      expect(response.statusCode).toBe(409);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        "media_issue_outcome_uncertain",
      );
      expect(response.headers["operation-id"]).toBeTruthy();
      expect(response.body).not.toContain(privateMessage);
    } finally {
      await app.close();
    }
  });

  it.each<{
    code: string;
    reason: IssueWorkbenchServiceErrorReason;
    retryAfter?: string;
    status: number;
  }>([
    { code: "media_issue_not_found", reason: "issue_not_found", status: 404 },
    { code: "media_issue_conflict", reason: "issue_conflict", status: 409 },
    { code: "idempotency_key_conflict", reason: "idempotency_conflict", status: 409 },
    {
      code: "media_issue_outcome_pending",
      reason: "idempotency_in_progress",
      retryAfter: "2",
      status: 409,
    },
    { code: "media_issue_outcome_uncertain", reason: "media_issue_outcome_uncertain", status: 409 },
    {
      code: "media_issue_reconcile_required",
      reason: "media_issue_reconcile_required",
      status: 409,
    },
    { code: "media_issue_response_invalid", reason: "response_invalid", status: 502 },
    { code: "media_issue_principal_unavailable", reason: "principal_unavailable", status: 403 },
    {
      code: "media_issue_configuration_unavailable",
      reason: "configuration_unavailable",
      status: 503,
    },
    { code: "media_issue_configuration_unavailable", reason: "integrity_failure", status: 503 },
    { code: "media_issue_configuration_unavailable", reason: "storage_failure", status: 503 },
    { code: "media_issue_temporarily_unavailable", reason: "temporarily_unavailable", status: 503 },
  ])("maps issue operation failure $reason", async ({ code, reason, retryAfter, status }) => {
    const { app, mutationHeaders } = await harness();
    const update = vi
      .spyOn(IssueWorkbenchService.prototype, "updateStatus")
      .mockRejectedValue(
        new IssueWorkbenchServiceError(reason, { operationId: "issue-operation" }),
      );
    try {
      const response = await app.inject({
        headers: mutationHeaders,
        method: "POST",
        payload: { status: "resolved" },
        url: `/v1/issues/issue_${"i".repeat(22)}/status`,
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(code);
      expect(response.headers["operation-id"]).toBe("issue-operation");
      expect(response.headers["retry-after"]).toBe(retryAfter);
    } finally {
      update.mockRestore();
      await app.close();
    }
  });

  it("maps issue-list failures without an operation identifier", async () => {
    const { app, cookie } = await harness();
    const list = vi
      .spyOn(IssueWorkbenchService.prototype, "list")
      .mockRejectedValue(new IssueWorkbenchServiceError("temporarily_unavailable"));
    try {
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/issues",
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["operation-id"]).toBeUndefined();
    } finally {
      list.mockRestore();
      await app.close();
    }
  });
});
