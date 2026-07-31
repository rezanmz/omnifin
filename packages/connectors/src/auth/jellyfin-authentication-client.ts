import { z } from "zod";

import { SafeHttpClient } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";
import {
  jellyfinAuthorization,
  jellyfinClientMetadata,
  type JellyfinClientMetadata,
} from "./jellyfin-authorization.js";

const jellyfinPublicSystemInfoSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  ServerName: z.string().trim().min(1).max(160),
  Version: z.string().trim().min(1).max(128),
});

const jellyfinUserSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  Name: z.string().trim().min(1).max(160),
  Policy: z.object({
    IsAdministrator: z.boolean(),
  }),
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

export type JellyfinAuthenticationClientMetadata = JellyfinClientMetadata;

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
    this.#metadata = jellyfinClientMetadata(metadata);
    this.#client = new SafeHttpClient({
      allowInsecureHttp: config.insecureHttpApproved ?? false,
      baseUrl: config.baseUrl,
      ...(config.maxResponseBytes === undefined
        ? { maxResponseBytes: 1_048_576 }
        : { maxResponseBytes: config.maxResponseBytes }),
      ...(config.resolveHost === undefined ? {} : { resolveHost: config.resolveHost }),
      service: "jellyfin",
      ...(config.tlsCaCertificatePem === undefined
        ? {}
        : { tlsCaCertificatePem: config.tlsCaCertificatePem }),
      ...(config.tlsPolicy === undefined ? {} : { tlsPolicy: config.tlsPolicy }),
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
          authorization: jellyfinAuthorization({
            deviceId: input.deviceId,
            metadata: this.#metadata,
          }),
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
      headers: {
        authorization: jellyfinAuthorization({
          deviceId: input.deviceId,
          metadata: this.#metadata,
        }),
      },
      operation: "quick_connect_capability",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public initiateQuickConnect(input: {
    deviceId: string;
    signal?: AbortSignal;
  }): Promise<JellyfinQuickConnectResult> {
    return this.#client.requestJson("QuickConnect/Initiate", jellyfinQuickConnectResultSchema, {
      headers: {
        authorization: jellyfinAuthorization({
          deviceId: input.deviceId,
          metadata: this.#metadata,
        }),
      },
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
      headers: {
        authorization: jellyfinAuthorization({
          deviceId: input.deviceId,
          metadata: this.#metadata,
        }),
      },
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
          authorization: jellyfinAuthorization({
            deviceId: input.deviceId,
            metadata: this.#metadata,
          }),
          "content-type": "application/json",
        },
        method: "POST",
        operation: "quick_connect_authentication",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  }
}
