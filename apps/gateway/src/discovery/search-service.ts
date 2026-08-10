import {
  SeerrAdapter,
  type SeerrDiscoveryArtwork,
  type SeerrDiscoveryBrowsePage,
  type SeerrDiscoveryFeedPage,
  type SeerrDiscoveryMediaDetail,
  type SeerrDiscoveryPersonDetail,
  type SeerrDiscoveryPersonCredits,
} from "@omnifin/connectors/adapters/seerr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { OptionalApiKeyConnectorConfig } from "@omnifin/connectors/types";
import { connectorCredentialInputSchema, type PartialFailure } from "@omnifin/contracts/connectors";
import {
  DISCOVERY_BROWSE_MAX_ITEMS_PER_PAGE,
  DISCOVERY_BROWSE_MAX_PAGES,
  DISCOVERY_FEED_MAX_ITEMS_PER_RAIL,
  discoveryBrowseQuerySchema,
  discoveryBrowseResponseSchema,
  discoveryFeedQuerySchema,
  discoveryFeedResponseSchema,
  discoveryMediaDetailParamsSchema,
  discoveryMediaDetailQuerySchema,
  discoveryMediaDetailResponseSchema,
  discoveryPersonDetailParamsSchema,
  discoveryPersonDetailQuerySchema,
  discoveryPersonDetailResponseSchema,
  discoveryPersonCreditsQuerySchema,
  discoveryPersonCreditsResponseSchema,
  discoverySearchQuerySchema,
  discoverySearchResponseSchema,
  isDiscoveryMediaRequestable,
  type DiscoveryBrowseQuery,
  type DiscoveryBrowseResponse,
  type DiscoveryFeedQuery,
  type DiscoveryFeedRailKind,
  type DiscoveryFeedResponse,
  type DiscoveryAvailability,
  type DiscoveryMediaRecordState,
  type DiscoveryMediaDetailParams,
  type DiscoveryMediaDetailQuery,
  type DiscoveryPersonDetailParams,
  type DiscoveryPersonDetailQuery,
  type DiscoveryPersonCreditsQuery,
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
import {
  reconcileVerifiedAvailability,
  unavailableOwnershipEvidence,
  VerifiedAvailabilityService,
  type VerifiedAvailabilityInput,
  type VerifiedOwnershipEvidence,
} from "../media/verified-availability-service.js";

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
  browse?(input: DiscoveryBrowseQuery, signal?: AbortSignal): Promise<SeerrDiscoveryBrowsePage>;
  discover?(
    kind: DiscoveryFeedRailKind,
    input: DiscoveryFeedQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryFeedPage>;
  detail(
    params: DiscoveryMediaDetailParams,
    query: DiscoveryMediaDetailQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryMediaDetail>;
  personDetail(
    params: DiscoveryPersonDetailParams,
    query: DiscoveryPersonDetailQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryPersonDetail>;
  personCredits(
    params: DiscoveryPersonDetailParams,
    query: DiscoveryPersonCreditsQuery,
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryPersonCredits>;
  search(input: DiscoverySearchQuery, signal?: AbortSignal): Promise<DiscoverySearchResponse>;
  readDiscoveryArtwork?(
    path: string,
    kind: "backdrop" | "poster" | "profile",
    signal?: AbortSignal,
  ): Promise<SeerrDiscoveryArtwork>;
}

export interface DiscoverySearchDependencies {
  clock?: () => Date;
  createAdapter?: (config: OptionalApiKeyConnectorConfig) => DiscoverySearchAdapter;
  verifyOwnership?: (
    input: VerifiedAvailabilityInput,
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ) => Promise<VerifiedOwnershipEvidence>;
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
const DISCOVERY_AVAILABILITY_MAX_TITLES = 100;
const DISCOVERY_AVAILABILITY_CONCURRENCY = 6;

interface AvailabilityMedia {
  availability: DiscoveryAvailability;
  kind: "movie" | "series";
  mediaRecordState: DiscoveryMediaRecordState;
  tmdbId: number;
}

function availabilityKey(input: Pick<AvailabilityMedia, "kind" | "tmdbId">) {
  return `${input.kind}:${input.tmdbId}`;
}

function matchesReconciledAvailability(
  media: Pick<AvailabilityMedia, "availability" | "mediaRecordState">,
  filter: DiscoveryBrowseQuery["availability"],
) {
  if (filter === "any") return true;
  if (filter === "requestable") return isDiscoveryMediaRequestable(media);
  return media.availability === filter;
}

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
  readonly #verifyOwnership: NonNullable<DiscoverySearchDependencies["verifyOwnership"]>;

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
    if (dependencies.verifyOwnership) this.#verifyOwnership = dependencies.verifyOwnership;
    else {
      const availability = new VerifiedAvailabilityService(database, config);
      this.#verifyOwnership = availability.verifyOwnership.bind(availability);
    }
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
    const reconciledItems = await this.#reconcileMedia(
      rails.flatMap((rail) => rail.items),
      principal,
      signal,
    );
    let reconciledIndex = 0;
    const reconciledRails = rails.map((rail) => ({
      ...rail,
      items: reconciledItems.slice(reconciledIndex, (reconciledIndex += rail.items.length)),
    }));
    const failures = reconciledRails.flatMap((rail) =>
      rail.failure === null ? [] : [rail.failure],
    );
    const itemCount = reconciledRails.reduce((total, rail) => total + rail.items.length, 0);
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
      rails: reconciledRails,
      state,
    });
  }

  public async browse(
    input: DiscoveryBrowseQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ): Promise<DiscoveryBrowseResponse> {
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoverySearchError("connector_integrity_failure");
    const criteria = discoveryBrowseQuerySchema.parse(input);
    const row = this.#connector();
    const adapter = this.#adapterFor(row);
    const browse = adapter.browse?.bind(adapter);
    if (!browse) throw new DiscoverySearchError("connector_integrity_failure");
    const page = await browse(
      criteria.availability === "any" ? criteria : { ...criteria, availability: "any" },
      signal,
    );
    const rawItems = page.items.slice(0, DISCOVERY_BROWSE_MAX_ITEMS_PER_PAGE);
    const reconciledMedia = await this.#reconcileMedia(
      rawItems.map(({ media }) => media),
      principal,
      signal,
    );
    const filteredItems = rawItems.flatMap((item, index) => {
      const media = reconciledMedia[index];
      return media && matchesReconciledAvailability(media, criteria.availability)
        ? [{ ...item, media }]
        : [];
    });
    const artworkInputs = filteredItems.flatMap(({ artwork }) => [
      ...(artwork.backdropPath === null
        ? []
        : [{ kind: "backdrop" as const, path: artwork.backdropPath }]),
      ...(artwork.posterPath === null
        ? []
        : [{ kind: "poster" as const, path: artwork.posterPath }]),
    ]);
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
    const items = filteredItems.map(({ artwork, media }) => ({
      ...media,
      artwork: {
        backdropPath: artworkPath(artwork.backdropPath),
        posterPath: artworkPath(artwork.posterPath),
      },
    }));
    if (referenceIndex !== artworkReferences.length) {
      throw new DiscoverySearchError("storage_failure");
    }
    return discoveryBrowseResponseSchema.parse({
      criteria,
      generatedAt: this.#clock().toISOString(),
      items,
      page: page.page,
      totalPages: Math.min(page.totalPages, DISCOVERY_BROWSE_MAX_PAGES),
      totalResults: page.totalResults,
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
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoverySearchError("connector_integrity_failure");
    const query = discoverySearchQuerySchema.parse(input);
    const adapter = this.#adapter();
    const response = discoverySearchResponseSchema.parse(await adapter.search(query, signal));
    const media = response.items.filter(
      (item): item is Extract<(typeof response.items)[number], { kind: "movie" | "series" }> =>
        item.kind !== "person",
    );
    const reconciled = await this.#reconcileMedia(media, principal, signal);
    let mediaIndex = 0;
    return discoverySearchResponseSchema.parse({
      ...response,
      items: response.items.map((item) =>
        item.kind === "person" ? item : reconciled[mediaIndex++]!,
      ),
    });
  }

  public async detail(
    paramsInput: DiscoveryMediaDetailParams,
    queryInput: DiscoveryMediaDetailQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoverySearchError("connector_integrity_failure");
    const params = discoveryMediaDetailParamsSchema.parse(paramsInput);
    const query = discoveryMediaDetailQuerySchema.parse(queryInput);
    const row = this.#connector();
    const adapter = this.#adapterFor(row);
    const detail = await adapter.detail(params, query, signal);
    if (detail.artwork.castProfilePaths.length !== detail.response.item.cast.length) {
      throw new DiscoverySearchError("connector_integrity_failure");
    }
    const inputs = [
      ...(detail.artwork.backdropPath === null
        ? []
        : [{ kind: "backdrop" as const, path: detail.artwork.backdropPath }]),
      ...(detail.artwork.posterPath === null
        ? []
        : [{ kind: "poster" as const, path: detail.artwork.posterPath }]),
      ...detail.artwork.castProfilePaths.flatMap((path) =>
        path === null ? [] : [{ kind: "profile" as const, path }],
      ),
    ];
    let references: string[];
    try {
      references = this.#references.create(principal.userId, row.id, inputs);
    } catch (error) {
      throw new DiscoverySearchError("storage_failure", { cause: error });
    }
    let referenceIndex = 0;
    const artworkPath = (path: string | null) => {
      if (path === null) return null;
      const reference = references[referenceIndex++];
      if (!reference) throw new DiscoverySearchError("storage_failure");
      return `/v1/discovery/artwork/${reference}`;
    };
    const response = discoveryMediaDetailResponseSchema.parse({
      ...detail.response,
      item: {
        ...detail.response.item,
        artwork: {
          backdropPath: artworkPath(detail.artwork.backdropPath),
          posterPath: artworkPath(detail.artwork.posterPath),
        },
        cast: detail.response.item.cast.map((credit, index) => ({
          ...credit,
          profilePath: artworkPath(detail.artwork.castProfilePaths[index] ?? null),
        })),
      },
    });
    if (referenceIndex !== references.length) throw new DiscoverySearchError("storage_failure");
    const reconciledAvailability = await this.#reconcileMedia(
      [response.item, ...response.item.intelligence.recommendations],
      principal,
      signal,
    );
    const [itemAvailability, ...recommendationAvailability] = reconciledAvailability;
    if (!itemAvailability) throw new DiscoverySearchError("connector_integrity_failure");
    return discoveryMediaDetailResponseSchema.parse({
      ...response,
      item: {
        ...response.item,
        availability: itemAvailability.availability,
        intelligence: {
          ...response.item.intelligence,
          recommendations: response.item.intelligence.recommendations.map(
            (recommendation, index) => ({
              ...recommendation,
              availability:
                recommendationAvailability[index]?.availability ?? recommendation.availability,
            }),
          ),
        },
      },
    });
  }

  public async trailers(
    paramsInput: DiscoveryMediaDetailParams,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoverySearchError("connector_integrity_failure");
    const params = discoveryMediaDetailParamsSchema.parse(paramsInput);
    const row = this.#connector();
    const adapter = this.#adapterFor(row);
    const detail = await adapter.detail(params, { language: "en" }, signal);
    return {
      displayName: row.displayName,
      items: detail.response.item.intelligence.trailers,
    };
  }

  public async personDetail(
    paramsInput: DiscoveryPersonDetailParams,
    queryInput: DiscoveryPersonDetailQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoverySearchError("connector_integrity_failure");
    const params = discoveryPersonDetailParamsSchema.parse(paramsInput);
    const query = discoveryPersonDetailQuerySchema.parse(queryInput);
    const row = this.#connector();
    const adapter = this.#adapterFor(row);
    const detail = await adapter.personDetail(params, query, signal);
    let profilePath = null;
    if (detail.profilePath !== null) {
      try {
        const [reference] = this.#references.create(principal.userId, row.id, [
          { kind: "profile", path: detail.profilePath },
        ]);
        if (!reference) throw new DiscoveryArtworkReferenceError();
        profilePath = `/v1/discovery/artwork/${reference}`;
      } catch (error) {
        throw new DiscoverySearchError("storage_failure", { cause: error });
      }
    }
    const response = discoveryPersonDetailResponseSchema.parse({
      ...detail.response,
      item: { ...detail.response.item, profilePath },
    });
    return discoveryPersonDetailResponseSchema.parse({
      ...response,
      item: {
        ...response.item,
        credits: await this.#reconcileMedia(response.item.credits, principal, signal),
      },
    });
  }

  public async personCredits(
    paramsInput: DiscoveryPersonDetailParams,
    queryInput: DiscoveryPersonCreditsQuery,
    context: DiscoverySearchContext,
    signal?: AbortSignal,
  ) {
    const principal = requirePermission(context.principal, "media.view");
    if (principal.userId === null) throw new DiscoverySearchError("connector_integrity_failure");
    const params = discoveryPersonDetailParamsSchema.parse(paramsInput);
    const query = discoveryPersonCreditsQuerySchema.parse(queryInput);
    const row = this.#connector();
    const response = discoveryPersonCreditsResponseSchema.parse(
      await this.#adapterFor(row).personCredits(params, query, signal),
    );
    return discoveryPersonCreditsResponseSchema.parse({
      ...response,
      items: await this.#reconcileMedia(response.items, principal, signal),
    });
  }

  async #reconcileMedia<T extends AvailabilityMedia>(
    items: readonly T[],
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const unique = new Map<string, VerifiedAvailabilityInput>();
    for (const item of items) {
      unique.set(availabilityKey(item), { kind: item.kind, tmdbId: item.tmdbId });
    }
    if (unique.size > DISCOVERY_AVAILABILITY_MAX_TITLES) {
      throw new DiscoverySearchError("connector_integrity_failure");
    }
    const pending = [...unique.entries()];
    const evidence = new Map<string, VerifiedOwnershipEvidence>();
    let index = 0;
    const worker = async () => {
      while (index < pending.length) {
        const entry = pending[index++];
        if (!entry) return;
        const [key, input] = entry;
        try {
          evidence.set(key, await this.#verifyOwnership(input, principal, signal));
        } catch (error) {
          if (isAbort(error)) throw error;
          evidence.set(key, unavailableOwnershipEvidence(principal.userId));
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DISCOVERY_AVAILABILITY_CONCURRENCY, pending.length) }, worker),
    );
    return items.map((item) => ({
      ...item,
      availability: reconcileVerifiedAvailability(
        item.availability,
        evidence.get(availabilityKey(item)) ?? unavailableOwnershipEvidence(principal.userId),
      ),
    }));
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
