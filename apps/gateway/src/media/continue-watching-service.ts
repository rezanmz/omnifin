import {
  JellyfinUserMediaClient,
  type JellyfinContinueWatchingResult,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  continueWatchingResponseSchema,
  type ContinueWatchingResponse,
} from "@omnifin/contracts/dashboard";
import { connectorCredentialInputSchema, type PartialFailure } from "@omnifin/contracts/connectors";
import { createHash, X509Certificate } from "node:crypto";
import { ZodError } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher } from "../security/crypto.js";
import {
  MediaReferenceError,
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "./media-reference-service.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface ContinueWatchingSourceRow {
  baseUrl: string;
  connectorDisplayName: string;
  connectorEnabled: number;
  connectorId: string;
  connectorType: string;
  deviceId: string;
  encryptedAccessToken: string;
  encryptedCredentials: string;
  insecureHttpApproved: number;
  linkHealthState: string;
  linkId: string;
  linkRevision: number;
  linkService: string;
  linkUserId: string;
  tlsPolicy: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

export interface ContinueWatchingContext {
  principal: SessionPrincipal;
}

export interface ContinueWatchingClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

export interface ContinueWatchingDependencies {
  clock?: () => Date;
  createClient?: (
    input: ContinueWatchingClientFactoryInput,
  ) => Pick<JellyfinUserMediaClient, "readContinueWatching" | "readImage">;
  mediaReferences?: MediaReferenceDependencies;
}

export class ContinueWatchingError extends Error {
  public readonly code = "continue_watching_unavailable";

  public constructor(options?: ErrorOptions) {
    super("Continue Watching is temporarily unavailable.", options);
    this.name = "ContinueWatchingError";
  }
}

export type MediaArtworkErrorReason = "not_found" | "unavailable";

export class MediaArtworkError extends Error {
  public readonly code = "media_artwork_unavailable";
  public readonly reason: MediaArtworkErrorReason;

  public constructor(reason: MediaArtworkErrorReason, options?: ErrorOptions) {
    super(
      reason === "not_found"
        ? "The requested media artwork is not available."
        : "Media artwork is temporarily unavailable.",
      options,
    );
    this.name = "MediaArtworkError";
    this.reason = reason;
  }
}

class ContinueWatchingConfigurationError extends Error {}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function accessToken(row: ContinueWatchingSourceRow, cipher: EnvelopeCipher) {
  try {
    return cipher.decrypt(row.encryptedAccessToken, accessTokenContext(row.linkId));
  } catch (error) {
    throw new ContinueWatchingConfigurationError("invalid", { cause: error });
  }
}

function safeDisplayName(value: string) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || "Jellyfin").slice(0, 160);
}

function connectorSecrets(row: ContinueWatchingSourceRow, cipher: EnvelopeCipher) {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, credentialsContext(row.connectorId)),
    ) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("invalid");
    }
    const record = decoded as Record<string, unknown>;
    const versioned = record.schemaVersion === 1;
    if (
      versioned &&
      Object.keys(record).some(
        (key) => !["credentials", "schemaVersion", "tlsCaCertificatePem"].includes(key),
      )
    ) {
      throw new Error("invalid");
    }
    const stored = versioned
      ? (record as unknown as StoredConnectorSecrets)
      : ({ credentials: decoded, schemaVersion: 1 } satisfies StoredConnectorSecrets);
    const credentials = connectorCredentialInputSchema.parse(stored.credentials);
    if (credentials.kind !== "none") throw new Error("invalid");
    const tlsCaCertificatePem = stored.tlsCaCertificatePem;
    if (tlsCaCertificatePem !== undefined) {
      if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
        throw new Error("invalid");
      }
      const certificate = new X509Certificate(tlsCaCertificatePem);
      if (!certificate.ca) throw new Error("invalid");
    }
    return typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {};
  } catch (error) {
    throw new ContinueWatchingConfigurationError("invalid", { cause: error });
  }
}

function defaultClient(input: ContinueWatchingClientFactoryInput) {
  const { accessToken, deviceId, ...target } = input;
  return new JellyfinUserMediaClient({ accessToken, deviceId, target });
}

function safeFailure(error: unknown, occurredAt: Date): PartialFailure {
  if (error instanceof SafeConnectorError && error.service === "jellyfin") {
    return error.toPartialFailure(occurredAt);
  }
  if (error instanceof ContinueWatchingConfigurationError) {
    return {
      code: "configuration_invalid",
      message: "The Jellyfin media connection could not be used.",
      occurredAt: occurredAt.toISOString(),
      operation: "media.continue_watching",
      retryable: false,
      service: "jellyfin",
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "response_invalid",
      message: "Jellyfin returned media data that could not be safely interpreted.",
      occurredAt: occurredAt.toISOString(),
      operation: "media.continue_watching",
      retryable: false,
      service: "jellyfin",
    };
  }
  return {
    code: "upstream_error",
    message:
      error instanceof MediaReferenceError
        ? "Continue Watching references are temporarily unavailable."
        : "Jellyfin Continue Watching is temporarily unavailable.",
    occurredAt: occurredAt.toISOString(),
    operation: error instanceof MediaReferenceError ? "media.reference" : "media.continue_watching",
    retryable: true,
    service: "jellyfin",
  };
}

function unavailableResponse(
  row: ContinueWatchingSourceRow,
  failure: PartialFailure,
  occurredAt: Date,
) {
  return continueWatchingResponseSchema.parse({
    failures: [failure],
    generatedAt: occurredAt.toISOString(),
    items: [],
    source: {
      connectorId: row.connectorId,
      displayName: safeDisplayName(row.connectorDisplayName),
      failure,
      status: "unavailable",
    },
    state: "unavailable",
    truncated: false,
  });
}

export class ContinueWatchingService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createClient: NonNullable<ContinueWatchingDependencies["createClient"]>;
  readonly #database: DatabaseHandle;
  readonly #references: MediaReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: ContinueWatchingDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#references = new MediaReferenceService(database, config, dependencies.mediaReferences);
  }

  public async read(
    context: ContinueWatchingContext,
    signal?: AbortSignal,
  ): Promise<ContinueWatchingResponse> {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    const occurredAt = this.#clock();
    try {
      const client = this.#client(row);
      const result = await client.readContinueWatching(signal);
      return this.#response(row, result, occurredAt);
    } catch (error) {
      return unavailableResponse(row, safeFailure(error, occurredAt), occurredAt);
    }
  }

  public async readArtwork(
    context: ContinueWatchingContext,
    referenceId: string,
    kind: "backdrop" | "poster",
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    const row = this.#source(principal);
    let reference;
    try {
      reference = this.#references.resolve(
        { linkId: row.linkId, linkRevision: row.linkRevision, userId: row.linkUserId },
        referenceId,
      );
    } catch (error) {
      throw new MediaArtworkError("not_found", { cause: error });
    }
    const itemId =
      kind === "poster" ? reference.artwork.posterItemId : reference.artwork.backdropItemId;
    if (itemId === null) throw new MediaArtworkError("not_found");

    try {
      const image = await this.#client(row, 8 * 1_024 * 1_024).readImage({
        itemId,
        maxWidth: kind === "poster" ? 720 : 1_920,
        ...(signal === undefined ? {} : { signal }),
        type: kind === "poster" ? "Primary" : "Backdrop",
      });
      const digest = createHash("sha256").update(image.body).digest("base64url").slice(0, 22);
      return Object.freeze({
        body: image.body,
        contentType: image.contentType,
        etag: `"artwork_${digest}"`,
      });
    } catch (error) {
      throw new MediaArtworkError("unavailable", { cause: error });
    }
  }

  #client(row: ContinueWatchingSourceRow, maxResponseBytes?: number) {
    const secrets = connectorSecrets(row, this.#cipher);
    const token = accessToken(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (!tlsPolicy) throw new ContinueWatchingConfigurationError();
    try {
      return this.#createClient({
        accessToken: token,
        baseUrl: row.baseUrl,
        connectorId: row.connectorId,
        deviceId: row.deviceId,
        displayName: safeDisplayName(row.connectorDisplayName),
        insecureHttpApproved: row.insecureHttpApproved === 1,
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
        tlsPolicy,
        ...secrets,
      });
    } catch (error) {
      throw new ContinueWatchingConfigurationError("invalid", { cause: error });
    }
  }

  #response(
    row: ContinueWatchingSourceRow,
    result: JellyfinContinueWatchingResult,
    occurredAt: Date,
  ) {
    const referenceIds = this.#references.createOrRefresh(
      { linkId: row.linkId, linkRevision: row.linkRevision, userId: row.linkUserId },
      result.items.map((item) => ({
        artwork: {
          backdropItemId: item.artwork.backdrop?.itemId ?? null,
          posterItemId: item.artwork.poster?.itemId ?? null,
        },
        episodeNumber: item.episodeNumber,
        itemId: item.externalId,
        kind: item.kind,
        seasonNumber: item.seasonNumber,
        title: item.title,
        year: item.year,
      })),
    );
    const items = result.items.map((item, index) => {
      const id = referenceIds[index]!;
      return {
        durationSeconds: item.runtimeSeconds,
        lastPlayedAt: item.lastPlayedAt,
        media: {
          artwork: {
            accentColor: item.artwork.accentColor,
            backdropPath: item.artwork.backdrop === null ? null : `/v1/media/${id}/images/backdrop`,
            blurHash: item.artwork.blurHash,
            posterPath: item.artwork.poster === null ? null : `/v1/media/${id}/images/poster`,
          },
          availability: "available" as const,
          contentRating: item.contentRating,
          id,
          kind: item.kind,
          overview: item.overview,
          runtimeMinutes: Math.max(1, Math.ceil(item.runtimeSeconds / 60)),
          subtitle: item.subtitle,
          title: item.title,
          year: item.year,
        },
        positionSeconds: item.positionSeconds,
        progressPercent: Math.round((item.positionSeconds / item.runtimeSeconds) * 1_000) / 10,
      };
    });
    return continueWatchingResponseSchema.parse({
      failures: [],
      generatedAt: occurredAt.toISOString(),
      items,
      source: {
        connectorId: row.connectorId,
        displayName: safeDisplayName(row.connectorDisplayName),
        failure: null,
        status: "healthy",
      },
      state: items.length === 0 ? "empty" : "complete",
      truncated: result.truncated,
    });
  }

  #source(principal: SessionPrincipal) {
    const userId = principal.userId;
    const linkedService = principal.linkedServices.find(({ service }) => service === "jellyfin");
    if (!userId || !linkedService) throw new ContinueWatchingError();
    const row = this.#database.sqlite
      .prepare(
        `select
          l.id as linkId,
          l.user_id as linkUserId,
          l.service as linkService,
          l.device_id as deviceId,
          l.encrypted_access_token as encryptedAccessToken,
          l.health_state as linkHealthState,
          l.revision as linkRevision,
          c.id as connectorId,
          c.type as connectorType,
          c.display_name as connectorDisplayName,
          c.base_url as baseUrl,
          c.encrypted_credentials as encryptedCredentials,
          c.tls_policy as tlsPolicy,
          c.insecure_http_approved as insecureHttpApproved,
          c.enabled as connectorEnabled
         from service_identity_links l
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.id = ? and l.user_id = ?`,
      )
      .get(linkedService.id, userId) as ContinueWatchingSourceRow | undefined;
    if (
      !row ||
      row.linkUserId !== userId ||
      row.linkId !== linkedService.id ||
      row.linkService !== "jellyfin" ||
      !["linked", "unavailable"].includes(row.linkHealthState) ||
      row.connectorType !== "jellyfin" ||
      row.connectorEnabled !== 1 ||
      !IDENTIFIER_PATTERN.test(row.connectorId) ||
      !IDENTIFIER_PATTERN.test(row.linkId) ||
      !IDENTIFIER_PATTERN.test(row.deviceId) ||
      !Number.isSafeInteger(row.linkRevision) ||
      row.linkRevision < 0 ||
      (row.insecureHttpApproved !== 0 && row.insecureHttpApproved !== 1)
    ) {
      throw new ContinueWatchingError();
    }
    return row;
  }
}
