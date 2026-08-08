import {
  BazarrAdapter,
  BazarrTargetError,
  type BazarrSubtitleCandidate,
  type BazarrSubtitleSearchResult,
  type BazarrSubtitleTarget,
} from "@omnifin/connectors/adapters/bazarr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
  type ConnectorCapability,
} from "@omnifin/contracts/connectors";
import { mediaReferenceIdSchema } from "@omnifin/contracts/dashboard";
import {
  subtitleCandidateSchema,
  subtitleDownloadIdempotencyKeySchema,
  subtitleDownloadResponseSchema,
  subtitleMediaTargetSchema,
  subtitleResultIdSchema,
  subtitleSearchIdSchema,
  subtitleSearchResponseSchema,
  type SubtitleDownloadResponse,
  type SubtitleMediaTarget,
  type SubtitleSearchResponse,
} from "@omnifin/contracts/subtitles";
import { createHmac, randomUUID, X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import {
  ExternalMutationJournal,
  ExternalMutationJournalError,
  type ExternalMutationRecord,
  type JsonValue,
} from "../operations/external-mutation-journal.js";
import { EnvelopeCipher, hashToken, privacyHash, randomToken } from "../security/crypto.js";
import {
  MediaReferenceError,
  MediaReferenceService,
  type MediaReferenceDependencies,
} from "../media/media-reference-service.js";

const SEARCH_TTL_MS = 20 * 60 * 1_000;
const MAX_ACTIVE_SEARCHES_PER_USER = 20;
const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const STALE_PENDING_OPERATION_MS = 5 * 60 * 1_000;
const DISPATCH_LEASE_MS = 30_000;
const MAX_OPERATIONS_PER_USER = 4_096;
const MAX_ID_ATTEMPTS = 8;
const MAX_ENCRYPTED_SEARCH_BYTES = 4_194_304;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const storedTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("movie"), radarrId: z.int().positive().max(2_147_483_647) }),
  z.strictObject({
    episodeId: z.int().positive().max(2_147_483_647),
    kind: z.literal("episode"),
    seriesId: z.int().positive().max(2_147_483_647),
  }),
]);

const storedCandidateSchema = subtitleCandidateSchema.extend({
  subtitleToken: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
});

const storedSearchPayloadSchema = z
  .strictObject({
    candidates: z.array(storedCandidateSchema).max(100),
    media: subtitleMediaTargetSchema,
    schemaVersion: z.literal(1),
    target: storedTargetSchema,
  })
  .refine((payload) => payload.media.kind === payload.target.kind, {
    message: "The stored Bazarr target must match the media kind.",
    path: ["target", "kind"],
  });
type StoredSearchPayload = z.infer<typeof storedSearchPayloadSchema>;

interface BazarrConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  configGeneration: number;
  displayName: string;
  encryptedCredentials: string;
  healthState: string;
  id: string;
  insecureHttpApproved: number;
  instanceGeneration: number;
  tlsPolicy: string;
  type: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

interface MediaReferenceRow {
  currentLinkRevision: number;
  healthState: string;
  linkRevision: number;
  serviceIdentityLinkId: string;
}

interface SubtitleSearchRow {
  connectorId: string;
  connectorInstanceGeneration: number;
  currentLinkRevision: number;
  encryptedPayload: string;
  expiresAt: number;
  linkRevision: number;
  serviceIdentityLinkId: string;
}

interface DownloadOperationRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  responseJson: string | null;
  state: string;
  updatedAt: number;
}

interface SubtitleDownloadSelection {
  candidate: BazarrSubtitleCandidate;
  connectorId: string;
  connectorInstanceGeneration: number;
  payload: StoredSearchPayload;
}

export interface SubtitleAdapter {
  downloadSubtitle(
    target: BazarrSubtitleTarget,
    candidate: BazarrSubtitleCandidate,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<void>;
  searchSubtitles(
    input: SubtitleMediaTarget,
    signal?: AbortSignal,
  ): Promise<BazarrSubtitleSearchResult>;
}

export interface SubtitleOperationContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface SubtitleOperationDependencies {
  clock?: () => Date;
  createAdapter?: (config: ApiKeyConnectorConfig) => SubtitleAdapter;
  createAuditId?: () => string;
  createDispatchId?: () => string;
  createLeaseOwner?: () => string;
  createOperationToken?: () => string;
  createResultToken?: () => string;
  createSearchToken?: () => string;
  mediaReferences?: MediaReferenceDependencies;
}

export interface SubtitleDownloadResult {
  download: SubtitleDownloadResponse;
  replayed: boolean;
}

export type SubtitleDownloadFailureCode =
  | "configuration_unavailable"
  | "rate_limited"
  | "response_invalid"
  | "search_expired"
  | "temporarily_unavailable";

const DOWNLOAD_FAILURE_CODES = new Set<SubtitleDownloadFailureCode>([
  "configuration_unavailable",
  "rate_limited",
  "response_invalid",
  "search_expired",
  "temporarily_unavailable",
]);

export type SubtitleOperationErrorReason =
  | SubtitleDownloadFailureCode
  | "connector_ambiguous"
  | "connector_integrity_failure"
  | "connector_unconfigured"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_required"
  | "media_not_found"
  | "media_unsupported"
  | "operation_limit_reached"
  | "outcome_uncertain"
  | "storage_failure"
  | "target_ambiguous"
  | "target_not_found";

export class SubtitleOperationError extends Error {
  public readonly reason: SubtitleOperationErrorReason;

  public constructor(reason: SubtitleOperationErrorReason, options?: ErrorOptions) {
    super("The subtitle operation could not be completed.", options);
    this.name = "SubtitleOperationError";
    this.reason = reason;
  }
}

function connectorCredentialContext(connectorId: string) {
  return `connector_credentials:bazarr:${connectorId}`;
}

function searchPayloadContext(searchId: string) {
  return `subtitle_search:${searchId}`;
}

function connectorSecrets(
  row: BazarrConnectorRow,
  cipher: EnvelopeCipher,
): { apiKey: string; tlsCaCertificatePem?: string } {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, connectorCredentialContext(row.id)),
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
    throw new SubtitleOperationError("connector_integrity_failure", { cause: error });
  }
}

function hasSubtitleCapabilities(row: BazarrConnectorRow) {
  try {
    const decoded = JSON.parse(row.capabilitySnapshotJson) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const record = decoded as Record<string, unknown>;
    if (record.schemaVersion !== 1) return false;
    const health = connectorHealthSchema.safeParse(record.health);
    return (
      health.success &&
      health.data.connectorId === row.id &&
      health.data.service === "bazarr" &&
      health.data.status === "healthy" &&
      row.healthState === "healthy" &&
      (["subtitle.search", "subtitle.download"] satisfies ConnectorCapability[]).every(
        (capability) => health.data.capabilities.includes(capability),
      )
    );
  } catch {
    return false;
  }
}

function publicCandidate(candidate: z.infer<typeof storedCandidateSchema>) {
  return subtitleCandidateSchema.parse({
    dontMatches: candidate.dontMatches,
    forced: candidate.forced,
    hearingImpaired: candidate.hearingImpaired,
    id: candidate.id,
    language: candidate.language,
    matches: candidate.matches,
    originalFormat: candidate.originalFormat,
    provider: candidate.provider,
    releaseNames: candidate.releaseNames,
    score: candidate.score,
    uploader: candidate.uploader,
  });
}

function downloadCandidate(
  candidate: z.infer<typeof storedCandidateSchema>,
): BazarrSubtitleCandidate {
  return {
    dontMatches: candidate.dontMatches,
    forced: candidate.forced,
    hearingImpaired: candidate.hearingImpaired,
    language: candidate.language,
    matches: candidate.matches,
    originalFormat: candidate.originalFormat,
    provider: candidate.provider,
    releaseNames: candidate.releaseNames,
    score: candidate.score,
    subtitleToken: candidate.subtitleToken,
    uploader: candidate.uploader,
  };
}

function knownDownloadFailure(error: unknown): SubtitleDownloadFailureCode {
  if (error instanceof SubtitleOperationError) {
    return DOWNLOAD_FAILURE_CODES.has(error.reason as SubtitleDownloadFailureCode)
      ? (error.reason as SubtitleDownloadFailureCode)
      : "configuration_unavailable";
  }
  if (error instanceof SafeConnectorError) {
    if (error.code === "rate_limited") return "rate_limited";
    if (error.code === "response_invalid" || error.code === "unsupported_version") {
      return "response_invalid";
    }
    if (
      error.code === "configuration_invalid" ||
      error.code === "destination_blocked" ||
      error.code === "invalid_credentials"
    ) {
      return "configuration_unavailable";
    }
  }
  return "temporarily_unavailable";
}

function ambiguousDispatchFailure(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof SafeConnectorError)) return true;
  if (["response_invalid", "timeout", "unreachable"].includes(error.code)) return true;
  return error.code === "upstream_error" && (error.status === null || error.status >= 500);
}

function mutationTargetDigest(value: unknown, key: Buffer) {
  return createHmac("sha256", key)
    .update("omnifin:v1:external-mutation-target\0", "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("base64url");
}

function defaultAdapter(config: ApiKeyConnectorConfig) {
  return new BazarrAdapter(config);
}

export class SubtitleOperationService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<SubtitleOperationDependencies["createAdapter"]>;
  readonly #createAuditId: () => string;
  readonly #createDispatchId: () => string;
  readonly #createLeaseOwner: () => string;
  readonly #createOperationToken: () => string;
  readonly #createResultToken: () => string;
  readonly #createSearchToken: () => string;
  readonly #database: DatabaseHandle;
  readonly #journal: ExternalMutationJournal;
  readonly #references: MediaReferenceService;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: SubtitleOperationDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapter;
    this.#createAuditId = dependencies.createAuditId ?? randomUUID;
    this.#createDispatchId =
      dependencies.createDispatchId ?? (() => `mutation_dispatch_${randomToken(16)}`);
    this.#createLeaseOwner =
      dependencies.createLeaseOwner ?? (() => `mutation_lease_${randomToken(16)}`);
    this.#createOperationToken = dependencies.createOperationToken ?? (() => randomToken(16));
    this.#createResultToken = dependencies.createResultToken ?? (() => randomToken(16));
    this.#createSearchToken = dependencies.createSearchToken ?? (() => randomToken(16));
    this.#references = new MediaReferenceService(database, config, dependencies.mediaReferences);
    this.#journal = new ExternalMutationJournal(database.sqlite, config.encryptionKey);
  }

  public async search(
    rawReferenceId: string,
    context: SubtitleOperationContext,
    signal?: AbortSignal,
  ): Promise<SubtitleSearchResponse> {
    const principal = this.#activePrincipal(context);
    const { media, referenceId, serviceIdentityLinkId, linkRevision } = this.#mediaTarget(
      rawReferenceId,
      principal,
    );
    const { adapter, row } = this.#adapter();
    let result: BazarrSubtitleSearchResult;
    try {
      result = await adapter.searchSubtitles(media, signal);
    } catch (error) {
      if (error instanceof BazarrTargetError) {
        throw new SubtitleOperationError(
          error.reason === "ambiguous" ? "target_ambiguous" : "target_not_found",
          { cause: error },
        );
      }
      throw error;
    }
    const now = this.#now();
    const expiresAt = now + SEARCH_TTL_MS;
    const searchId = this.#searchId();
    const seen = new Set<string>();
    const candidates = result.candidates.map((candidate) => {
      let id: string | undefined;
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
        const parsed = subtitleResultIdSchema.safeParse(
          `subtitle_result_${this.#createResultToken()}`,
        );
        if (!parsed.success) throw new SubtitleOperationError("connector_integrity_failure");
        if (!seen.has(parsed.data)) {
          id = parsed.data;
          seen.add(id);
          break;
        }
      }
      if (!id) throw new SubtitleOperationError("connector_integrity_failure");
      const parsedCandidate = storedCandidateSchema.safeParse({ ...candidate, id });
      if (!parsedCandidate.success) throw new SubtitleOperationError("response_invalid");
      return parsedCandidate.data;
    });
    const parsedPayload = storedSearchPayloadSchema.safeParse({
      candidates,
      media,
      schemaVersion: 1,
      target: result.target,
    });
    if (!parsedPayload.success) throw new SubtitleOperationError("response_invalid");
    const payload = parsedPayload.data;
    const encryptedPayload = this.#cipher.encrypt(
      JSON.stringify(payload),
      searchPayloadContext(searchId),
    );
    if (Buffer.byteLength(encryptedPayload, "utf8") > MAX_ENCRYPTED_SEARCH_BYTES) {
      throw new SubtitleOperationError("response_invalid");
    }
    try {
      this.#database.sqlite
        .transaction(() => {
          this.#pruneSearches(principal.userId, now);
          this.#database.sqlite
            .prepare(
              `insert into subtitle_searches (
                 id, user_id, service_identity_link_id, link_revision, media_reference_id,
                 connector_id, connector_instance_generation, encrypted_payload,
                 expires_at, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              searchId,
              principal.userId,
              serviceIdentityLinkId,
              linkRevision,
              referenceId,
              row.id,
              row.instanceGeneration,
              encryptedPayload,
              expiresAt,
              now,
              now,
            );
          this.#audit(
            "subtitle.search.completed",
            "success",
            searchId,
            {
              connectorId: row.id,
              mediaKind: media.kind,
              mediaReferenceId: referenceId,
              resultCount: candidates.length,
            },
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof SubtitleOperationError) throw error;
      throw new SubtitleOperationError("storage_failure", { cause: error });
    }

    return subtitleSearchResponseSchema.parse({
      expiresAt: new Date(expiresAt).toISOString(),
      generatedAt: new Date(now).toISOString(),
      media,
      results: candidates.map(publicCandidate),
      searchId,
    });
  }

  public async download(
    rawSearchId: string,
    rawResultId: string,
    rawIdempotencyKey: string,
    context: SubtitleOperationContext,
    signal?: AbortSignal,
  ): Promise<SubtitleDownloadResult> {
    const principal = this.#activePrincipal(context);
    const searchId = subtitleSearchIdSchema.parse(rawSearchId);
    const resultId = subtitleResultIdSchema.parse(rawResultId);
    const idempotencyKey = subtitleDownloadIdempotencyKeySchema.parse(rawIdempotencyKey);
    const fingerprintHash = hashToken(`${searchId}\0${resultId}`);
    const keyHash = hashToken(`${principal.userId}\0${idempotencyKey}`);
    const reservation = this.#reserve(
      principal.userId,
      searchId,
      resultId,
      keyHash,
      fingerprintHash,
    );
    if (reservation.kind === "replay") return { download: reservation.response, replayed: true };
    if (reservation.kind === "failure") {
      throw new SubtitleOperationError(reservation.failureCode);
    }
    if (reservation.kind === "uncertain") throw new SubtitleOperationError("outcome_uncertain");
    if (reservation.kind === "conflict") throw new SubtitleOperationError("idempotency_conflict");
    if (reservation.kind === "pending") {
      const priorDispatch = this.#journal.replay({
        kind: "subtitle.download",
        parentOperationId: reservation.operationId,
        parentOperationType: "subtitle_download_operation",
      });
      if (priorDispatch && ["dispatched", "reconcile_required"].includes(priorDispatch.state)) {
        this.#complete(
          reservation.operationId,
          "uncertain",
          null,
          "outcome_uncertain",
          priorDispatch.connectorId,
          searchId,
          resultId,
          context,
          priorDispatch.id,
        );
        throw new SubtitleOperationError("outcome_uncertain");
      }
      if (
        reservation.updatedAt + STALE_PENDING_OPERATION_MS > this.#now() ||
        (priorDispatch &&
          (priorDispatch.state !== "reserved" || priorDispatch.leaseExpiresAt! >= this.#now()))
      ) {
        throw new SubtitleOperationError("idempotency_in_progress");
      }
    }

    let connectorId: string | undefined;
    let dispatch: ExternalMutationRecord | undefined;
    let crossedDispatchBoundary = false;
    try {
      const stored = this.#candidate(principal, searchId, resultId);
      connectorId = stored.connectorId;
      const { adapter, row } = this.#adapter(connectorId);
      if (row.instanceGeneration !== stored.connectorInstanceGeneration) {
        throw new SubtitleOperationError("search_expired");
      }
      dispatch = this.#reserveDispatch(reservation.operationId, principal.userId, stored, row);
      this.#journal.markDispatched({
        id: dispatch.id,
        leaseOwner: dispatch.leaseOwner!,
        now: this.#now(),
      });
      crossedDispatchBoundary = true;
      await adapter.downloadSubtitle(stored.payload.target, stored.candidate, signal, dispatch.id);
    } catch (error) {
      if (crossedDispatchBoundary && dispatch && ambiguousDispatchFailure(error)) {
        this.#complete(
          reservation.operationId,
          "uncertain",
          null,
          "outcome_uncertain",
          connectorId,
          searchId,
          resultId,
          context,
          dispatch.id,
        );
        throw new SubtitleOperationError("outcome_uncertain", { cause: error });
      }
      if (error instanceof SubtitleOperationError && error.reason === "outcome_uncertain") {
        this.#complete(
          reservation.operationId,
          "uncertain",
          null,
          "outcome_uncertain",
          connectorId,
          searchId,
          resultId,
          context,
        );
        throw error;
      }
      const failureCode = knownDownloadFailure(error);
      const reservedDispatch = this.#journal.replay({
        kind: "subtitle.download",
        parentOperationId: reservation.operationId,
        parentOperationType: "subtitle_download_operation",
      });
      this.#complete(
        reservation.operationId,
        "failure",
        null,
        failureCode,
        connectorId,
        searchId,
        resultId,
        context,
        dispatch?.id ?? (reservedDispatch?.state === "reserved" ? reservedDispatch.id : undefined),
      );
      throw new SubtitleOperationError(failureCode, { cause: error });
    }

    const response = subtitleDownloadResponseSchema.parse({
      acceptedAt: new Date(this.#now()).toISOString(),
      resultId,
      searchId,
      status: "accepted",
    });
    this.#complete(
      reservation.operationId,
      "success",
      response,
      null,
      connectorId,
      searchId,
      resultId,
      context,
      dispatch!.id,
    );
    return { download: response, replayed: false };
  }

  #activePrincipal(context: SubtitleOperationContext) {
    const principal = requirePermission(context.principal, "library.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new SubtitleOperationError("identity_required");
    }
    return principal as SessionPrincipal & { userId: string };
  }

  #mediaTarget(referenceId: string, principal: SessionPrincipal & { userId: string }) {
    const parsedReferenceId = mediaReferenceIdSchema.safeParse(referenceId);
    if (!parsedReferenceId.success) throw new SubtitleOperationError("media_not_found");
    referenceId = parsedReferenceId.data;
    let row: MediaReferenceRow | undefined;
    try {
      row = this.#database.sqlite
        .prepare(
          `select
             media_references.service_identity_link_id as serviceIdentityLinkId,
             media_references.link_revision as linkRevision,
             service_identity_links.revision as currentLinkRevision,
             service_identity_links.health_state as healthState
           from media_references
           inner join service_identity_links
             on service_identity_links.id = media_references.service_identity_link_id
            and service_identity_links.user_id = media_references.user_id
           where media_references.id = ? and media_references.user_id = ?
           limit 1`,
        )
        .get(referenceId, principal.userId) as MediaReferenceRow | undefined;
    } catch (error) {
      throw new SubtitleOperationError("storage_failure", { cause: error });
    }
    const principalLink = row
      ? principal.linkedServices.find(
          (link) =>
            link.id === row!.serviceIdentityLinkId &&
            link.service === "jellyfin" &&
            ["linked", "unavailable"].includes(link.health),
        )
      : undefined;
    if (
      !row ||
      !principalLink ||
      row.currentLinkRevision !== row.linkRevision ||
      !["linked", "unavailable"].includes(row.healthState)
    ) {
      throw new SubtitleOperationError("media_not_found");
    }
    let reference;
    try {
      reference = this.#references.resolve(
        {
          linkId: row.serviceIdentityLinkId,
          linkRevision: row.linkRevision,
          userId: principal.userId,
        },
        referenceId,
      );
    } catch (error) {
      if (error instanceof MediaReferenceError) {
        throw new SubtitleOperationError("media_not_found", { cause: error });
      }
      throw error;
    }
    if (reference.kind === "movie" && reference.title) {
      return {
        linkRevision: row.linkRevision,
        media: subtitleMediaTargetSchema.parse({
          kind: "movie",
          title: reference.title,
          year: reference.year,
        }),
        referenceId,
        serviceIdentityLinkId: row.serviceIdentityLinkId,
      };
    }
    if (
      reference.kind === "episode" &&
      reference.title &&
      reference.seasonNumber !== null &&
      reference.episodeNumber !== null
    ) {
      return {
        linkRevision: row.linkRevision,
        media: subtitleMediaTargetSchema.parse({
          episodeNumber: reference.episodeNumber,
          kind: "episode",
          seasonNumber: reference.seasonNumber,
          title: reference.title,
          year: reference.year,
        }),
        referenceId,
        serviceIdentityLinkId: row.serviceIdentityLinkId,
      };
    }
    throw new SubtitleOperationError("media_unsupported");
  }

  #candidate(principal: SessionPrincipal & { userId: string }, searchId: string, resultId: string) {
    const now = this.#now();
    let row: SubtitleSearchRow | undefined;
    try {
      row = this.#database.sqlite
        .prepare(
          `select
             subtitle_searches.connector_id as connectorId,
             subtitle_searches.connector_instance_generation as connectorInstanceGeneration,
             subtitle_searches.encrypted_payload as encryptedPayload,
             subtitle_searches.expires_at as expiresAt,
             subtitle_searches.service_identity_link_id as serviceIdentityLinkId,
             subtitle_searches.link_revision as linkRevision,
             service_identity_links.revision as currentLinkRevision
           from subtitle_searches
           inner join service_identity_links
             on service_identity_links.id = subtitle_searches.service_identity_link_id
            and service_identity_links.user_id = subtitle_searches.user_id
           where subtitle_searches.id = ? and subtitle_searches.user_id = ?
           limit 1`,
        )
        .get(searchId, principal.userId) as SubtitleSearchRow | undefined;
    } catch (error) {
      throw new SubtitleOperationError("storage_failure", { cause: error });
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
      throw new SubtitleOperationError("search_expired");
    }
    let payload: StoredSearchPayload;
    try {
      payload = storedSearchPayloadSchema.parse(
        JSON.parse(this.#cipher.decrypt(row.encryptedPayload, searchPayloadContext(searchId))),
      );
    } catch (error) {
      throw new SubtitleOperationError("configuration_unavailable", { cause: error });
    }
    const candidate = payload.candidates.find(({ id }) => id === resultId);
    if (!candidate) throw new SubtitleOperationError("search_expired");
    return {
      candidate: downloadCandidate(candidate),
      connectorId: row.connectorId,
      connectorInstanceGeneration: row.connectorInstanceGeneration,
      payload,
    };
  }

  #adapter(expectedConnectorId?: string) {
    const row = this.#connector(expectedConnectorId);
    const secrets = connectorSecrets(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      row.type !== "bazarr" ||
      !IDENTIFIER_PATTERN.test(row.id) ||
      !row.displayName.trim() ||
      row.displayName.length > 160 ||
      !hasSubtitleCapabilities(row)
    ) {
      throw new SubtitleOperationError("connector_integrity_failure");
    }
    try {
      return {
        adapter: this.#createAdapter({
          apiKey: secrets.apiKey,
          baseUrl: row.baseUrl,
          clock: { monotonicNow: () => performance.now(), now: this.#clock },
          connectorId: row.id,
          displayName: row.displayName,
          insecureHttpApproved: row.insecureHttpApproved === 1,
          tlsPolicy,
          ...(secrets.tlsCaCertificatePem === undefined
            ? {}
            : { tlsCaCertificatePem: secrets.tlsCaCertificatePem }),
        }),
        row,
      };
    } catch (error) {
      if (error instanceof SubtitleOperationError) throw error;
      throw new SubtitleOperationError("connector_integrity_failure", { cause: error });
    }
  }

  #connector(expectedConnectorId?: string) {
    try {
      const rows = this.#database.sqlite
        .prepare(
          `select id, type, display_name as displayName, base_url as baseUrl,
                  encrypted_credentials as encryptedCredentials,
                  capability_snapshot_json as capabilitySnapshotJson,
                  health_state as healthState, tls_policy as tlsPolicy,
                  insecure_http_approved as insecureHttpApproved,
                  instance_generation as instanceGeneration,
                  config_generation as configGeneration
           from connector_configs
           where type = 'bazarr' and enabled = 1 and (? is null or id = ?)
           order by id asc
           limit 2`,
        )
        .all(expectedConnectorId ?? null, expectedConnectorId ?? null) as BazarrConnectorRow[];
      if (rows.length === 0) {
        throw new SubtitleOperationError(
          expectedConnectorId ? "configuration_unavailable" : "connector_unconfigured",
        );
      }
      if (rows.length > 1) throw new SubtitleOperationError("connector_ambiguous");
      return rows[0]!;
    } catch (error) {
      if (error instanceof SubtitleOperationError) throw error;
      throw new SubtitleOperationError("storage_failure", { cause: error });
    }
  }

  #reserveDispatch(
    operationId: string,
    userId: string,
    stored: SubtitleDownloadSelection,
    row: BazarrConnectorRow,
  ) {
    const existing = this.#journal.replay({
      kind: "subtitle.download",
      parentOperationId: operationId,
      parentOperationType: "subtitle_download_operation",
    });
    const now = this.#now();
    const leaseOwner = this.#createLeaseOwner();
    if (existing) {
      if (
        existing.state !== "reserved" ||
        existing.connectorId !== row.id ||
        existing.connectorInstanceGeneration !== row.instanceGeneration ||
        existing.connectorConfigGeneration !== row.configGeneration
      ) {
        throw new SubtitleOperationError(
          existing.state === "uncertain" || existing.state === "reconcile_required"
            ? "outcome_uncertain"
            : "connector_integrity_failure",
        );
      }
      if (existing.leaseExpiresAt! >= now) {
        throw new SubtitleOperationError("idempotency_in_progress");
      }
      return this.#journal.claimStaleReserved({
        expectedLeaseExpiresAt: existing.leaseExpiresAt!,
        expectedLeaseOwner: existing.leaseOwner!,
        id: existing.id,
        leaseExpiresAt: now + DISPATCH_LEASE_MS,
        leaseOwner,
        now,
      });
    }
    try {
      return this.#journal.reserve({
        connectorConfigGeneration: row.configGeneration,
        connectorId: row.id,
        connectorInstanceGeneration: row.instanceGeneration,
        id: this.#createDispatchId(),
        kind: "subtitle.download",
        leaseExpiresAt: now + DISPATCH_LEASE_MS,
        leaseOwner,
        normalizedRequest: JSON.parse(
          JSON.stringify({
            action: "subtitle_download",
            candidate: stored.candidate,
            target: stored.payload.target,
          }),
        ) as JsonValue,
        now,
        parentOperationId: operationId,
        parentOperationType: "subtitle_download_operation",
        targetDigest: mutationTargetDigest(
          {
            action: "subtitle_download",
            candidate: stored.candidate,
            connectorId: row.id,
            connectorInstanceGeneration: row.instanceGeneration,
            target: stored.payload.target,
          },
          this.#config.encryptionKey,
        ),
        userId,
      });
    } catch (error) {
      if (error instanceof ExternalMutationJournalError && error.code === "target_locked") {
        throw new SubtitleOperationError("outcome_uncertain", { cause: error });
      }
      throw error;
    }
  }

  #reserve(
    userId: string,
    searchId: string,
    resultId: string,
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
              `select id, fingerprint_hash as fingerprintHash, state,
                      response_json as responseJson, failure_code as failureCode,
                      updated_at as updatedAt
               from subtitle_download_operations
               where user_id = ? and idempotency_key_hash = ?
               limit 1`,
            )
            .get(userId, keyHash) as DownloadOperationRow | undefined;
          if (existing) {
            if (existing.fingerprintHash !== fingerprintHash) return { kind: "conflict" as const };
            if (existing.state === "pending") {
              return {
                kind: "pending" as const,
                operationId: existing.id,
                updatedAt: existing.updatedAt,
              };
            }
            if (existing.state === "uncertain" || existing.state === "reconcile_required") {
              return { kind: "uncertain" as const };
            }
            if (existing.state === "failed") {
              if (
                !existing.failureCode ||
                !DOWNLOAD_FAILURE_CODES.has(existing.failureCode as SubtitleDownloadFailureCode)
              ) {
                throw new SubtitleOperationError("connector_integrity_failure");
              }
              return {
                failureCode: existing.failureCode as SubtitleDownloadFailureCode,
                kind: "failure" as const,
              };
            }
            if (existing.state === "succeeded" && existing.responseJson) {
              return {
                kind: "replay" as const,
                response: subtitleDownloadResponseSchema.parse(JSON.parse(existing.responseJson)),
              };
            }
            throw new SubtitleOperationError("connector_integrity_failure");
          }
          const count = this.#database.sqlite
            .prepare("select count(*) as count from subtitle_download_operations where user_id = ?")
            .get(userId) as { count: number };
          if (count.count >= MAX_OPERATIONS_PER_USER) {
            throw new SubtitleOperationError("operation_limit_reached");
          }
          const operationId = this.#operationId();
          this.#database.sqlite
            .prepare(
              `insert into subtitle_download_operations (
                 id, user_id, search_id, result_id, idempotency_key_hash,
                 fingerprint_hash, state, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(operationId, userId, searchId, resultId, keyHash, fingerprintHash, now, now);
          return { kind: "reserved" as const, operationId };
        })
        .immediate();
    } catch (error) {
      if (error instanceof SubtitleOperationError) throw error;
      throw new SubtitleOperationError("storage_failure", { cause: error });
    }
  }

  #complete(
    operationId: string,
    outcome: "success" | "failure" | "uncertain",
    response: SubtitleDownloadResponse | null,
    failureCode: SubtitleDownloadFailureCode | "outcome_uncertain" | null,
    connectorId: string | undefined,
    searchId: string,
    resultId: string,
    context: SubtitleOperationContext,
    dispatchId?: string,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite
        .transaction(() => {
          if (dispatchId) {
            if (outcome === "success") {
              this.#journal.completeSucceeded({ id: dispatchId, now });
            } else if (outcome === "uncertain") {
              this.#journal.completeUncertain({
                failureCode: "outcome_uncertain",
                id: dispatchId,
                now,
              });
            } else {
              this.#journal.completeFailed({ failureCode: failureCode!, id: dispatchId, now });
            }
          }
          const updated = this.#database.sqlite
            .prepare(
              `update subtitle_download_operations
               set state = ?, response_json = ?, failure_code = ?, completed_at = ?, updated_at = ?
               where id = ? and state = 'pending'`,
            )
            .run(
              outcome === "success" ? "succeeded" : outcome === "failure" ? "failed" : "uncertain",
              response ? JSON.stringify(response) : null,
              failureCode,
              now,
              now,
              operationId,
            );
          if (updated.changes !== 1) {
            throw new SubtitleOperationError("connector_integrity_failure");
          }
          this.#audit(
            outcome === "success" ? "subtitle.download.accepted" : "subtitle.download.failed",
            outcome === "success" ? "success" : "failure",
            operationId,
            {
              ...(connectorId ? { connectorId } : {}),
              ...(failureCode ? { failureCode } : {}),
              resultId,
              searchId,
            },
            context,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof SubtitleOperationError) throw error;
      throw new SubtitleOperationError("storage_failure", { cause: error });
    }
  }

  #pruneSearches(userId: string, now: number) {
    this.#database.sqlite.prepare("delete from subtitle_searches where expires_at <= ?").run(now);
    this.#database.sqlite
      .prepare(
        `delete from subtitle_searches
         where id in (
           select id from subtitle_searches
           where user_id = ?
           order by created_at asc, id asc
           limit max(0, (select count(*) from subtitle_searches where user_id = ?) - ?)
         )`,
      )
      .run(userId, userId, MAX_ACTIVE_SEARCHES_PER_USER - 1);
  }

  #pruneOperations(userId: string, now: number) {
    const cleanup = this.#journal.cleanupTerminalParents({
      completedBefore: now - OPERATION_RETENTION_MS,
      limit: 100,
      parentOperationType: "subtitle_download_operation",
      userId,
    });
    if (cleanup.mismatchedParents > 0) throw new SubtitleOperationError("storage_failure");
  }

  #searchId() {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const candidate = subtitleSearchIdSchema.safeParse(
        `subtitle_search_${this.#createSearchToken()}`,
      );
      if (!candidate.success) throw new SubtitleOperationError("connector_integrity_failure");
      const exists = this.#database.sqlite
        .prepare("select 1 from subtitle_searches where id = ? limit 1")
        .get(candidate.data);
      if (!exists) return candidate.data;
    }
    throw new SubtitleOperationError("connector_integrity_failure");
  }

  #operationId() {
    const value = `subtitle_download_${this.#createOperationToken()}`;
    if (!/^subtitle_download_[A-Za-z0-9_-]{22}$/u.test(value)) {
      throw new SubtitleOperationError("connector_integrity_failure");
    }
    return value;
  }

  #audit(
    eventType: string,
    outcome: "success" | "failure",
    targetId: string,
    metadata: Record<string, unknown>,
    context: SubtitleOperationContext,
    createdAt: number,
  ) {
    const auditId = this.#createAuditId();
    if (!IDENTIFIER_PATTERN.test(auditId)) {
      throw new SubtitleOperationError("connector_integrity_failure");
    }
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id, actor_user_id, actor_session_id, actor_auth_method,
           event_type, outcome, target_type, target_id, request_id,
           metadata_json, ip_hash, created_at
         ) values (?, ?, ?, ?, ?, ?, 'subtitle_operation', ?, ?, ?, ?, ?)`,
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
      throw new SubtitleOperationError("connector_integrity_failure");
    }
    return value;
  }
}
