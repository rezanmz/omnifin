import {
  JellyfinLibraryClient,
  type JellyfinLibraryAttentionResult,
  type JellyfinRemoteArtworkCandidate,
} from "@omnifin/connectors/media/jellyfin-library-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { connectorCredentialInputSchema } from "@omnifin/contracts/connectors";
import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  libraryArtworkCandidateSchema,
  libraryArtworkKindSchema,
  libraryArtworkResultIdSchema,
  libraryArtworkSearchIdSchema,
  libraryArtworkSearchRequestSchema,
  libraryArtworkSearchResponseSchema,
  libraryAttentionQuerySchema,
  libraryAttentionResponseSchema,
  libraryItemRefreshRequestSchema,
  libraryMetadataUpdateRequestSchema,
  libraryMutationIdempotencyKeySchema,
  libraryMutationResponseSchema,
  libraryOperationIdSchema,
  type LibraryArtworkCandidate,
  type LibraryArtworkKind,
  type LibraryArtworkSearchResponse,
  type LibraryAttentionQuery,
  type LibraryAttentionResponse,
  type LibraryItemRefreshRequest,
  type LibraryMetadataUpdateRequest,
  type LibraryMutationResponse,
} from "@omnifin/contracts/library";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import {
  MediaReferenceError,
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "../media/media-reference-service.js";
import {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  privacyHash,
  randomToken,
} from "../security/crypto.js";

const ARTWORK_SEARCH_TTL_MS = 20 * 60 * 1_000;
const MAX_ACTIVE_ARTWORK_SEARCHES = 20;
const MAX_ENCRYPTED_SEARCH_BYTES = 4_194_304;
const MAX_ID_ATTEMPTS = 8;
const MAX_OPERATIONS_PER_USER = 4_096;
const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const STALE_PENDING_OPERATION_MS = 5 * 60 * 1_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

const cursorPayloadSchema = z.strictObject({
  linkId: z.string().regex(IDENTIFIER_PATTERN),
  linkRevision: z.int().nonnegative().max(2_147_483_647),
  startIndex: z.int().nonnegative().max(1_000_000),
  version: z.literal(1),
});
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

const storedArtworkCandidateSchema = libraryArtworkCandidateSchema.extend({
  imageUrl: z.url().max(8_192),
  previewUrl: z.url().max(8_192),
});

const storedArtworkSearchSchema = z.strictObject({
  candidates: z.array(storedArtworkCandidateSchema).max(40),
  itemId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  kind: libraryArtworkKindSchema,
  referenceId: mediaReferenceIdSchema,
  schemaVersion: z.literal(1),
});
type StoredArtworkSearch = z.infer<typeof storedArtworkSearchSchema>;

interface LibrarySourceRow {
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

interface MutationOperationRow {
  failureCode: string | null;
  fingerprintHash: string;
  responseJson: string | null;
  state: string;
}

interface ArtworkSearchRow {
  currentLinkRevision: number;
  encryptedPayload: string;
  expiresAt: number;
  linkRevision: number;
  mediaReferenceId: string;
  serviceIdentityLinkId: string;
}

type MutationKind = "artwork_apply" | "item_refresh" | "metadata_update" | "scan";

export interface LibraryOperationContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface LibraryClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

export interface LibraryOperationClient {
  applyRemoteArtwork: JellyfinLibraryClient["applyRemoteArtwork"];
  listAttentionItems: JellyfinLibraryClient["listAttentionItems"];
  readRemoteArtwork: JellyfinLibraryClient["readRemoteArtwork"];
  refreshItem: JellyfinLibraryClient["refreshItem"];
  scanLibrary: JellyfinLibraryClient["scanLibrary"];
  searchRemoteArtwork: JellyfinLibraryClient["searchRemoteArtwork"];
  updateMetadata: JellyfinLibraryClient["updateMetadata"];
}

export interface LibraryOperationDependencies {
  clock?: () => Date;
  createAuditId?: () => string;
  createClient?: (input: LibraryClientFactoryInput) => LibraryOperationClient;
  createOperationToken?: () => string;
  createResultToken?: () => string;
  createSearchToken?: () => string;
  mediaReferences?: MediaReferenceDependencies;
}

export interface LibraryMutationResult {
  receipt: LibraryMutationResponse;
  replayed: boolean;
}

export type LibraryOperationFailureCode =
  | "configuration_unavailable"
  | "permission_denied"
  | "rate_limited"
  | "response_invalid"
  | "search_expired"
  | "temporarily_unavailable";

const FAILURE_CODES = new Set<LibraryOperationFailureCode>([
  "configuration_unavailable",
  "permission_denied",
  "rate_limited",
  "response_invalid",
  "search_expired",
  "temporarily_unavailable",
]);

export type LibraryOperationErrorReason =
  | LibraryOperationFailureCode
  | "cursor_invalid"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_required"
  | "item_not_found"
  | "operation_limit_reached"
  | "search_integrity_failure"
  | "storage_failure";

export class LibraryOperationError extends Error {
  public readonly reason: LibraryOperationErrorReason;

  public constructor(reason: LibraryOperationErrorReason, options?: ErrorOptions) {
    super("The library operation could not be completed.", options);
    this.name = "LibraryOperationError";
    this.reason = reason;
  }
}

class LibraryConfigurationError extends Error {}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function connectorCredentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function artworkSearchContext(searchId: string) {
  return `library_artwork_search:${searchId}`;
}

function safeDisplayName(value: string) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || "Jellyfin").slice(0, 160);
}

function accessToken(row: LibrarySourceRow, cipher: EnvelopeCipher) {
  try {
    return cipher.decrypt(row.encryptedAccessToken, accessTokenContext(row.linkId));
  } catch (error) {
    throw new LibraryConfigurationError("invalid", { cause: error });
  }
}

function connectorSecrets(row: LibrarySourceRow, cipher: EnvelopeCipher) {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, connectorCredentialsContext(row.connectorId)),
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
    throw new LibraryConfigurationError("invalid", { cause: error });
  }
}

function defaultClient(input: LibraryClientFactoryInput): LibraryOperationClient {
  const { accessToken: token, deviceId, ...target } = input;
  return new JellyfinLibraryClient({ accessToken: token, deviceId, target });
}

function publicArtworkCandidate(
  candidate: z.infer<typeof storedArtworkCandidateSchema>,
): LibraryArtworkCandidate {
  return libraryArtworkCandidateSchema.parse({
    communityRating: candidate.communityRating,
    height: candidate.height,
    id: candidate.id,
    language: candidate.language,
    previewPath: candidate.previewPath,
    providerName: candidate.providerName,
    voteCount: candidate.voteCount,
    width: candidate.width,
  });
}

function knownFailure(error: unknown): LibraryOperationFailureCode {
  if (error instanceof LibraryOperationError) {
    return FAILURE_CODES.has(error.reason as LibraryOperationFailureCode)
      ? (error.reason as LibraryOperationFailureCode)
      : "configuration_unavailable";
  }
  if (error instanceof SafeConnectorError) {
    if (error.code === "rate_limited") return "rate_limited";
    if (error.code === "response_invalid" || error.code === "unsupported_version") {
      return "response_invalid";
    }
    if (error.status === 403) return "permission_denied";
    if (
      error.code === "configuration_invalid" ||
      error.code === "destination_blocked" ||
      error.code === "invalid_credentials"
    ) {
      return "configuration_unavailable";
    }
  }
  if (error instanceof LibraryConfigurationError) return "configuration_unavailable";
  return "temporarily_unavailable";
}

function mutationEvent(kind: MutationKind, outcome: "success" | "failure") {
  const events: Record<MutationKind, string> = {
    artwork_apply: "library.artwork.applied",
    item_refresh: "library.item.refresh.requested",
    metadata_update: "library.metadata.updated",
    scan: "library.scan.requested",
  };
  return outcome === "success" ? events[kind] : `${events[kind]}.failed`;
}

export class LibraryOperationService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAuditId: () => string;
  readonly #createClient: NonNullable<LibraryOperationDependencies["createClient"]>;
  readonly #createOperationToken: () => string;
  readonly #createResultToken: () => string;
  readonly #createSearchToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #references: MediaReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: LibraryOperationDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAuditId = dependencies.createAuditId ?? randomUUID;
    this.#createClient = dependencies.createClient ?? defaultClient;
    this.#createOperationToken = dependencies.createOperationToken ?? (() => randomToken(16));
    this.#createResultToken = dependencies.createResultToken ?? (() => randomToken(16));
    this.#createSearchToken = dependencies.createSearchToken ?? (() => randomToken(16));
    this.#references = new MediaReferenceService(database, config, dependencies.mediaReferences);
  }

  public async attention(
    rawQuery: LibraryAttentionQuery,
    context: LibraryOperationContext,
    signal?: AbortSignal,
  ): Promise<LibraryAttentionResponse> {
    const principal = this.#activePrincipal(context);
    const query = libraryAttentionQuerySchema.parse(rawQuery);
    const source = this.#source(principal);
    const startIndex = query.cursor ? this.#decodeCursor(query.cursor, source).startIndex : 0;
    const result = await this.#client(source).listAttentionItems(
      { limit: query.limit, startIndex },
      signal,
    );
    return this.#attentionResponse(source, result);
  }

  public async scan(
    rawIdempotencyKey: string,
    context: LibraryOperationContext,
    signal?: AbortSignal,
  ): Promise<LibraryMutationResult> {
    const principal = this.#activePrincipal(context);
    const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(rawIdempotencyKey);
    return this.#executeMutation(
      principal,
      "scan",
      null,
      idempotencyKey,
      { kind: "scan", version: 1 },
      context,
      async () => this.#client(this.#source(principal)).scanLibrary(signal),
    );
  }

  public async refresh(
    rawReferenceId: string,
    rawRequest: LibraryItemRefreshRequest,
    rawIdempotencyKey: string,
    context: LibraryOperationContext,
    signal?: AbortSignal,
  ): Promise<LibraryMutationResult> {
    const principal = this.#activePrincipal(context);
    const referenceId = mediaReferenceIdSchema.parse(rawReferenceId);
    const request = libraryItemRefreshRequestSchema.parse(rawRequest);
    const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(rawIdempotencyKey);
    return this.#executeMutation(
      principal,
      "item_refresh",
      referenceId,
      idempotencyKey,
      { kind: "item_refresh", referenceId, request, version: 1 },
      context,
      async () => {
        const source = this.#source(principal);
        const item = this.#resolveItem(source, referenceId);
        await this.#client(source).refreshItem({ itemId: item.itemId, ...request }, signal);
      },
    );
  }

  public async updateMetadata(
    rawReferenceId: string,
    rawRequest: LibraryMetadataUpdateRequest,
    rawIdempotencyKey: string,
    context: LibraryOperationContext,
    signal?: AbortSignal,
  ): Promise<LibraryMutationResult> {
    const principal = this.#activePrincipal(context);
    const referenceId = mediaReferenceIdSchema.parse(rawReferenceId);
    const request = libraryMetadataUpdateRequestSchema.parse(rawRequest);
    const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(rawIdempotencyKey);
    return this.#executeMutation(
      principal,
      "metadata_update",
      referenceId,
      idempotencyKey,
      { kind: "metadata_update", referenceId, request, version: 1 },
      context,
      async () => {
        const source = this.#source(principal);
        const item = this.#resolveItem(source, referenceId);
        await this.#client(source).updateMetadata(
          item.itemId,
          {
            ...(request.overview === undefined ? {} : { overview: request.overview }),
            ...(request.title === undefined ? {} : { title: request.title }),
            ...(request.year === undefined ? {} : { year: request.year }),
          },
          signal,
        );
      },
      { changedFields: Object.keys(request).sort() },
    );
  }

  public async searchArtwork(
    rawReferenceId: string,
    rawRequest: { includeAllLanguages?: boolean; kind: LibraryArtworkKind },
    context: LibraryOperationContext,
    signal?: AbortSignal,
  ): Promise<LibraryArtworkSearchResponse> {
    const principal = this.#activePrincipal(context);
    const referenceId = mediaReferenceIdSchema.parse(rawReferenceId);
    const request = libraryArtworkSearchRequestSchema.parse(rawRequest);
    const source = this.#source(principal);
    const item = this.#resolveItem(source, referenceId);
    const candidates = await this.#client(source).searchRemoteArtwork(item.itemId, request, signal);
    const now = this.#now();
    const expiresAt = now + ARTWORK_SEARCH_TTL_MS;
    const searchId = this.#artworkSearchId();
    const storedCandidates = this.#storedCandidates(searchId, candidates);
    const payload = storedArtworkSearchSchema.parse({
      candidates: storedCandidates,
      itemId: item.itemId,
      kind: request.kind,
      referenceId,
      schemaVersion: 1,
    });
    const encryptedPayload = this.#cipher.encrypt(
      JSON.stringify(payload),
      artworkSearchContext(searchId),
    );
    if (Buffer.byteLength(encryptedPayload, "utf8") > MAX_ENCRYPTED_SEARCH_BYTES) {
      throw new LibraryOperationError("response_invalid");
    }
    try {
      this.#database.sqlite
        .transaction(() => {
          this.#pruneArtworkSearches(principal.userId, now);
          this.#database.sqlite
            .prepare(
              `insert into library_artwork_searches (
                 id, user_id, service_identity_link_id, link_revision,
                 media_reference_id, encrypted_payload, expires_at, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              searchId,
              principal.userId,
              source.linkId,
              source.linkRevision,
              referenceId,
              encryptedPayload,
              expiresAt,
              now,
              now,
            );
          this.#audit(
            "library.artwork.search.completed",
            "success",
            searchId,
            { kind: request.kind, referenceId, resultCount: storedCandidates.length },
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof LibraryOperationError) throw error;
      throw new LibraryOperationError("storage_failure", { cause: error });
    }
    return libraryArtworkSearchResponseSchema.parse({
      expiresAt: new Date(expiresAt).toISOString(),
      generatedAt: new Date(now).toISOString(),
      kind: request.kind,
      referenceId,
      results: storedCandidates.map(publicArtworkCandidate),
      searchId,
    });
  }

  public async previewArtwork(
    rawSearchId: string,
    rawResultId: string,
    context: LibraryOperationContext,
    signal?: AbortSignal,
  ) {
    const principal = this.#activePrincipal(context);
    const stored = this.#artworkCandidate(principal, rawSearchId, rawResultId);
    const source = this.#source(principal, stored.serviceIdentityLinkId);
    try {
      const image = await this.#client(source).readRemoteArtwork(
        stored.candidate.previewUrl,
        signal,
      );
      const digest = createHash("sha256").update(image.body).digest("base64url").slice(0, 22);
      return Object.freeze({
        body: image.body,
        contentType: image.contentType,
        etag: `"library_artwork_${digest}"`,
      });
    } catch (error) {
      throw new LibraryOperationError(knownFailure(error), { cause: error });
    }
  }

  public async applyArtwork(
    rawSearchId: string,
    rawResultId: string,
    rawIdempotencyKey: string,
    context: LibraryOperationContext,
    signal?: AbortSignal,
  ): Promise<LibraryMutationResult> {
    const principal = this.#activePrincipal(context);
    const searchId = libraryArtworkSearchIdSchema.parse(rawSearchId);
    const resultId = libraryArtworkResultIdSchema.parse(rawResultId);
    const idempotencyKey = libraryMutationIdempotencyKeySchema.parse(rawIdempotencyKey);
    const stored = this.#artworkCandidate(principal, searchId, resultId);
    return this.#executeMutation(
      principal,
      "artwork_apply",
      stored.referenceId,
      idempotencyKey,
      { kind: "artwork_apply", resultId, searchId, version: 1 },
      context,
      async () => {
        const source = this.#source(principal, stored.serviceIdentityLinkId);
        await this.#client(source).applyRemoteArtwork(
          stored.payload.itemId,
          stored.payload.kind,
          stored.candidate.imageUrl,
          signal,
        );
      },
      { artworkKind: stored.payload.kind, resultId, searchId },
    );
  }

  #activePrincipal(context: LibraryOperationContext) {
    const principal = requirePermission(context.principal, "library.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new LibraryOperationError("identity_required");
    }
    return principal as SessionPrincipal & { userId: string };
  }

  #client(row: LibrarySourceRow) {
    try {
      const secrets = connectorSecrets(row, this.#cipher);
      const token = accessToken(row, this.#cipher);
      const tlsPolicy =
        row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
          ? row.tlsPolicy
          : undefined;
      if (!tlsPolicy) throw new LibraryConfigurationError();
      return this.#createClient({
        accessToken: token,
        baseUrl: row.baseUrl,
        connectorId: row.connectorId,
        deviceId: row.deviceId,
        displayName: safeDisplayName(row.connectorDisplayName),
        insecureHttpApproved: row.insecureHttpApproved === 1,
        tlsPolicy,
        ...secrets,
      });
    } catch (error) {
      throw new LibraryOperationError("configuration_unavailable", { cause: error });
    }
  }

  #source(principal: SessionPrincipal & { userId: string }, expectedLinkId?: string) {
    const linkedService = principal.linkedServices.find(
      ({ id, service }) =>
        service === "jellyfin" && (expectedLinkId === undefined || id === expectedLinkId),
    );
    if (!linkedService) throw new LibraryOperationError("identity_required");
    let row: LibrarySourceRow | undefined;
    try {
      row = this.#database.sqlite
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
        .get(linkedService.id, principal.userId) as LibrarySourceRow | undefined;
    } catch (error) {
      throw new LibraryOperationError("storage_failure", { cause: error });
    }
    if (
      !row ||
      row.linkUserId !== principal.userId ||
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
      ![0, 1].includes(row.insecureHttpApproved)
    ) {
      throw new LibraryOperationError("configuration_unavailable");
    }
    return row;
  }

  #resolveItem(source: LibrarySourceRow, rawReferenceId: string) {
    const referenceId = mediaReferenceIdSchema.parse(rawReferenceId);
    try {
      const reference = this.#references.resolve(
        {
          linkId: source.linkId,
          linkRevision: source.linkRevision,
          userId: source.linkUserId,
        },
        referenceId,
      );
      if (reference.kind === "episode") throw new LibraryOperationError("item_not_found");
      return reference;
    } catch (error) {
      if (error instanceof LibraryOperationError) throw error;
      if (error instanceof MediaReferenceError) {
        throw new LibraryOperationError("item_not_found", { cause: error });
      }
      throw error;
    }
  }

  #attentionResponse(
    source: LibrarySourceRow,
    result: JellyfinLibraryAttentionResult,
  ): LibraryAttentionResponse {
    const referenceIds: string[] = [];
    for (let index = 0; index < result.items.length; index += 50) {
      const items = result.items.slice(index, index + 50);
      referenceIds.push(
        ...this.#references.createOrRefresh(
          { linkId: source.linkId, linkRevision: source.linkRevision, userId: source.linkUserId },
          items.map((item) => ({
            artwork: {
              backdropItemId: null,
              posterItemId: item.artwork.poster?.itemId ?? null,
            },
            episodeNumber: null,
            itemId: item.externalId,
            kind: item.kind === "movie" ? "movie" : "other",
            seasonNumber: null,
            title: item.title,
            year: item.year,
          })),
        ),
      );
    }
    const generatedAt = new Date(this.#now()).toISOString();
    return libraryAttentionResponseSchema.parse({
      generatedAt,
      items: result.items.map((item, index) => {
        const referenceId = referenceIds[index]!;
        return {
          identityState: item.identityState,
          issues: item.issues,
          kind: item.kind,
          overview: item.overview,
          posterPath:
            item.artwork.poster === null ? null : `/v1/media/${referenceId}/images/poster`,
          referenceId,
          title: item.title,
          year: item.year,
        };
      }),
      nextCursor:
        result.nextStartIndex === null
          ? null
          : this.#encodeCursor({
              linkId: source.linkId,
              linkRevision: source.linkRevision,
              startIndex: result.nextStartIndex,
              version: 1,
            }),
      scanned: result.scanned,
      truncated: result.truncated,
    });
  }

  #encodeCursor(value: CursorPayload) {
    const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const signature = privacyHash("library_attention_cursor", payload, this.#config.encryptionKey);
    return `${payload}.${signature}`;
  }

  #decodeCursor(value: string, source: LibrarySourceRow) {
    try {
      const parts = value.split(".");
      if (parts.length !== 2) throw new Error("invalid");
      const [payload, signature] = parts;
      if (!payload || !signature || !CURSOR_SIGNATURE_PATTERN.test(signature)) {
        throw new Error("invalid");
      }
      const expected = privacyHash("library_attention_cursor", payload, this.#config.encryptionKey);
      if (!constantTimeTextEqual(signature, expected)) throw new Error("invalid");
      const decodedBytes = Buffer.from(payload, "base64url");
      if (!constantTimeTextEqual(payload, decodedBytes.toString("base64url"))) {
        throw new Error("invalid");
      }
      const decoded = cursorPayloadSchema.parse(JSON.parse(decodedBytes.toString("utf8")));
      if (decoded.linkId !== source.linkId || decoded.linkRevision !== source.linkRevision) {
        throw new Error("invalid");
      }
      return decoded;
    } catch (error) {
      throw new LibraryOperationError("cursor_invalid", { cause: error });
    }
  }

  #storedCandidates(searchId: string, candidates: readonly JellyfinRemoteArtworkCandidate[]) {
    const seen = new Set<string>();
    return candidates.map((candidate) => {
      let id: string | undefined;
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
        const parsed = libraryArtworkResultIdSchema.safeParse(
          `library_artwork_result_${this.#createResultToken()}`,
        );
        if (!parsed.success) throw new LibraryOperationError("search_integrity_failure");
        if (!seen.has(parsed.data)) {
          id = parsed.data;
          seen.add(id);
          break;
        }
      }
      if (!id) throw new LibraryOperationError("search_integrity_failure");
      return storedArtworkCandidateSchema.parse({
        ...candidate,
        id,
        previewPath: `/v1/library/artwork-searches/${searchId}/results/${id}/preview`,
      });
    });
  }

  #artworkCandidate(
    principal: SessionPrincipal & { userId: string },
    rawSearchId: string,
    rawResultId: string,
  ) {
    const searchId = libraryArtworkSearchIdSchema.parse(rawSearchId);
    const resultId = libraryArtworkResultIdSchema.parse(rawResultId);
    const now = this.#now();
    let row: ArtworkSearchRow | undefined;
    try {
      row = this.#database.sqlite
        .prepare(
          `select
             s.encrypted_payload as encryptedPayload,
             s.expires_at as expiresAt,
             s.link_revision as linkRevision,
             s.media_reference_id as mediaReferenceId,
             s.service_identity_link_id as serviceIdentityLinkId,
             l.revision as currentLinkRevision
           from library_artwork_searches s
           join service_identity_links l
             on l.id = s.service_identity_link_id and l.user_id = s.user_id
           where s.id = ? and s.user_id = ?
           limit 1`,
        )
        .get(searchId, principal.userId) as ArtworkSearchRow | undefined;
    } catch (error) {
      throw new LibraryOperationError("storage_failure", { cause: error });
    }
    const principalLink = row
      ? principal.linkedServices.find(
          (link) => link.id === row!.serviceIdentityLinkId && link.service === "jellyfin",
        )
      : undefined;
    if (
      !row ||
      row.expiresAt <= now ||
      row.linkRevision !== row.currentLinkRevision ||
      !principalLink ||
      !["linked", "unavailable"].includes(principalLink.health)
    ) {
      throw new LibraryOperationError("search_expired");
    }
    let payload: StoredArtworkSearch;
    try {
      payload = storedArtworkSearchSchema.parse(
        JSON.parse(this.#cipher.decrypt(row.encryptedPayload, artworkSearchContext(searchId))),
      );
    } catch (error) {
      throw new LibraryOperationError("search_integrity_failure", { cause: error });
    }
    if (payload.referenceId !== row.mediaReferenceId) {
      throw new LibraryOperationError("search_integrity_failure");
    }
    const candidate = payload.candidates.find(({ id }) => id === resultId);
    if (!candidate) throw new LibraryOperationError("search_expired");
    return {
      candidate,
      payload,
      referenceId: row.mediaReferenceId,
      serviceIdentityLinkId: row.serviceIdentityLinkId,
    };
  }

  async #executeMutation(
    principal: SessionPrincipal & { userId: string },
    kind: MutationKind,
    referenceId: string | null,
    idempotencyKey: string,
    fingerprint: Record<string, unknown>,
    context: LibraryOperationContext,
    action: () => Promise<void>,
    auditMetadata: Record<string, unknown> = {},
  ): Promise<LibraryMutationResult> {
    const fingerprintHash = hashToken(JSON.stringify(fingerprint));
    const keyHash = hashToken(`${principal.userId}\0${idempotencyKey}`);
    const reservation = this.#reserve(
      principal.userId,
      kind,
      referenceId,
      keyHash,
      fingerprintHash,
    );
    if (reservation.kind === "replay") return { receipt: reservation.response, replayed: true };
    if (reservation.kind === "failure") {
      throw new LibraryOperationError(reservation.failureCode);
    }
    if (reservation.kind === "conflict") {
      throw new LibraryOperationError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new LibraryOperationError("idempotency_in_progress");
    }
    try {
      await action();
    } catch (error) {
      const failureCode = knownFailure(error);
      this.#complete(
        reservation.operationId,
        kind,
        referenceId,
        "failure",
        null,
        failureCode,
        auditMetadata,
        context,
      );
      throw new LibraryOperationError(failureCode, { cause: error });
    }
    const receipt = libraryMutationResponseSchema.parse({
      acceptedAt: new Date(this.#now()).toISOString(),
      operationId: reservation.operationId,
      referenceId,
      state: "accepted",
    });
    this.#complete(
      reservation.operationId,
      kind,
      referenceId,
      "success",
      receipt,
      null,
      auditMetadata,
      context,
    );
    return { receipt, replayed: false };
  }

  #reserve(
    userId: string,
    kind: MutationKind,
    referenceId: string | null,
    keyHash: string,
    fingerprintHash: string,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const now = this.#now();
          this.#pruneOperations(userId, now);
          const existing = this.#database.sqlite
            .prepare(
              `select fingerprint_hash as fingerprintHash, state,
                      response_json as responseJson, failure_code as failureCode
               from library_mutation_operations
               where user_id = ? and idempotency_key_hash = ?
               limit 1`,
            )
            .get(userId, keyHash) as MutationOperationRow | undefined;
          if (existing) {
            if (existing.fingerprintHash !== fingerprintHash) return { kind: "conflict" as const };
            if (existing.state === "pending") return { kind: "pending" as const };
            if (existing.state === "failed") {
              if (
                !existing.failureCode ||
                !FAILURE_CODES.has(existing.failureCode as LibraryOperationFailureCode)
              ) {
                throw new LibraryOperationError("search_integrity_failure");
              }
              return {
                failureCode: existing.failureCode as LibraryOperationFailureCode,
                kind: "failure" as const,
              };
            }
            if (existing.state === "succeeded" && existing.responseJson) {
              return {
                kind: "replay" as const,
                response: libraryMutationResponseSchema.parse(JSON.parse(existing.responseJson)),
              };
            }
            throw new LibraryOperationError("search_integrity_failure");
          }
          const count = this.#database.sqlite
            .prepare("select count(*) as count from library_mutation_operations where user_id = ?")
            .get(userId) as { count: number };
          if (count.count >= MAX_OPERATIONS_PER_USER) {
            throw new LibraryOperationError("operation_limit_reached");
          }
          const operationId = this.#operationId();
          this.#database.sqlite
            .prepare(
              `insert into library_mutation_operations (
                 id, user_id, kind, reference_id, idempotency_key_hash,
                 fingerprint_hash, state, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(operationId, userId, kind, referenceId, keyHash, fingerprintHash, now, now);
          return { kind: "reserved" as const, operationId };
        })
        .immediate();
    } catch (error) {
      if (error instanceof LibraryOperationError) throw error;
      throw new LibraryOperationError("storage_failure", { cause: error });
    }
  }

  #complete(
    operationId: string,
    kind: MutationKind,
    referenceId: string | null,
    outcome: "success" | "failure",
    response: LibraryMutationResponse | null,
    failureCode: LibraryOperationFailureCode | null,
    metadata: Record<string, unknown>,
    context: LibraryOperationContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite
        .transaction(() => {
          const updated = this.#database.sqlite
            .prepare(
              `update library_mutation_operations
               set state = ?, response_json = ?, failure_code = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(
              outcome === "success" ? "succeeded" : "failed",
              response ? JSON.stringify(response) : null,
              failureCode,
              now,
              now,
              operationId,
            );
          if (updated.changes !== 1) {
            throw new LibraryOperationError("search_integrity_failure");
          }
          this.#audit(
            mutationEvent(kind, outcome),
            outcome,
            operationId,
            {
              ...(failureCode ? { failureCode } : {}),
              kind,
              ...(referenceId ? { referenceId } : {}),
              ...metadata,
            },
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof LibraryOperationError) throw error;
      throw new LibraryOperationError("storage_failure", { cause: error });
    }
  }

  #pruneArtworkSearches(userId: string, now: number) {
    this.#database.sqlite
      .prepare("delete from library_artwork_searches where expires_at <= ?")
      .run(now);
    this.#database.sqlite
      .prepare(
        `delete from library_artwork_searches
         where id in (
           select id from library_artwork_searches
           where user_id = ?
           order by created_at asc, id asc
           limit max(0, (select count(*) from library_artwork_searches where user_id = ?) - ?)
         )`,
      )
      .run(userId, userId, MAX_ACTIVE_ARTWORK_SEARCHES - 1);
  }

  #pruneOperations(userId: string, now: number) {
    this.#database.sqlite
      .prepare(
        `update library_mutation_operations
         set state = 'failed', failure_code = 'temporarily_unavailable',
             completed_at = ?, updated_at = ?
         where user_id = ? and state = 'pending' and created_at <= ?`,
      )
      .run(now, now, userId, now - STALE_PENDING_OPERATION_MS);
    this.#database.sqlite
      .prepare(
        `delete from library_mutation_operations
         where user_id = ? and state <> 'pending' and completed_at <= ?`,
      )
      .run(userId, now - OPERATION_RETENTION_MS);
  }

  #artworkSearchId() {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const parsed = libraryArtworkSearchIdSchema.safeParse(
        `library_artwork_search_${this.#createSearchToken()}`,
      );
      if (!parsed.success) throw new LibraryOperationError("search_integrity_failure");
      const exists = this.#database.sqlite
        .prepare("select 1 from library_artwork_searches where id = ? limit 1")
        .get(parsed.data);
      if (!exists) return parsed.data;
    }
    throw new LibraryOperationError("search_integrity_failure");
  }

  #operationId() {
    const parsed = libraryOperationIdSchema.safeParse(
      `library_operation_${this.#createOperationToken()}`,
    );
    if (!parsed.success) throw new LibraryOperationError("search_integrity_failure");
    return parsed.data;
  }

  #audit(
    eventType: string,
    outcome: "success" | "failure",
    targetId: string,
    metadata: Record<string, unknown>,
    context: LibraryOperationContext,
    createdAt: number,
  ) {
    const auditId = this.#createAuditId();
    if (!IDENTIFIER_PATTERN.test(auditId)) {
      throw new LibraryOperationError("search_integrity_failure");
    }
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method,
           event_type, outcome, target_type, target_id, request_id,
           metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, ?, ?, 'library_operation', ?, ?, ?, ?, ?)`,
      )
      .run(
        auditId,
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        eventType,
        outcome,
        targetId,
        context.requestId ?? null,
        JSON.stringify(metadata),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #now() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new LibraryOperationError("search_integrity_failure");
    }
    return value;
  }
}
