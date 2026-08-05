import {
  SeerrAdapter,
  SeerrRequestError,
  type SeerrRequestRouting,
  type SeerrRequestAuthorization,
  type SeerrRequestRoutingCatalog,
  type SeerrUserIdentity,
} from "@omnifin/connectors/adapters/seerr";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { OptionalApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
} from "@omnifin/contracts/connectors";
import {
  idempotencyKeySchema,
  mediaRequestInputSchema,
  mediaRequestResponseSchema,
  mediaRequestRoutingOptionsQuerySchema,
  mediaRequestRoutingOptionsResponseSchema,
  mediaRequestRoutingPreferenceInputSchema,
  type MediaRequestInput,
  type MediaRequestResponse,
  type MediaRequestRoutingOptionsQuery,
  type MediaRequestRoutingOptionsResponse,
  type MediaRequestRoutingPreferenceInput,
  type MediaRequestRoutingSelection,
} from "@omnifin/contracts/requests";
import { randomUUID, X509Certificate } from "node:crypto";
import { z } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, hashToken, privacyHash } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REQUEST_ROUTING_REFERENCE_PREFIX = "routing-v1.";
const REQUEST_ROUTING_TTL_MS = 15 * 60 * 1_000;
const persistedMediaRequestResponseSchema = mediaRequestResponseSchema.or(
  mediaRequestResponseSchema
    .omit({ qualityProfile: true })
    .transform((response) => ({ ...response, qualityProfile: "Profile unavailable" })),
);

interface SeerrConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  displayName: string;
  encryptedCredentials: string;
  healthState: string;
  id: string;
  insecureHttpApproved: number;
  tlsPolicy: string;
}

interface IdentityLinkRow {
  externalUserId: string;
  externalUsername: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

interface IdempotencyRow {
  failureCode: string | null;
  fingerprintHash: string;
  id: string;
  responseJson: string | null;
  state: string;
}

interface MediaRequestProfilePreferenceRow {
  destinationId: number;
  profileId: number;
}

interface ResolvedRequestRouting {
  qualityProfile: string;
  routing: SeerrRequestRouting;
}

export interface MediaRequestAdapter {
  createMediaRequest(
    input: MediaRequestInput,
    seerrUserId: number,
    signal?: AbortSignal,
    routing?: SeerrRequestRouting,
  ): Promise<Omit<MediaRequestResponse, "qualityProfile">>;
  listRequestRouting(
    kind: "movie" | "series",
    is4k: boolean,
    signal?: AbortSignal,
  ): Promise<SeerrRequestRoutingCatalog>;
  resolveUser(
    identity: SeerrUserIdentity,
    authorization: SeerrRequestAuthorization,
    signal?: AbortSignal,
  ): Promise<number>;
}

export interface MediaRequestDependencies {
  clock?: () => Date;
  createAdapter?: (config: OptionalApiKeyConnectorConfig) => MediaRequestAdapter;
  createId?: () => string;
}

export interface MediaRequestContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface MediaRequestResult {
  replayed: boolean;
  request: MediaRequestResponse;
}

export type MediaRequestFailureCode =
  | "configuration_unavailable"
  | "identity_unavailable"
  | "no_seasons_available"
  | "request_conflict"
  | "request_denied"
  | "response_invalid"
  | "routing_invalid"
  | "routing_unavailable"
  | "temporarily_unavailable";

const MEDIA_REQUEST_FAILURE_CODES = new Set<MediaRequestFailureCode>([
  "configuration_unavailable",
  "identity_unavailable",
  "no_seasons_available",
  "request_conflict",
  "request_denied",
  "response_invalid",
  "routing_invalid",
  "routing_unavailable",
  "temporarily_unavailable",
]);

export type MediaRequestServiceErrorReason =
  | MediaRequestFailureCode
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "identity_link_required"
  | "integrity_failure"
  | "storage_failure";

export class MediaRequestServiceError extends Error {
  public readonly reason: MediaRequestServiceErrorReason;

  public constructor(reason: MediaRequestServiceErrorReason, options?: ErrorOptions) {
    super("The media request could not be completed.", options);
    this.name = "MediaRequestServiceError";
    this.reason = reason;
  }
}

function credentialContext(connectorId: string) {
  return `connector_credentials:seerr:${connectorId}`;
}

function routingContext(userId: string, sessionId: string) {
  return `media_request_routing:v1:${userId}:${sessionId}`;
}

const requestRoutingReferenceBase = {
  connectorId: z.string().regex(CONNECTOR_IDENTIFIER_PATTERN),
  destinationId: z.int().nonnegative().max(2_147_483_647),
  expiresAt: z.int().nonnegative(),
  is4k: z.boolean(),
  issuedAt: z.int().nonnegative(),
  kind: z.enum(["movie", "series"]),
} as const;

const requestRoutingReferencePayloadSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...requestRoutingReferenceBase, type: z.literal("destination") }),
  z.strictObject({
    ...requestRoutingReferenceBase,
    profileId: z.int().positive().max(2_147_483_647),
    type: z.literal("quality_profile"),
  }),
  z.strictObject({
    ...requestRoutingReferenceBase,
    path: z.string().trim().min(1).max(1_024),
    type: z.literal("root_folder"),
  }),
  z.strictObject({
    ...requestRoutingReferenceBase,
    profileId: z.int().positive().max(2_147_483_647),
    type: z.literal("language_profile"),
  }),
]);
type RequestRoutingReferencePayload = z.infer<typeof requestRoutingReferencePayloadSchema>;
type RequestRoutingReferenceSpecific =
  | { type: "destination" }
  | { profileId: number; type: "quality_profile" }
  | { path: string; type: "root_folder" }
  | { profileId: number; type: "language_profile" };

function connectorSecrets(
  row: SeerrConnectorRow,
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
    throw new MediaRequestServiceError("integrity_failure", { cause: error });
  }
}

function canonicalInput(input: MediaRequestInput): MediaRequestInput {
  if (input.kind !== "series" || input.seasons === "all") return input;
  return { ...input, seasons: [...input.seasons].sort((left, right) => left - right) };
}

function withoutRouting(input: MediaRequestInput): MediaRequestInput {
  if (input.kind === "movie") {
    return { is4k: input.is4k, kind: input.kind, tmdbId: input.tmdbId };
  }
  return {
    is4k: input.is4k,
    kind: input.kind,
    seasons: input.seasons,
    tmdbId: input.tmdbId,
  };
}

function hasRequestCapability(
  row: SeerrConnectorRow,
  capability: "request.configure" | "request.create",
) {
  try {
    const decoded = JSON.parse(row.capabilitySnapshotJson) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const record = decoded as Record<string, unknown>;
    if (record.schemaVersion !== 1) return false;
    const health = connectorHealthSchema.safeParse(record.health);
    return (
      health.success &&
      health.data.connectorId === row.id &&
      health.data.service === "seerr" &&
      health.data.status === "healthy" &&
      row.healthState === "healthy" &&
      health.data.capabilities.includes(capability)
    );
  } catch {
    return false;
  }
}

function rootFolderLabel(path: string, index: number) {
  const segment = path
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  return segment && segment !== "." && segment !== ".."
    ? segment.slice(0, 120)
    : `Storage ${index + 1}`;
}

function rootFolderLabels(paths: string[]) {
  const baseLabels = paths.map(rootFolderLabel);
  const totals = new Map<string, number>();
  for (const label of baseLabels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return baseLabels.map((label) => {
    if ((totals.get(label) ?? 0) === 1) return label;
    const occurrence = (occurrences.get(label) ?? 0) + 1;
    occurrences.set(label, occurrence);
    return `${label.slice(0, 148)} · ${occurrence}`;
  });
}

function defaultRequestRouting(catalog: SeerrRequestRoutingCatalog): ResolvedRequestRouting {
  const defaults = catalog.destinations.filter((destination) => destination.isDefault);
  if (defaults.length !== 1) throw new MediaRequestServiceError("routing_unavailable");
  const destination = defaults[0]!;
  const qualityProfile = destination.profiles.find(
    (profile) => profile.id === destination.activeProfileId,
  );
  const rootFolder = destination.rootFolders.find(
    (folder) => folder.path === destination.activeDirectory,
  );
  const languageProfile =
    destination.activeLanguageProfileId === null
      ? null
      : destination.languageProfiles.find(
          (profile) => profile.id === destination.activeLanguageProfileId,
        );
  if (!qualityProfile || !rootFolder || languageProfile === undefined) {
    throw new MediaRequestServiceError("routing_unavailable");
  }
  return {
    qualityProfile: qualityProfile.label,
    routing: {
      ...(languageProfile === null ? {} : { languageProfileId: languageProfile.id }),
      profileId: qualityProfile.id,
      rootFolder: rootFolder.path,
      serverId: destination.id,
    },
  };
}

function knownFailure(error: unknown): MediaRequestFailureCode {
  if (error instanceof MediaRequestServiceError) {
    if (error.reason === "routing_invalid") return "routing_invalid";
    if (error.reason === "routing_unavailable") return "routing_unavailable";
    if (
      error.reason === "configuration_unavailable" ||
      error.reason === "integrity_failure" ||
      error.reason === "storage_failure"
    ) {
      return "configuration_unavailable";
    }
  }
  if (error instanceof SeerrRequestError) {
    switch (error.reason) {
      case "identity_ambiguous":
      case "identity_not_found":
        return "identity_unavailable";
      case "no_seasons_available":
        return "no_seasons_available";
      case "request_conflict":
        return "request_conflict";
      case "request_denied":
        return "request_denied";
      case "routing_unavailable":
        return "routing_unavailable";
    }
  }
  if (error instanceof SafeConnectorError) {
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

export class MediaRequestService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: (config: OptionalApiKeyConnectorConfig) => MediaRequestAdapter;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: MediaRequestDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createAdapter = dependencies.createAdapter ?? ((input) => new SeerrAdapter(input));
  }

  public async create(
    rawInput: MediaRequestInput,
    rawIdempotencyKey: string,
    context: MediaRequestContext,
    signal?: AbortSignal,
  ): Promise<MediaRequestResult> {
    const principal = requirePermission(context.principal, "request.create");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new MediaRequestServiceError("identity_link_required");
    }
    const input = canonicalInput(mediaRequestInputSchema.parse(rawInput));
    const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
    const identity = this.#identity(principal);
    const fingerprintHash = hashToken(JSON.stringify(input));
    const keyHash = hashToken(`${principal.userId}\u0000${idempotencyKey}`);
    const reservation = this.#reserve(principal.userId, keyHash, fingerprintHash);
    if (reservation.kind === "replay") {
      return { replayed: true, request: reservation.response };
    }
    if (reservation.kind === "failure") {
      throw new MediaRequestServiceError(reservation.failureCode);
    }
    if (reservation.kind === "conflict") {
      throw new MediaRequestServiceError("idempotency_conflict");
    }
    if (reservation.kind === "pending") {
      throw new MediaRequestServiceError("idempotency_in_progress");
    }

    let adapter: MediaRequestAdapter;
    let seerrUserId: number;
    let resolvedRouting: ResolvedRequestRouting;
    try {
      const connection = this.#connection("request.create", "request.configure");
      adapter = connection.adapter;
      const [resolvedUserId, loadedCatalog] = await Promise.all([
        adapter.resolveUser(identity, { is4k: input.is4k, kind: input.kind }, signal),
        adapter.listRequestRouting(input.kind, input.is4k, signal),
      ]);
      const catalog = this.#routingCatalogWithPreference(loadedCatalog, connection.connectorId);
      seerrUserId = resolvedUserId;
      resolvedRouting = input.routing
        ? this.#resolveRouting(
            input.routing,
            principal.userId,
            principal.sessionId,
            connection.connectorId,
            input.kind,
            input.is4k,
            catalog,
          )
        : defaultRequestRouting(catalog);
    } catch (error) {
      const failureCode = knownFailure(error);
      this.#completeFailure(reservation.operationId, failureCode, input, context);
      throw new MediaRequestServiceError(failureCode, { cause: error });
    }

    let response: MediaRequestResponse;
    try {
      response = mediaRequestResponseSchema.parse({
        ...(await adapter.createMediaRequest(
          withoutRouting(input),
          seerrUserId,
          signal,
          resolvedRouting.routing,
        )),
        qualityProfile: resolvedRouting.qualityProfile,
      });
    } catch (error) {
      const failureCode = knownFailure(error);
      this.#completeFailure(reservation.operationId, failureCode, input, context);
      throw new MediaRequestServiceError(failureCode, { cause: error });
    }
    this.#completeSuccess(reservation.operationId, response, input, context);
    return { replayed: false, request: response };
  }

  public async routingOptions(
    rawQuery: MediaRequestRoutingOptionsQuery,
    context: MediaRequestContext,
    signal?: AbortSignal,
  ): Promise<MediaRequestRoutingOptionsResponse> {
    const principal = requirePermission(context.principal, "request.create");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new MediaRequestServiceError("identity_link_required");
    }
    const query = mediaRequestRoutingOptionsQuerySchema.parse(rawQuery);
    const identity = this.#identity(principal);
    try {
      const connection = this.#connection("request.configure");
      const [, loadedCatalog] = await Promise.all([
        connection.adapter.resolveUser(identity, { is4k: query.is4k, kind: query.kind }, signal),
        connection.adapter.listRequestRouting(query.kind, query.is4k, signal),
      ]);
      const catalog = this.#routingCatalogWithPreference(loadedCatalog, connection.connectorId);
      return this.#routingOptionsResponse(
        catalog,
        principal.userId,
        principal.sessionId,
        connection.connectorId,
      );
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError(knownFailure(error), { cause: error });
    }
  }

  public async setRoutingPreference(
    rawInput: MediaRequestRoutingPreferenceInput,
    context: MediaRequestContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const principal = requirePermission(context.principal, "connectors.manage");
    if (principal.accountState !== "active" || !principal.userId) {
      throw new MediaRequestServiceError("identity_link_required");
    }
    const input = mediaRequestRoutingPreferenceInputSchema.parse(rawInput);
    const identity = this.#identity(principal);
    try {
      const connection = this.#connection("request.configure");
      const [, catalog] = await Promise.all([
        connection.adapter.resolveUser(identity, { is4k: input.is4k, kind: input.kind }, signal),
        connection.adapter.listRequestRouting(input.kind, input.is4k, signal),
      ]);
      const resolved = this.#resolveRouting(
        input.routing,
        principal.userId,
        principal.sessionId,
        connection.connectorId,
        input.kind,
        input.is4k,
        catalog,
      );
      this.#storeRoutingPreference(
        connection.connectorId,
        input.kind,
        input.is4k,
        resolved,
        principal.userId,
        context,
      );
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError(knownFailure(error), { cause: error });
    }
  }

  #connection(...capabilities: Array<"request.configure" | "request.create">) {
    const row = this.#connector();
    const secrets = connectorSecrets(row, this.#cipher);
    const tlsPolicy =
      row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
        ? row.tlsPolicy
        : undefined;
    if (
      !tlsPolicy ||
      ![0, 1].includes(row.insecureHttpApproved) ||
      !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
      !row.displayName.trim() ||
      row.displayName.length > 160 ||
      !capabilities.every((capability) => hasRequestCapability(row, capability))
    ) {
      throw new MediaRequestServiceError("integrity_failure");
    }
    try {
      return {
        adapter: this.#createAdapter({
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
        }),
        connectorId: row.id,
      };
    } catch (error) {
      throw new MediaRequestServiceError("integrity_failure", { cause: error });
    }
  }

  #routingOptionsResponse(
    catalog: SeerrRequestRoutingCatalog,
    userId: string,
    sessionId: string,
    connectorId: string,
  ) {
    const generatedAt = this.#now();
    const expiresAt = generatedAt + REQUEST_ROUTING_TTL_MS;
    const reference = (payload: RequestRoutingReferenceSpecific, destinationId: number) =>
      this.#routingReference(
        {
          ...payload,
          connectorId,
          destinationId,
          expiresAt,
          is4k: catalog.is4k,
          issuedAt: generatedAt,
          kind: catalog.kind,
        } as RequestRoutingReferencePayload,
        userId,
        sessionId,
      );
    const response = {
      destinations: catalog.destinations.map((destination) => {
        const labels = rootFolderLabels(destination.rootFolders.map((folder) => folder.path));
        return {
          id: reference({ type: "destination" }, destination.id),
          isDefault: destination.isDefault,
          label: destination.label,
          languageProfiles: destination.languageProfiles.map((profile) => ({
            id: reference({ profileId: profile.id, type: "language_profile" }, destination.id),
            isDefault: destination.activeLanguageProfileId === profile.id,
            label: profile.label,
          })),
          qualityProfiles: destination.profiles.map((profile) => ({
            id: reference({ profileId: profile.id, type: "quality_profile" }, destination.id),
            isDefault: destination.activeProfileId === profile.id,
            label: profile.label,
          })),
          rootFolders: destination.rootFolders.map((folder, index) => ({
            availableBytes: folder.availableBytes,
            capacityBytes: folder.capacityBytes,
            id: reference({ path: folder.path, type: "root_folder" }, destination.id),
            isDefault: folder.path === destination.activeDirectory,
            label: labels[index]!,
          })),
          service: catalog.kind === "movie" ? ("radarr" as const) : ("sonarr" as const),
        };
      }),
      expiresAt: new Date(expiresAt).toISOString(),
      failures: catalog.failures,
      generatedAt: new Date(generatedAt).toISOString(),
      is4k: catalog.is4k,
      kind: catalog.kind,
    };
    return mediaRequestRoutingOptionsResponseSchema.parse(response);
  }

  #routingCatalogWithPreference(
    catalog: SeerrRequestRoutingCatalog,
    connectorId: string,
  ): SeerrRequestRoutingCatalog {
    let preference: MediaRequestProfilePreferenceRow | undefined;
    try {
      preference = this.#database.sqlite
        .prepare(
          `select
             destination_id as destinationId,
             profile_id as profileId
           from media_request_profile_preferences
           where connector_id = ? and kind = ? and is_4k = ?
           limit 1`,
        )
        .get(connectorId, catalog.kind, catalog.is4k ? 1 : 0) as
        MediaRequestProfilePreferenceRow | undefined;
    } catch (error) {
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
    if (!preference) return catalog;
    const destination = catalog.destinations.find(
      (candidate) => candidate.id === preference.destinationId,
    );
    if (!destination?.profiles.some((profile) => profile.id === preference.profileId)) {
      return catalog;
    }
    return {
      ...catalog,
      destinations: catalog.destinations.map((candidate) => ({
        ...candidate,
        activeProfileId:
          candidate.id === preference.destinationId
            ? preference.profileId
            : candidate.activeProfileId,
        isDefault: candidate.id === preference.destinationId,
      })),
    };
  }

  #storeRoutingPreference(
    connectorId: string,
    kind: "movie" | "series",
    is4k: boolean,
    preference: ResolvedRequestRouting,
    userId: string,
    context: MediaRequestContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite.transaction(() => {
        this.#database.sqlite
          .prepare(
            `insert into media_request_profile_preferences (
               connector_id, kind, is_4k, destination_id, profile_id,
               updated_by_user_id, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (connector_id, kind, is_4k) do update set
               destination_id = excluded.destination_id,
               profile_id = excluded.profile_id,
               updated_by_user_id = excluded.updated_by_user_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            connectorId,
            kind,
            is4k ? 1 : 0,
            preference.routing.serverId,
            preference.routing.profileId,
            userId,
            now,
            now,
          );
        this.#database.sqlite
          .prepare(
            `insert into audit_events (
               id, actor_user_id, actor_session_id, actor_auth_method,
               event_type, outcome, target_type, target_id, request_id,
               metadata_json, ip_hash, created_at
             ) values (?, ?, ?, ?, 'media.request.preference.updated', 'success',
               'connector', ?, ?, ?, ?, ?)`,
          )
          .run(
            this.#id(),
            userId,
            context.principal.sessionId,
            context.principal.authenticationMethod.kind,
            connectorId,
            context.requestId ?? null,
            JSON.stringify({ is4k, kind, qualityProfile: preference.qualityProfile }),
            context.ipAddress
              ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
              : null,
            now,
          );
      })();
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #routingReference(payload: RequestRoutingReferencePayload, userId: string, sessionId: string) {
    const parsed = requestRoutingReferencePayloadSchema.parse(payload);
    return `${REQUEST_ROUTING_REFERENCE_PREFIX}${this.#cipher.encrypt(
      JSON.stringify(parsed),
      routingContext(userId, sessionId),
    )}`;
  }

  #resolveRouting(
    selection: MediaRequestRoutingSelection,
    userId: string,
    sessionId: string,
    connectorId: string,
    kind: "movie" | "series",
    is4k: boolean,
    catalog: SeerrRequestRoutingCatalog,
  ): ResolvedRequestRouting {
    try {
      const destination = this.#decodeRoutingReference(selection.destination, userId, sessionId);
      const qualityProfile = this.#decodeRoutingReference(
        selection.qualityProfile,
        userId,
        sessionId,
      );
      const rootFolder = this.#decodeRoutingReference(selection.rootFolder, userId, sessionId);
      const languageProfile = selection.languageProfile
        ? this.#decodeRoutingReference(selection.languageProfile, userId, sessionId)
        : null;
      const references = [destination, qualityProfile, rootFolder, languageProfile].filter(
        (reference): reference is RequestRoutingReferencePayload => reference !== null,
      );
      const currentDestination = catalog.destinations.find(
        (candidate) => candidate.id === destination.destinationId,
      );
      const currentQualityProfile =
        qualityProfile.type === "quality_profile"
          ? currentDestination?.profiles.find((profile) => profile.id === qualityProfile.profileId)
          : undefined;
      const now = this.#now();
      if (
        catalog.kind !== kind ||
        catalog.is4k !== is4k ||
        destination.type !== "destination" ||
        qualityProfile.type !== "quality_profile" ||
        rootFolder.type !== "root_folder" ||
        (languageProfile !== null && languageProfile.type !== "language_profile") ||
        !currentDestination ||
        !currentQualityProfile ||
        !currentDestination.rootFolders.some((folder) => folder.path === rootFolder.path) ||
        (languageProfile !== null &&
          !currentDestination.languageProfiles.some(
            (profile) => profile.id === languageProfile.profileId,
          )) ||
        references.some(
          (reference) =>
            reference.connectorId !== connectorId ||
            reference.destinationId !== destination.destinationId ||
            reference.kind !== kind ||
            reference.is4k !== is4k ||
            reference.issuedAt > now ||
            reference.expiresAt <= now ||
            reference.expiresAt !== destination.expiresAt ||
            reference.issuedAt !== destination.issuedAt,
        )
      ) {
        throw new Error("invalid");
      }
      return {
        qualityProfile: currentQualityProfile.label,
        routing: {
          ...(languageProfile === null ? {} : { languageProfileId: languageProfile.profileId }),
          profileId: qualityProfile.profileId,
          rootFolder: rootFolder.path,
          serverId: destination.destinationId,
        },
      };
    } catch (error) {
      throw new MediaRequestServiceError("routing_invalid", { cause: error });
    }
  }

  #decodeRoutingReference(reference: string, userId: string, sessionId: string) {
    if (!reference.startsWith(REQUEST_ROUTING_REFERENCE_PREFIX)) throw new Error("invalid");
    const envelope = reference.slice(REQUEST_ROUTING_REFERENCE_PREFIX.length);
    return requestRoutingReferencePayloadSchema.parse(
      JSON.parse(this.#cipher.decrypt(envelope, routingContext(userId, sessionId))),
    );
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
             capability_snapshot_json as capabilitySnapshotJson,
             health_state as healthState,
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type = 'seerr' and enabled = 1
           order by id asc
           limit 2`,
        )
        .all() as SeerrConnectorRow[];
      if (rows.length !== 1) throw new MediaRequestServiceError("configuration_unavailable");
      return rows[0]!;
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #identity(principal: SessionPrincipal): SeerrUserIdentity {
    const link = principal.linkedServices.find((candidate) => candidate.service === "jellyfin");
    if (
      !principal.userId ||
      !link ||
      !link.externalUserId ||
      !link.username ||
      !["linked", "unavailable"].includes(link.health)
    ) {
      throw new MediaRequestServiceError("identity_link_required");
    }
    try {
      const row = this.#database.sqlite
        .prepare(
          `select
             external_user_id as externalUserId,
             external_username as externalUsername
           from service_identity_links
           where id = ?
             and user_id = ?
             and service = 'jellyfin'
             and health_state in ('linked', 'unavailable')
           limit 1`,
        )
        .get(link.id, principal.userId) as IdentityLinkRow | undefined;
      if (
        !row ||
        row.externalUserId !== link.externalUserId ||
        row.externalUsername !== link.username
      ) {
        throw new MediaRequestServiceError("identity_link_required");
      }
      return {
        jellyfinUserId: row.externalUserId,
        jellyfinUsername: row.externalUsername,
      };
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #reserve(userId: string, keyHash: string, fingerprintHash: string) {
    try {
      return this.#database.sqlite.transaction(() => {
        const existing = this.#database.sqlite
          .prepare(
            `select
               id,
               fingerprint_hash as fingerprintHash,
               state,
               response_json as responseJson,
               failure_code as failureCode
             from media_request_operations
             where user_id = ? and idempotency_key_hash = ?
             limit 1`,
          )
          .get(userId, keyHash) as IdempotencyRow | undefined;
        if (existing) {
          if (existing.fingerprintHash !== fingerprintHash) {
            return { kind: "conflict" as const };
          }
          if (existing.state === "pending") return { kind: "pending" as const };
          if (existing.state === "failed") {
            if (
              !existing.failureCode ||
              !MEDIA_REQUEST_FAILURE_CODES.has(existing.failureCode as MediaRequestFailureCode)
            ) {
              throw new MediaRequestServiceError("integrity_failure");
            }
            return {
              failureCode: existing.failureCode as MediaRequestFailureCode,
              kind: "failure" as const,
            };
          }
          if (existing.state === "succeeded" && existing.responseJson) {
            try {
              return {
                kind: "replay" as const,
                response: persistedMediaRequestResponseSchema.parse(
                  JSON.parse(existing.responseJson),
                ),
              };
            } catch (error) {
              throw new MediaRequestServiceError("integrity_failure", { cause: error });
            }
          }
          throw new MediaRequestServiceError("integrity_failure");
        }
        const operationId = this.#id();
        const now = this.#now();
        this.#database.sqlite
          .prepare(
            `insert into media_request_operations (
               id, user_id, idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
             ) values (?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(operationId, userId, keyHash, fingerprintHash, now, now);
        return { kind: "reserved" as const, operationId };
      })();
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #completeSuccess(
    operationId: string,
    response: MediaRequestResponse,
    input: MediaRequestInput,
    context: MediaRequestContext,
  ) {
    this.#complete(operationId, "success", response, null, input, context);
  }

  #completeFailure(
    operationId: string,
    failureCode: MediaRequestFailureCode,
    input: MediaRequestInput,
    context: MediaRequestContext,
  ) {
    this.#complete(operationId, "failure", null, failureCode, input, context);
  }

  #complete(
    operationId: string,
    outcome: "success" | "failure",
    response: MediaRequestResponse | null,
    failureCode: MediaRequestFailureCode | null,
    input: MediaRequestInput,
    context: MediaRequestContext,
  ) {
    try {
      const now = this.#now();
      this.#database.sqlite.transaction(() => {
        const update = this.#database.sqlite
          .prepare(
            `update media_request_operations
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
        if (update.changes !== 1) throw new MediaRequestServiceError("integrity_failure");
        this.#audit(
          outcome,
          response?.id ?? operationId,
          input,
          context,
          now,
          failureCode,
          response?.qualityProfile ?? null,
        );
      })();
    } catch (error) {
      if (error instanceof MediaRequestServiceError) throw error;
      throw new MediaRequestServiceError("storage_failure", { cause: error });
    }
  }

  #audit(
    outcome: "success" | "failure",
    targetId: string | null,
    input: MediaRequestInput,
    context: MediaRequestContext,
    createdAt: number,
    failureCode: MediaRequestFailureCode | null,
    qualityProfile: string | null,
  ) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
           id,
           actor_user_id,
           actor_session_id,
           actor_auth_method,
           event_type,
           outcome,
           target_type,
           target_id,
           request_id,
           metadata_json,
           ip_hash,
           created_at
         ) values (?, ?, ?, ?, ?, ?, 'media_request', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#id(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        outcome === "success" ? "media.request.created" : "media.request.failed",
        outcome,
        targetId,
        context.requestId ?? null,
        JSON.stringify({
          ...(failureCode ? { failureCode } : {}),
          is4k: input.is4k,
          kind: input.kind,
          ...(qualityProfile ? { qualityProfile } : {}),
          tmdbId: input.tmdbId,
        }),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        createdAt,
      );
  }

  #now() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MediaRequestServiceError("integrity_failure");
    }
    return value;
  }

  #id() {
    const value = this.#createId();
    if (!IDENTIFIER_PATTERN.test(value)) {
      throw new MediaRequestServiceError("integrity_failure");
    }
    return value;
  }
}
