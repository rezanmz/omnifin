import { describe, expect, it } from "vitest";

import {
  JellyfinProvisioningAdminClient,
  type JellyfinProvisioningProtocolVersion,
} from "../src/auth/jellyfin-provisioning-admin-client.js";
import { createMockTransport, jsonResponse, publicResolver } from "./helpers/mock-fetch.js";

const target = (transport: ReturnType<typeof createMockTransport>["transport"]) => ({
  baseUrl: "https://jellyfin.example.test/base/",
  connectorId: "jellyfin-home",
  displayName: "Home Jellyfin",
  resolveHost: publicResolver,
  transport,
});

function policy(
  _version: JellyfinProvisioningProtocolVersion,
  overrides: Record<string, unknown> = {},
) {
  return {
    AccessSchedules: [],
    AuthenticationProviderId: "Jellyfin.Server.Core",
    AllowedTags: [],
    BlockUnratedItems: ["Movie", "Series", "Other"],
    BlockedChannels: [],
    BlockedMediaFolders: [],
    BlockedTags: [],
    EnableAllChannels: true,
    EnableAllDevices: true,
    EnableAllFolders: true,
    EnableAudioPlaybackTranscoding: true,
    EnableCollectionManagement: false,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableContentDownloading: true,
    EnableLiveTvAccess: true,
    EnableLiveTvManagement: false,
    EnableLyricManagement: false,
    EnableMediaConversion: true,
    EnableMediaPlayback: true,
    EnablePlaybackRemuxing: true,
    EnablePublicSharing: true,
    EnableRemoteAccess: true,
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnableSyncTranscoding: true,
    EnableSubtitleManagement: false,
    EnableUserPreferenceAccess: true,
    EnableVideoPlaybackTranscoding: true,
    EnabledChannels: [],
    EnabledDevices: [],
    EnabledFolders: [],
    ForceRemoteSourceTranscoding: false,
    InvalidLoginAttemptCount: 0,
    IsAdministrator: false,
    IsDisabled: false,
    IsHidden: false,
    LoginAttemptsBeforeLockout: -1,
    MaxActiveSessions: 0,
    PasswordResetProviderId: "Jellyfin.Server.Core",
    RemoteClientBitrateLimit: 0,
    SyncPlayAccess: "CreateAndJoinGroups",
    ...overrides,
  };
}

describe("JellyfinProvisioningAdminClient", () => {
  it("validates a 10.10.7 API key by AccessToken despite Jellyfin's inactive flag", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "server-10-10", ServerName: "Home", Version: "10.10.7" }),
      jsonResponse({
        Items: [{ AccessToken: "server-api-key", IsActive: false }],
        StartIndex: 0,
        TotalRecordCount: 1,
      }),
    ]);
    const client = new JellyfinProvisioningAdminClient(target(mock.transport));

    await expect(
      client.validateAdministratorApiKey({ accessToken: "server-api-key", deviceId: "device-1" }),
    ).resolves.toEqual({ protocolVersion: "10.10" });
    expect(mock.requests.map((request) => request.url.pathname)).toEqual([
      "/base/System/Info/Public",
      "/base/Auth/Keys",
    ]);
    expect(mock.requests[1]?.init.headers.get("authorization")).toContain('Token="server-api-key"');
    expect(mock.requests.map((request) => request.url.pathname)).not.toContain("/base/Users/Me");
  });

  it("validates a 10.11.11 administrator access token through Auth/Keys", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "server-10-11", ServerName: "Home", Version: "10.11.11" }),
      jsonResponse({ Items: [], StartIndex: 0, TotalRecordCount: 0 }),
    ]);
    const client = new JellyfinProvisioningAdminClient(target(mock.transport));

    await expect(
      client.validateAdministratorCredential({
        accessToken: "server-api-key",
        deviceId: "device-1",
        credentialKind: "access_token",
      }),
    ).resolves.toEqual({ protocolVersion: "10.11" });
    expect(mock.requests.map((request) => request.url.pathname)).toEqual([
      "/base/System/Info/Public",
      "/base/Auth/Keys",
    ]);
  });

  it("rejects an ordinary user token submitted as an API key", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "server-10-10", ServerName: "Home", Version: "10.10.7" }),
      jsonResponse({ error: "forbidden" }, { status: 403 }),
    ]);
    const client = new JellyfinProvisioningAdminClient(target(mock.transport));

    await expect(
      client.validateAdministratorCredential({
        accessToken: "ordinary-user-token",
        credentialKind: "api_key",
        deviceId: "device-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials", status: 403 });
    expect(mock.requests.map((request) => request.url.pathname)).toEqual([
      "/base/System/Info/Public",
      "/base/Auth/Keys",
    ]);
  });

  it("rejects an administrator access token submitted as an API key", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "server-10-11", ServerName: "Home", Version: "10.11.11" }),
      jsonResponse({
        Items: [{ AccessToken: "server-api-key", IsActive: false }],
        StartIndex: 0,
        TotalRecordCount: 1,
      }),
    ]);
    const client = new JellyfinProvisioningAdminClient(target(mock.transport));

    await expect(
      client.validateAdministratorCredential({
        accessToken: "administrator-access-token",
        credentialKind: "api_key",
        deviceId: "device-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("uses bounded activation routes and exact response schemas", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "server-10-11", Version: "10.11.11" }),
      jsonResponse({ Id: "created-user" }),
      new Response(null, { status: 204 }),
      jsonResponse({
        AccessToken: "created-token",
        ServerId: "server-10-11",
        User: { Id: "created-user" },
      }),
      new Response(null, { status: 204 }),
    ]);
    const client = new JellyfinProvisioningAdminClient(target(mock.transport));
    await expect(client.readServerIdentity()).resolves.toBe("server-10-11");
    await expect(
      client.createUser({
        accessToken: "admin-token",
        deviceId: "device-1",
        password: "secret",
        username: "omnifin-user",
      }),
    ).resolves.toBe("created-user");
    await expect(
      client.applyUserPolicy({
        accessToken: "admin-token",
        deviceId: "device-1",
        policy: { EnableAllFolders: true },
        userId: "created-user",
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.authenticateCreatedUser({
        deviceId: "device-1",
        password: "secret",
        username: "omnifin-user",
      }),
    ).resolves.toEqual({
      accessToken: "created-token",
      serverId: "server-10-11",
      userId: "created-user",
    });
    await expect(
      client.deleteUser({
        accessToken: "admin-token",
        deviceId: "device-1",
        userId: "created-user",
      }),
    ).resolves.toBeUndefined();
    expect(mock.requests.map(({ url, init }) => [url.pathname, init.method])).toEqual([
      ["/base/System/Info/Public", "GET"],
      ["/base/Users/New", "POST"],
      ["/base/Users/created-user/Policy", "POST"],
      ["/base/Users/AuthenticateByName", "POST"],
      ["/base/Users/created-user", "DELETE"],
    ]);
    expect(new TextDecoder().decode(mock.requests[1]!.init.body)).toEqual(
      JSON.stringify({ Name: "omnifin-user", Password: "secret" }),
    );
  });

  it("rejects a malformed API key inventory response", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "server-10-10", ServerName: "Home", Version: "10.10.7" }),
      jsonResponse({ Items: [{ AccessToken: 42 }], StartIndex: 0, TotalRecordCount: 1 }),
    ]);
    const client = new JellyfinProvisioningAdminClient(target(mock.transport));

    await expect(
      client.validateAdministratorApiKey({ accessToken: "server-api-key", deviceId: "device-1" }),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("accepts complete versioned policies and rejects unknown or malformed policy fields", async () => {
    const mock = createMockTransport([
      jsonResponse({
        Id: "template-user",
        Name: "Template user",
        Policy: policy("10.10", {
          AccessSchedules: [
            {
              DayOfWeek: "Weekday",
              EndHour: 22.5,
              Id: 17,
              StartHour: 8,
              UserId: "123e4567-e89b-12d3-a456-426614174000",
            },
          ],
          BlockUnratedItems: ["Movie", "Other"],
        }),
      }),
    ]);
    const client = new JellyfinProvisioningAdminClient(target(mock.transport));

    await expect(
      client.readTemplateUser({
        accessToken: "server-api-key",
        deviceId: "device-1",
        protocolVersion: "10.10",
        userId: "template-user",
      }),
    ).resolves.toMatchObject({ Id: "template-user", Policy: { MaxParentalRating: null } });

    const invalid = createMockTransport([
      jsonResponse({
        Id: "template-user",
        Name: "Template user",
        Policy: policy("10.10", { UnknownPolicyField: true }),
      }),
    ]);
    await expect(
      new JellyfinProvisioningAdminClient(target(invalid.transport)).readTemplateUser({
        accessToken: "server-api-key",
        deviceId: "device-1",
        protocolVersion: "10.10",
        userId: "template-user",
      }),
    ).rejects.toMatchObject({ code: "response_invalid" });

    const malformed = createMockTransport([
      jsonResponse({
        Id: "template-user",
        Name: "Template user",
        Policy: policy("10.10", { AccessSchedules: [{ DayOfWeek: 7, EndHour: 22 }] }),
      }),
    ]);
    await expect(
      new JellyfinProvisioningAdminClient(target(malformed.transport)).readTemplateUser({
        accessToken: "server-api-key",
        deviceId: "device-1",
        protocolVersion: "10.10",
        userId: "template-user",
      }),
    ).rejects.toMatchObject({ code: "response_invalid" });

    for (const overrides of [
      { SyncPlayAccess: "CreateAndJoin" },
      { SyncPlayAccess: "JoinOnly" },
      { BlockUnratedItems: ["Episode"] },
      { AccessSchedules: [{ DayOfWeek: 1, EndHour: 22, StartHour: 8 }] },
    ]) {
      const invalidValues = createMockTransport([
        jsonResponse({
          Id: "template-user",
          Name: "Template user",
          Policy: policy("10.10", overrides),
        }),
      ]);
      await expect(
        new JellyfinProvisioningAdminClient(target(invalidValues.transport)).readTemplateUser({
          accessToken: "server-api-key",
          deviceId: "device-1",
          protocolVersion: "10.10",
          userId: "template-user",
        }),
      ).rejects.toMatchObject({ code: "response_invalid" });
    }

    const versioned = createMockTransport([
      jsonResponse({ Id: "template-user", Name: "Template user", Policy: policy("10.11") }),
    ]);
    await expect(
      new JellyfinProvisioningAdminClient(target(versioned.transport)).readTemplateUser({
        accessToken: "server-api-key",
        deviceId: "device-1",
        protocolVersion: "10.11",
        userId: "template-user",
      }),
    ).resolves.toMatchObject({
      Policy: { MaxParentalRating: null, MaxParentalSubRating: null },
    });

    const explicitNulls = createMockTransport([
      jsonResponse({
        Id: "template-user",
        Name: "Template user",
        Policy: policy("10.11", { MaxParentalRating: null, MaxParentalSubRating: null }),
      }),
    ]);
    await expect(
      new JellyfinProvisioningAdminClient(target(explicitNulls.transport)).readTemplateUser({
        accessToken: "server-api-key",
        deviceId: "device-1",
        protocolVersion: "10.11",
        userId: "template-user",
      }),
    ).resolves.toMatchObject({
      Policy: { MaxParentalRating: null, MaxParentalSubRating: null },
    });

    for (const [version, overrides] of [
      ["10.10", { MaxParentalRating: "PG" }],
      ["10.11", { MaxParentalSubRating: "TV-14" }],
    ] as const) {
      const malformedParentalRating = createMockTransport([
        jsonResponse({
          Id: "template-user",
          Name: "Template user",
          Policy: policy(version, overrides),
        }),
      ]);
      await expect(
        new JellyfinProvisioningAdminClient(
          target(malformedParentalRating.transport),
        ).readTemplateUser({
          accessToken: "server-api-key",
          deviceId: "device-1",
          protocolVersion: version,
          userId: "template-user",
        }),
      ).rejects.toMatchObject({ code: "response_invalid" });
    }

    const unsupportedSubRating = createMockTransport([
      jsonResponse({
        Id: "template-user",
        Name: "Template user",
        Policy: policy("10.10", { MaxParentalSubRating: null }),
      }),
    ]);
    await expect(
      new JellyfinProvisioningAdminClient(target(unsupportedSubRating.transport)).readTemplateUser({
        accessToken: "server-api-key",
        deviceId: "device-1",
        protocolVersion: "10.10",
        userId: "template-user",
      }),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });
});
