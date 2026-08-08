import {
  JellyfinUserMediaClient,
  type JellyfinExactOwnershipInput,
  type JellyfinExactOwnershipResult,
} from "@omnifin/connectors/media/jellyfin-user-media-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { connectorCredentialInputSchema } from "@omnifin/contracts/connectors";
import type { DiscoveryAvailability } from "@omnifin/contracts/discovery";
import { X509Certificate } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

interface AvailabilitySourceRow {
  baseUrl: string;
  connectorDisplayName: string;
  connectorEnabled: number;
  connectorId: string;
  connectorRevision: number;
  connectorType: string;
  deviceId: string;
  encryptedAccessToken: string;
  encryptedCredentials: string;
  externalUserId: string;
  insecureHttpApproved: number;
  linkHealthState: string;
  linkId: string;
  linkRevision: number;
  linkService: string;
  linkUserId: string;
  tlsPolicy: string;
  userRevision: number;
  userStatus: string;
}

interface AvailabilityRevisionRow {
  connectorEnabled: number;
  connectorId: string;
  connectorRevision: number;
  externalUserId: string;
  linkHealthState: string;
  linkRevision: number;
  userRevision: number;
  userStatus: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

export type VerifiedOwnershipEvidence =
  | {
      connectorRevision: number;
      linkId: string;
      linkRevision: number;
      state: "not_owned" | "owned";
      userId: string;
      userRevision: number;
    }
  | {
      connectorRevision: number;
      linkId: string;
      linkRevision: number;
      state: "stale";
      userId: string;
      userRevision: number;
    }
  | {
      connectorRevision: null;
      linkId: null;
      linkRevision: null;
      state: "unavailable";
      userId: string | null;
      userRevision: null;
    };

export interface VerifiedAvailabilityInput {
  kind: "movie" | "series";
  tmdbId: number;
}

export interface VerifiedAvailabilityClient {
  readExactOwnership(
    input: JellyfinExactOwnershipInput,
    signal?: AbortSignal,
  ): Promise<JellyfinExactOwnershipResult>;
}

export interface VerifiedAvailabilityClientFactoryInput extends ConnectorTargetConfig {
  accessToken: string;
  deviceId: string;
}

export interface VerifiedAvailabilityDependencies {
  createClient?: (input: VerifiedAvailabilityClientFactoryInput) => VerifiedAvailabilityClient;
}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

function credentialsContext(connectorId: string) {
  return `connector_credentials:jellyfin:${connectorId}`;
}

function unavailableEvidence(userId: string | null): VerifiedOwnershipEvidence {
  return {
    connectorRevision: null,
    linkId: null,
    linkRevision: null,
    state: "unavailable",
    userId,
    userRevision: null,
  };
}

export function unavailableOwnershipEvidence(userId: string | null = null) {
  return unavailableEvidence(userId);
}

export function reconcileVerifiedAvailability(
  seerrAvailability: DiscoveryAvailability,
  evidence: VerifiedOwnershipEvidence,
): DiscoveryAvailability {
  if (evidence.state === "owned") return "available";
  if (evidence.state === "not_owned") {
    return seerrAvailability === "available" ? "unknown" : seerrAvailability;
  }
  return seerrAvailability === "requested" || seerrAvailability === "processing"
    ? seerrAvailability
    : "unknown";
}

function connectorSecrets(row: AvailabilitySourceRow, cipher: EnvelopeCipher) {
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
}

function defaultClient(input: VerifiedAvailabilityClientFactoryInput) {
  const { accessToken, deviceId, ...target } = input;
  return new JellyfinUserMediaClient({ accessToken, deviceId, target });
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export class VerifiedAvailabilityService {
  readonly #cipher: EnvelopeCipher;
  readonly #createClient: NonNullable<VerifiedAvailabilityDependencies["createClient"]>;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: VerifiedAvailabilityDependencies = {},
  ) {
    this.#database = database;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#createClient = dependencies.createClient ?? defaultClient;
  }

  public async verifyOwnership(
    input: VerifiedAvailabilityInput,
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ): Promise<VerifiedOwnershipEvidence> {
    const userId = principal.userId;
    if (!userId) return unavailableEvidence(null);
    const linkedService = principal.linkedServices.find(({ service }) => service === "jellyfin");
    if (!linkedService) return unavailableEvidence(userId);

    let source: AvailabilitySourceRow;
    try {
      source = this.#source(linkedService.id, userId);
      if (
        linkedService.externalUserId !== source.externalUserId ||
        linkedService.health !== "linked"
      ) {
        return unavailableEvidence(userId);
      }
      const accessToken = this.#cipher.decrypt(
        source.encryptedAccessToken,
        accessTokenContext(source.linkId),
      );
      const secrets = connectorSecrets(source, this.#cipher);
      const client = this.#createClient({
        accessToken,
        baseUrl: source.baseUrl,
        connectorId: source.connectorId,
        deviceId: source.deviceId,
        displayName: source.connectorDisplayName,
        insecureHttpApproved: source.insecureHttpApproved === 1,
        tlsPolicy: source.tlsPolicy as "allow_self_signed" | "strict",
        ...secrets,
      });
      const ownership = await client.readExactOwnership(
        { ...input, userId: source.externalUserId },
        signal,
      );
      if (!this.#isCurrent(source)) {
        return {
          connectorRevision: source.connectorRevision,
          linkId: source.linkId,
          linkRevision: source.linkRevision,
          state: "stale",
          userId,
          userRevision: source.userRevision,
        };
      }
      return {
        connectorRevision: source.connectorRevision,
        linkId: source.linkId,
        linkRevision: source.linkRevision,
        state: ownership.owned ? "owned" : "not_owned",
        userId,
        userRevision: source.userRevision,
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return unavailableEvidence(userId);
    }
  }

  #source(linkId: string, userId: string) {
    const row = this.#database.sqlite
      .prepare(
        `select
           l.id as linkId,
           l.user_id as linkUserId,
           l.service as linkService,
           l.device_id as deviceId,
           l.external_user_id as externalUserId,
           l.encrypted_access_token as encryptedAccessToken,
           l.health_state as linkHealthState,
           l.revision as linkRevision,
           u.status as userStatus,
           u.updated_at as userRevision,
           c.id as connectorId,
           c.type as connectorType,
           c.display_name as connectorDisplayName,
           c.base_url as baseUrl,
           c.encrypted_credentials as encryptedCredentials,
           c.tls_policy as tlsPolicy,
           c.insecure_http_approved as insecureHttpApproved,
           c.enabled as connectorEnabled,
           c.updated_at as connectorRevision
         from service_identity_links l
         join users u on u.id = l.user_id
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.id = ? and l.user_id = ?
         limit 1`,
      )
      .get(linkId, userId) as AvailabilitySourceRow | undefined;
    if (
      !row ||
      row.linkId !== linkId ||
      row.linkUserId !== userId ||
      row.linkService !== "jellyfin" ||
      row.linkHealthState !== "linked" ||
      row.userStatus !== "active" ||
      row.connectorType !== "jellyfin" ||
      row.connectorEnabled !== 1 ||
      !IDENTIFIER_PATTERN.test(row.linkId) ||
      !IDENTIFIER_PATTERN.test(row.connectorId) ||
      !IDENTIFIER_PATTERN.test(row.deviceId) ||
      !IDENTIFIER_PATTERN.test(row.externalUserId) ||
      !Number.isSafeInteger(row.linkRevision) ||
      row.linkRevision < 0 ||
      !Number.isSafeInteger(row.userRevision) ||
      row.userRevision < 0 ||
      !Number.isSafeInteger(row.connectorRevision) ||
      row.connectorRevision < 0 ||
      (row.insecureHttpApproved !== 0 && row.insecureHttpApproved !== 1) ||
      (row.tlsPolicy !== "strict" && row.tlsPolicy !== "allow_self_signed")
    ) {
      throw new Error("unavailable");
    }
    return row;
  }

  #isCurrent(source: AvailabilitySourceRow) {
    const current = this.#database.sqlite
      .prepare(
        `select
           l.revision as linkRevision,
           l.health_state as linkHealthState,
           l.external_user_id as externalUserId,
           u.status as userStatus,
           u.updated_at as userRevision,
           c.id as connectorId,
           c.enabled as connectorEnabled,
           c.updated_at as connectorRevision
         from service_identity_links l
         join users u on u.id = l.user_id
         join connector_configs c on c.id = l.connector_id and c.type = l.service
         where l.id = ? and l.user_id = ?
         limit 1`,
      )
      .get(source.linkId, source.linkUserId) as AvailabilityRevisionRow | undefined;
    return Boolean(
      current &&
      current.linkRevision === source.linkRevision &&
      current.linkHealthState === "linked" &&
      current.externalUserId === source.externalUserId &&
      current.userStatus === "active" &&
      current.userRevision === source.userRevision &&
      current.connectorId === source.connectorId &&
      current.connectorEnabled === 1 &&
      current.connectorRevision === source.connectorRevision,
    );
  }
}
