import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { SafeConnectorError, SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";
import { jellyfinAuthorization } from "./jellyfin-authorization.js";

export type JellyfinProvisioningProtocolVersion = "10.10" | "10.11";

export interface JellyfinProvisioningValidation {
  protocolVersion: JellyfinProvisioningProtocolVersion;
}

export type JellyfinProvisioningCredentialKind = "access_token" | "api_key";

export class JellyfinProvisioningUnsupportedVersionError extends Error {
  public constructor() {
    super("The Jellyfin server protocol version is not supported.");
    this.name = "JellyfinProvisioningUnsupportedVersionError";
  }
}

export class JellyfinProvisioningServerIdentityError extends Error {
  public constructor() {
    super("The Jellyfin server identity does not match the configured connector.");
    this.name = "JellyfinProvisioningServerIdentityError";
  }
}

const authenticationPolicySchema = z
  .record(z.string().min(1).max(128), z.unknown())
  .superRefine((policy, context) => {
    if (typeof policy.IsAdministrator !== "boolean") {
      context.addIssue({
        code: "custom",
        path: ["IsAdministrator"],
        message: "Missing administrator flag.",
      });
    }
    if (typeof policy.IsDisabled !== "boolean") {
      context.addIssue({ code: "custom", path: ["IsDisabled"], message: "Missing disabled flag." });
    }
  });

const accessScheduleSchema = z.strictObject({
  DayOfWeek: z.enum([
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Everyday",
    "Weekday",
    "Weekend",
  ]),
  EndHour: z.number().finite(),
  Id: z.int(),
  StartHour: z.number().finite(),
  UserId: z.uuid(),
});

const unratedItemSchema = z.enum([
  "Book",
  "ChannelContent",
  "LiveTvChannel",
  "LiveTvProgram",
  "Movie",
  "Music",
  "Other",
  "Series",
  "Trailer",
]);

const userPolicyShape = {
  AccessSchedules: z.array(accessScheduleSchema),
  AuthenticationProviderId: z.string().trim().min(1),
  AllowedTags: z.array(z.string()),
  BlockedChannels: z.array(z.string()),
  BlockedMediaFolders: z.array(z.string()),
  BlockedTags: z.array(z.string()),
  EnableAllChannels: z.boolean(),
  EnableAllDevices: z.boolean(),
  EnableAllFolders: z.boolean(),
  EnableAudioPlaybackTranscoding: z.boolean(),
  EnableCollectionManagement: z.boolean(),
  EnableContentDeletion: z.boolean(),
  EnableContentDeletionFromFolders: z.array(z.string()),
  EnableContentDownloading: z.boolean(),
  EnableLiveTvManagement: z.boolean(),
  EnableLiveTvAccess: z.boolean(),
  EnableMediaConversion: z.boolean(),
  EnableMediaPlayback: z.boolean(),
  EnableLyricManagement: z.boolean(),
  EnablePlaybackRemuxing: z.boolean(),
  EnablePublicSharing: z.boolean(),
  EnableRemoteAccess: z.boolean(),
  EnableRemoteControlOfOtherUsers: z.boolean(),
  EnableSharedDeviceControl: z.boolean(),
  EnableSyncTranscoding: z.boolean(),
  EnableSubtitleManagement: z.boolean(),
  EnableUserPreferenceAccess: z.boolean(),
  EnableVideoPlaybackTranscoding: z.boolean(),
  EnabledChannels: z.array(z.string()),
  EnabledDevices: z.array(z.string()),
  EnabledFolders: z.array(z.string()),
  ForceRemoteSourceTranscoding: z.boolean(),
  BlockUnratedItems: z.array(unratedItemSchema),
  InvalidLoginAttemptCount: z.int(),
  IsAdministrator: z.boolean(),
  IsDisabled: z.boolean(),
  IsHidden: z.boolean(),
  LoginAttemptsBeforeLockout: z.int(),
  MaxActiveSessions: z.int(),
  MaxParentalRating: z.int().nullable().default(null),
  PasswordResetProviderId: z.string().trim().min(1),
  RemoteClientBitrateLimit: z.int(),
  SyncPlayAccess: z.enum(["CreateAndJoinGroups", "JoinGroups", "None"]),
};

const policySchemaForVersion = (protocolVersion: JellyfinProvisioningProtocolVersion) =>
  z.strictObject({
    ...userPolicyShape,
    ...(protocolVersion === "10.11"
      ? { MaxParentalSubRating: z.int().nullable().default(null) }
      : {}),
  });

const userSchemaForVersion = (protocolVersion: JellyfinProvisioningProtocolVersion) =>
  z.object({
    Id: z.string().trim().min(1).max(256),
    Name: z.string().trim().min(1).max(160),
    Policy: policySchemaForVersion(protocolVersion),
  });

const authenticationUserSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  Name: z.string().trim().min(1).max(160),
  Policy: authenticationPolicySchema,
});

const authenticationSchema = z.object({
  AccessToken: z.string().min(1).max(4_096),
  User: authenticationUserSchema,
});

const publicSystemInfoSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  Version: z.string().trim().min(1).max(128),
});
const authenticationInfoSchema = z.object({
  AccessToken: z.string().min(1).max(4_096),
  IsActive: z.boolean().optional(),
});
const authKeysResponseSchema = z.strictObject({
  Items: z.array(authenticationInfoSchema).max(1_000),
  StartIndex: z.int().nonnegative().max(1_000_000).optional(),
  TotalRecordCount: z.int().nonnegative().max(1_000_000).optional(),
});

const createdUserSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  Name: z.string().trim().min(1).max(160),
});

const createUserRequestSchema = z.strictObject({
  password: z.string().min(1).max(4_096),
  username: z.string().trim().min(1).max(160),
});
export type JellyfinProvisioningCreatedUser = z.infer<typeof createdUserSchema>;
export type JellyfinProvisioningAdminUser = z.infer<typeof authenticationUserSchema>;
export type JellyfinProvisioningAuthentication = z.infer<typeof authenticationSchema>;

export interface JellyfinProvisioningServerInfo {
  readonly protocolVersion: JellyfinProvisioningProtocolVersion;
  readonly serverId: string;
}

function protocolVersionFor(version: string): JellyfinProvisioningProtocolVersion {
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version);
  if (!match) throw new JellyfinProvisioningUnsupportedVersionError();
  if (match[1] === "10" && match[2] === "10") return "10.10";
  if (match[1] === "10" && match[2] === "11") return "10.11";
  throw new JellyfinProvisioningUnsupportedVersionError();
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export class JellyfinProvisioningAdminClient {
  readonly #client: SafeHttpClient;

  public constructor(config: ConnectorTargetConfig) {
    this.#client = new SafeHttpClient({
      allowInsecureHttp: config.insecureHttpApproved ?? false,
      baseUrl: config.baseUrl,
      maxResponseBytes: config.maxResponseBytes ?? 2 * 1_048_576,
      ...(config.resolveHost === undefined ? {} : { resolveHost: config.resolveHost }),
      service: "jellyfin",
      ...(config.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: config.tlsCaCertificatePem }),
      ...(config.tlsPolicy === undefined ? {} : { tlsPolicy: config.tlsPolicy }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.transport === undefined ? {} : { transport: config.transport }),
      ...(config.lane === undefined ? {} : { lane: config.lane }),
    });
  }

  public async readPublicSystemInfo(
    input: { signal?: AbortSignal } = {},
  ): Promise<JellyfinProvisioningServerInfo> {
    const systemInfo = await this.#client.requestJson(
      "System/Info/Public",
      publicSystemInfoSchema,
      {
        operation: "provisioning_server_version",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    return { protocolVersion: protocolVersionFor(systemInfo.Version), serverId: systemInfo.Id };
  }

  public authenticateAdministrator(input: {
    deviceId: string;
    password: string;
    username: string;
    signal?: AbortSignal;
  }): Promise<JellyfinProvisioningAuthentication> {
    return this.#client.requestJson("Users/AuthenticateByName", authenticationSchema, {
      body: JSON.stringify({ Pw: input.password, Username: input.username }),
      headers: {
        "content-type": "application/json",
        authorization: jellyfinAuthorization({ deviceId: input.deviceId }),
      },
      method: "POST",
      operation: "provisioning_admin_password_authentication",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public createUser(input: {
    accessToken: string;
    deviceId: string;
    password: string;
    signal?: AbortSignal;
    username: string;
  }): Promise<JellyfinProvisioningCreatedUser> {
    const request = createUserRequestSchema.parse({
      password: input.password,
      username: input.username,
    });
    return this.#client.requestJson("Users/New", createdUserSchema, {
      body: JSON.stringify({ Name: request.username, Password: request.password }),
      headers: {
        "content-type": "application/json",
        authorization: jellyfinAuthorization({
          accessToken: input.accessToken,
          deviceId: input.deviceId,
        }),
      },
      method: "POST",
      operation: "provisioning_user_create",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public async replaceUserPolicy(input: {
    accessToken: string;
    deviceId: string;
    policy: Record<string, unknown>;
    protocolVersion: JellyfinProvisioningProtocolVersion;
    signal?: AbortSignal;
    userId: string;
  }): Promise<void> {
    const policy = policySchemaForVersion(input.protocolVersion).parse(input.policy);
    await this.#client.requestBytes(`Users/${encodeURIComponent(input.userId)}/Policy`, {
      body: JSON.stringify(policy),
      headers: {
        "content-type": "application/json",
        authorization: jellyfinAuthorization({
          accessToken: input.accessToken,
          deviceId: input.deviceId,
        }),
      },
      method: "POST",
      operation: "provisioning_user_policy_replace",
      requiredStatus: 204,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public validateAdministratorApiKey(input: {
    accessToken: string;
    deviceId: string;
    signal?: AbortSignal;
  }): Promise<JellyfinProvisioningValidation> {
    return this.validateAdministratorCredential({ ...input, credentialKind: "api_key" });
  }

  public validateAdministratorCredential(input: {
    accessToken: string;
    credentialKind: JellyfinProvisioningCredentialKind;
    deviceId: string;
    signal?: AbortSignal;
    verifyServerIdentity?: (serverId: string) => boolean;
  }): Promise<JellyfinProvisioningValidation> {
    return this.#validateAdministratorCredential(input);
  }

  public readTemplateUser(input: {
    accessToken: string;
    deviceId: string;
    protocolVersion: JellyfinProvisioningProtocolVersion;
    signal?: AbortSignal;
    userId: string;
  }): Promise<JellyfinProvisioningAdminUser> {
    return this.#readUser(`Users/${encodeURIComponent(input.userId)}`, input);
  }

  public listTemplateUsers(input: {
    accessToken: string;
    deviceId: string;
    protocolVersion: JellyfinProvisioningProtocolVersion;
    signal?: AbortSignal;
  }): Promise<readonly JellyfinProvisioningAdminUser[]> {
    return this.#client.requestJson(
      "Users",
      z.array(userSchemaForVersion(input.protocolVersion)).max(1_000),
      {
        headers: {
          authorization: jellyfinAuthorization({
            accessToken: input.accessToken,
            deviceId: input.deviceId,
          }),
        },
        operation: "provisioning_template_list",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  }

  #readUser(
    path: string,
    input: {
      accessToken: string;
      deviceId: string;
      protocolVersion: JellyfinProvisioningProtocolVersion;
      signal?: AbortSignal;
    },
  ): Promise<JellyfinProvisioningAdminUser> {
    return this.#client.requestJson(path, userSchemaForVersion(input.protocolVersion), {
      headers: {
        authorization: jellyfinAuthorization({
          accessToken: input.accessToken,
          deviceId: input.deviceId,
        }),
      },
      operation: "provisioning_template_user_read",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async #validateAdministratorCredential(input: {
    accessToken: string;
    credentialKind: JellyfinProvisioningCredentialKind;
    deviceId: string;
    signal?: AbortSignal;
    verifyServerIdentity?: (serverId: string) => boolean;
  }): Promise<JellyfinProvisioningValidation> {
    const authorization = jellyfinAuthorization({
      accessToken: input.accessToken,
      deviceId: input.deviceId,
    });
    const systemInfo = await this.readPublicSystemInfo(input);
    if (input.verifyServerIdentity && !input.verifyServerIdentity(systemInfo.serverId)) {
      throw new JellyfinProvisioningServerIdentityError();
    }
    const protocolVersion = systemInfo.protocolVersion;
    const authKeys = await this.#client.requestJson("Auth/Keys", authKeysResponseSchema, {
      headers: {
        authorization,
      },
      method: "GET",
      operation: "provisioning_admin_auth_keys_validation",
      requiredStatus: 200,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (
      input.credentialKind === "api_key" &&
      !authKeys.Items.some((authenticationInfo) =>
        tokensEqual(authenticationInfo.AccessToken, input.accessToken),
      )
    ) {
      throw new SafeConnectorError({
        service: "jellyfin",
        operation: "provisioning_admin_auth_keys_validation",
        code: "invalid_credentials",
        message: "Jellyfin rejected the configured API key.",
        retryable: false,
      });
    }
    return { protocolVersion };
  }
}
