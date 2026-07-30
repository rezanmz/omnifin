import {
  SeerrAdapter,
  type SeerrDiscoveryArtwork,
  type SeerrDiscoveryFeedPage,
} from "@omnifin/connectors/adapters/seerr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { OptionalApiKeyConnectorConfig } from "@omnifin/connectors/types";
import { connectorCredentialInputSchema, type PartialFailure } from "@omnifin/contracts/connectors";
import {
  DISCOVERY_FEED_MAX_ITEMS_PER_RAIL,
  discoveryFeedQuerySchema,
  discoveryFeedResponseSchema,
  discoveryMediaDetailParamsSchema,
  discoveryMediaDetailQuerySchema,
  discoveryMediaDetailResponseSchema,
  discoveryPersonDetailParamsSchema,
  discoveryPersonDetailQuerySchema,
  discoveryPersonDetailResponseSchema,
  discoverySearchQuerySchema,
  discoverySearchResponseSchema,
  type DiscoveryFeedQuery,
  type DiscoveryFeedRailKind,
  type DiscoveryFeedResponse,
  type DiscoveryMediaDetailParams,
  type DiscoveryMediaDetailQuery,
  type DiscoveryMediaDetailResponse,
  type DiscoveryPersonDetailParams,
  type DiscoveryPersonDetailQuery,
  type DiscoveryPersonDetailResponse,
  type DiscoverySearchQuery,
  type DiscoverySearchResponse,
} from "@omnifin/contracts/discovery";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { createHash, X509Certificate } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { requirePermission } from "../auth/authorization.js";
import { EnvelopeCipher } from "../security/crypto.js";
import {
  DiscoveryArtworkReferenceError,
  DiscoveryArtworkReferenceService,
} from "./artwork-reference-service.js";

interface DiscoveryConnectorRow {
  baseUrl: string;
  displayName: string;
  encryptedCredentials: string;
  id: string;
  insecureHttpApproved: number;
  tlsPolicy: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

export interface DiscoverySearchContext {
  principal: SessionPrincipal;
}

export interface DiscoverySearchAdapter {
  discover?(
    kind: DiscoveryFeedRailKind,
    input: DiscoveryFeedQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryFeedPage>;
  detail(
    params: DiscoveryMediaDetailParams,
    query: DiscoveryMediaDetailQuery,
    signal?: AbortSignal,
  ): Promise<DiscoveryMediaDetailResponse>;
  personDetail(
    params: DiscoveryPersonDetailParams,
    query: DiscoveryPersonDetailQuery,
    signal?: AbortSignal,
  ): Promise<DiscoveryPersonDetailResponse>;
  search(input: DiscoverySearchQuery, signal?: AbortSignal): Promise<DiscoverySearchResponse>;
  readDiscoveryArtwork?(
    path: string,
    kind: "backdrop" | "poster",
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryArtwork>;
}

export interface DiscoverySearchDependencies {
  clock?: () => Date;
  createAdapter?: (config: OptionalApiKeyConnectorConfig) => DiscoverySearchAdapter;
}

export type DiscoverySearchErrorReason =
  | "connector_ambiguous"
  | "connector_integrity_failure"
  | "connector_unconfigured"
  | "storage_failure";

export class DiscoverySearchError extends Error {
  public readonly reason: DiscoverySearchErrorReason;

  public constructor(reason: DiscoverySearchErrorReason, options?: ErrorOptions) {
    super("Discovery search could not be completed.", options);
    this.name = "DiscoverySearchError";
    this.reason = reason;
  }
}

export class DiscoveryArtworkError extends Error {
  public readonly reason: "not_found" | "unavailable";

  public constructor(reason: "not_found" | "unavailable", options?: ErrorOptions) {
    super(
      reason === "not_found"
        ? "The requested discovery artwork is not available."
        : "Discovery artwork is temporarily unavailable.",
      options,
    );
    this.name = "DiscoveryArtworkError";
    this.reason = reason;
  }
}

const FEED_KINDS = [
  "trending",
  "popular_movies",
  "popular_series",
  "upcoming",
] as const satisfies readonly DiscoveryFeedRailKind[];

function feedFailure(
  error: unknown,
  kind: DiscoveryFeedRailKind,
  occurredAt: Date,
): PartialFailure {
  if (error instanceof SafeConnectorError) {
    return {
      code: error.code,
      message: "The discovery rail could not be loaded.",
      occurredAt: occurredAt.toISOString(),
      operation: `discovery.feed.${kind}`,
      retryable: error.retryable,
      service: "seerr",
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  return {
    code: "upstream_error",
    message: "The discovery rail could not be loaded.",
    occurredAt: occurredAt.toISOString(),
    operation: `discovery.feed.${kind}`,
    retryable: false,
    service: "seerr",
  };
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function credentialContext(connectorId: string) {
  return `connector_credentials:seerr:${connectorId}`;
}

function connectorSecrets(
  row: DiscoveryConnectorRow,
  cipher: EnvelopeCipher,
): { apiKey: string; tlsCaCertificatePem?: string } {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, credentialContext(row.id)),
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
    if (credentials.kind !== "api_key") throw new Error("invalid");
    const tlsCaCertificatePem = stored.tlsCaCertificatePem;
    if (tlsCaCertificatePem !== undefined) {
      if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
        throw new Error("invalid");
      }
      const certificate = new X509Certificate(tlsCaCertificatePem);
      if (!certificate.ca) throw new Error("invalid");
    }
    return {
      apiKey: credentials.apiKey,
      ...(typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {}),
    };
  } catch (error) {
    throw new DiscoverySearchError("connector_integrity_failure", { cause: error });
  }
}

export class DiscoverySearchService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createAdapter: (config: OptionalApiKeyConnectorConfig) => DiscoverySearchAdapter;
  readonly #database: DatabaseHandle;
  readonly #references: DiscoveryArtworkReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: DiscoverySearchDependencies = {},
  ) {
    this.#database = database;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? ((input) => new SeerrAdapter(input));
    this.#references = new DiscoveryArtworkReferenceService(database, config, this.#clock);
  }

  public async feed(
    input: DiscoveryFeedQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ): Promise<DiscoveryFeedResponse> {
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoverySearchError("connector_integrity_failure");
    const query = discoveryFeedQuerySchema.parse(input);
    const row = this.#connector();
    const adapter = this.#adapterFor(row);
    const discover = adapter.discover?.bind(adapter);
    if (!discover) throw new DiscoverySearchError("connector_integrity_failure");
    const occurredAt = this.#clock();
    const rawRails = await Promise.all(
      FEED_KINDS.map(async (kind) => {
        try {
          return { failure: null, kind, page: await discover(kind, query, signal) } as const;
        } catch (error) {
          if (isAbort(error)) throw error;
          return { failure: feedFailure(error, kind, occurredAt), kind, page: null } as const;
        }
      }),
    );
    const artworkInputs = rawRails.flatMap((rail) =>
      rail.page === null
        ? []
        : rail.page.items
            .slice(0, DISCOVERY_FEED_MAX_ITEMS_PER_RAIL)
            .flatMap(({ artwork }) => [
              ...(artwork.backdropPath === null
                ? []
                : [{ kind: "backdrop" as const, path: artwork.backdropPath }]),
              ...(artwork.posterPath === null
                ? []
                : [{ kind: "poster" as const, path: artwork.posterPath }]),
            ]),
    );
    let artworkReferences: string[];
    try {
      artworkReferences = this.#references.create(principal.userId, row.id, artworkInputs);
    } catch (error) {
      throw new DiscoverySearchError("storage_failure", { cause: error });
    }
    let referenceIndex = 0;
    const artworkPath = (path: string | null) => {
      if (path === null) return null;
      const reference = artworkReferences[referenceIndex++];
      if (!reference) throw new DiscoverySearchError("storage_failure");
      return `/v1/discovery/artwork/${reference}`;
    };
    const rails = rawRails.map((rail) => {
      if (rail.page === null) {
        return {
          failure: rail.failure,
          items: [],
          kind: rail.kind,
          totalResults: 0,
          truncated: false,
        };
      }
      const items = rail.page.items
        .slice(0, DISCOVERY_FEED_MAX_ITEMS_PER_RAIL)
        .map(({ artwork, media }) => ({
          ...media,
          artwork: {
            backdropPath: artworkPath(artwork.backdropPath),
            posterPath: artworkPath(artwork.posterPath),
          },
        }));
      return {
        failure: null,
        items,
        kind: rail.kind,
        totalResults: rail.page.totalResults,
        truncated: rail.page.totalResults > items.length,
      };
    });
    if (referenceIndex !== artworkReferences.length) {
      throw new DiscoverySearchError("storage_failure");
    }
    const failures = rails.flatMap((rail) => (rail.failure === null ? [] : [rail.failure]));
    const itemCount = rails.reduce((total, rail) => total + rail.items.length, 0);
    const state =
      failures.length === FEED_KINDS.length
        ? "unavailable"
        : failures.length > 0
          ? "degraded"
          : itemCount === 0
            ? "empty"
            : "complete";
    return discoveryFeedResponseSchema.parse({
      failures,
      generatedAt: occurredAt.toISOString(),
      rails,
      state,
    });
  }

  public async readArtwork(
    context: DiscoverySearchContext,
    referenceId: string,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoveryArtworkError("not_found");
    let reference;
    try {
      reference = this.#references.resolve(principal.userId, referenceId);
    } catch (error) {
      if (error instanceof DiscoveryArtworkReferenceError) {
        throw new DiscoveryArtworkError("not_found", { cause: error });
      }
      throw error;
    }
    try {
      const row = this.#connector();
      if (row.id !== reference.connectorId) throw new DiscoveryArtworkError("not_found");
      const adapter = this.#adapterFor(row);
      if (!adapter.readDiscoveryArtwork) throw new DiscoveryArtworkError("unavailable");
      const image = await adapter.readDiscoveryArtwork(reference.path, reference.kind, signal);
      const digest = createHash("sha256").update(image.body).digest("base64url").slice(0, 22);
      return Object.freeze({
        body: image.body,
        contentType: image.contentType,
        etag: `"discovery_artwork_${digest}"`,
      });
    } catch (error) {
      if (error instanceof DiscoveryArtworkError) throw error;
      if (isAbort(error)) throw error;
      throw new DiscoveryArtworkError("unavailable", { cause: error });
    }
  }

  public async search(
    input: DiscoverySearchQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "media.view");
    const query = discoverySearchQuerySchema.parse(input);
    const adapter = this.#adapter();
    return discoverySearchResponseSchema.parse(await adapter.search(query, signal));
  }

  public async detail(
    paramsInput: DiscoveryMediaDetailParams,
    queryInput: DiscoveryMediaDetailQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "media.view");
    const params = discoveryMediaDetailParamsSchema.parse(paramsInput);
    const query = discoveryMediaDetailQuerySchema.parse(queryInput);
    const adapter = this.#adapter();
    return discoveryMediaDetailResponseSchema.parse(await adapter.detail(params, query, signal));
  }

  public async personDetail(
    paramsInput: DiscoveryPersonDetailParams,
    queryInput: DiscoveryPersonDetailQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    requirePermission(context.principal, "media.view");
    const params = discoveryPersonDetailParamsSchema.parse(paramsInput);
    const query = discoveryPersonDetailQuerySchema.parse(queryInput);
    const adapter = this.#adapter();
    return discoveryPersonDetailResponseSchema.parse(
      await adapter.personDetail(params, query, signal),
    );
  }

  #adapter() {
    return this.#adapterFor(this.#connector());
  }

  #adapterFor(row: DiscoveryConnectorRow) {
    const secrets = connectorSecrets(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      !row.id ||
      row.id.length > 128 ||
      !row.displayName.trim() ||
      row.displayName.length > 160
    ) {
      throw new DiscoverySearchError("connector_integrity_failure");
    }
    try {
      return this.#createAdapter({
        apiKey: secrets.apiKey,
        baseUrl: row.baseUrl,
        connectorId: row.id,
        displayName: row.displayName,
        insecureHttpApproved: row.insecureHttpApproved === 1,
        tlsPolicy,
        ...(secrets.tlsCaCertificatePem === undefined
          ? {}
          : { tlsCaCertificatePem: secrets.tlsCaCertificatePem }),
        clock: { now: this.#clock, monotonicNow: () => performance.now() },
      });
    } catch (error) {
      throw new DiscoverySearchError("connector_integrity_failure", { cause: error });
    }
  }

  #connector() {
    try {
      const rows = this.#database.sqlite
        .prepare(
          `select
             id,
             display_name as displayName,
             base_url as baseUrl,
             encrypted_credentials as encryptedCredentials,
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type = 'seerr' and enabled = 1
           order by id asc
           limit 2`,
        )
        .all() as DiscoveryConnectorRow[];
      if (rows.length === 0) throw new DiscoverySearchError("connector_unconfigured");
      if (rows.length > 1) throw new DiscoverySearchError("connector_ambiguous");
      return rows[0]!;
    } catch (error) {
      if (error instanceof DiscoverySearchError) throw error;
      throw new DiscoverySearchError("storage_failure", { cause: error });
    }
  }
}
