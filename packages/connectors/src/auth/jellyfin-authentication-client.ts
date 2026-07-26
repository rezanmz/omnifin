import { z } from "zod";

import { SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_VALUE_PATTERN = /^[A-Za-z0-9 ._-]{1,80}$/;

const jellyfinPublicSystemInfoSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  ServerName: z.string().trim().min(1).max(160),
  Version: z.string().trim().min(1).max(128),
});

const jellyfinUserSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  Name: z.string().trim().min(1).max(160),
});

const jellyfinAuthenticationResultSchema = z.object({
  AccessToken: z.string().min(1).max(4_096),
  ServerId: z.string().trim().min(1).max(256),
  User: jellyfinUserSchema,
});

const jellyfinQuickConnectResultSchema = z.object({
  Authenticated: z.boolean(),
  Secret: z.string().min(1).max(256),
  Code: z.string().trim().min(1).max(32),
  DateAdded: z.iso.datetime({ offset: true }),
});

export type JellyfinPublicSystemInfo = z.infer<typeof jellyfinPublicSystemInfoSchema>;
export type JellyfinAuthenticationResult = z.infer<typeof jellyfinAuthenticationResultSchema>;
export type JellyfinQuickConnectResult = z.infer<typeof jellyfinQuickConnectResultSchema>;

export interface JellyfinAuthenticationClientMetadata {
  appName?: string;
  appVersion?: string;
  deviceName?: string;
}

function boundedProtocolValue(value: string, name: string) {
  if (!CLIENT_VALUE_PATTERN.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function deviceAuthorization(
  deviceId: string,
  metadata: Required<JellyfinAuthenticationClientMetadata>,
) {
  if (!DEVICE_ID_PATTERN.test(deviceId))
    throw new TypeError("Jellyfin device identifier is invalid.");
  return [
    `MediaBrowser Client="${metadata.appName}"`,
    `Device="${metadata.deviceName}"`,
    `DeviceId="${deviceId}"`,
    `Version="${metadata.appVersion}"`,
  ].join(", ");
}

function jsonBody(value: Readonly<Record<string, string>>) {
  return JSON.stringify(value);
}

export class JellyfinAuthenticationClient {
  readonly #client: SafeHttpClient;
  readonly #metadata: Required<JellyfinAuthenticationClientMetadata>;

  public constructor(
    config: ConnectorTargetConfig,
    metadata: JellyfinAuthenticationClientMetadata = {},
  ) {
    this.#metadata = Object.freeze({
      appName: boundedProtocolValue(metadata.appName ?? "Omnifin", "Jellyfin client name"),
      appVersion: boundedProtocolValue(metadata.appVersion ?? "0.0.0", "Jellyfin client version"),
      deviceName: boundedProtocolValue(
        metadata.deviceName ?? "Omnifin Gateway",
        "Jellyfin device name",
      ),
    });
    this.#client = new SafeHttpClient({
      allowInsecureHttp: config.insecureHttpApproved ?? false,
      baseUrl: config.baseUrl,
      ...(config.maxResponseBytes === undefined
        ? { maxResponseBytes: 1_048_576 }
        : { maxResponseBytes: config.maxResponseBytes }),
      ...(config.resolveHost === undefined ? {} : { resolveHost: config.resolveHost }),
      service: "jellyfin",
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.transport === undefined ? {} : { transport: config.transport }),
    });
  }

  public getPublicSystemInfo(signal?: AbortSignal): Promise<JellyfinPublicSystemInfo> {
    return this.#client.requestJson("System/Info/Public", jellyfinPublicSystemInfoSchema, {
      operation: "public_system_info",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public authenticateByName(input: {
    deviceId: string;
    password: string;
    signal?: AbortSignal;
    username: string;
  }): Promise<JellyfinAuthenticationResult> {
    return this.#client.requestJson(
      "Users/AuthenticateByName",
      jellyfinAuthenticationResultSchema,
      {
        body: jsonBody({ Pw: input.password, Username: input.username }),
        headers: {
          authorization: deviceAuthorization(input.deviceId, this.#metadata),
          "content-type": "application/json",
        },
        method: "POST",
        operation: "password_authentication",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  }

  public quickConnectEnabled(input: { deviceId: string; signal?: AbortSignal }): Promise<boolean> {
    return this.#client.requestJson("QuickConnect/Enabled", z.boolean(), {
      headers: { authorization: deviceAuthorization(input.deviceId, this.#metadata) },
      operation: "quick_connect_capability",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public initiateQuickConnect(input: {
    deviceId: string;
    signal?: AbortSignal;
  }): Promise<JellyfinQuickConnectResult> {
    return this.#client.requestJson("QuickConnect/Initiate", jellyfinQuickConnectResultSchema, {
      headers: { authorization: deviceAuthorization(input.deviceId, this.#metadata) },
      method: "POST",
      operation: "quick_connect_initiate",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public pollQuickConnect(input: {
    deviceId: string;
    secret: string;
    signal?: AbortSignal;
  }): Promise<JellyfinQuickConnectResult> {
    return this.#client.requestJson("QuickConnect/Connect", jellyfinQuickConnectResultSchema, {
      headers: { authorization: deviceAuthorization(input.deviceId, this.#metadata) },
      operation: "quick_connect_poll",
      query: { secret: input.secret },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public authenticateWithQuickConnect(input: {
    deviceId: string;
    secret: string;
    signal?: AbortSignal;
  }): Promise<JellyfinAuthenticationResult> {
    return this.#client.requestJson(
      "Users/AuthenticateWithQuickConnect",
      jellyfinAuthenticationResultSchema,
      {
        body: jsonBody({ Secret: input.secret }),
        headers: {
          authorization: deviceAuthorization(input.deviceId, this.#metadata),
          "content-type": "application/json",
        },
        method: "POST",
        operation: "quick_connect_authentication",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  }
}
