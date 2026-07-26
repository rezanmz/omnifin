import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  ClientSecretBasic,
  ClientSecretPost,
  None,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  type ClientAuth,
  type ClientMetadata,
  type Configuration,
  type ServerMetadata,
} from "openid-client";
import { oidcProviders } from "../../db/schema.js";
import type { DatabaseHandle } from "../../db/client.js";
import { EnvelopeCipher } from "../../security/crypto.js";
import {
  createOidcSafeFetch,
  OIDC_MAX_APPROVED_ORIGINS,
  OIDC_MAX_URL_LENGTH,
  OIDC_REQUEST_TIMEOUT_MS,
} from "./safe-fetch.js";

const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_CLIENT_ID_BYTES = 1_024;
const MAX_SCOPE_TEXT_LENGTH = 2_048;
const MAX_SCOPE_COUNT = 32;
const MAX_SCOPE_LENGTH = 128;
const MAX_CLIENT_SECRET_BYTES = 4_096;
const MAX_METADATA_ARRAY_LENGTH = 128;

export const OIDC_PROVIDER_RUNTIME_CACHE_TTL_MS = 5 * 60 * 1_000;
export const OIDC_PROVIDER_RUNTIME_CACHE_MAX_ENTRIES = 32;

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
const WELL_KNOWN_PATH_SEGMENT_PATTERN = /(?:^|\/)\.well-known(?:\/|$)/;

const ID_TOKEN_SIGNING_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

type ProviderRecord = typeof oidcProviders.$inferSelect;
export type TokenEndpointAuthMethod = ProviderRecord["tokenEndpointAuthMethod"];
export type IdTokenSigningAlgorithm = ProviderRecord["idTokenSigningAlg"];

export type OidcProviderRegistryErrorCode =
  | "oidc_provider_changed"
  | "oidc_provider_disabled"
  | "oidc_provider_discovery_failed"
  | "oidc_provider_misconfigured"
  | "oidc_provider_not_found"
  | "oidc_provider_storage_failed";

const ERROR_MESSAGES: Readonly<Record<OidcProviderRegistryErrorCode, string>> = {
  oidc_provider_changed: "The identity provider configuration changed during validation.",
  oidc_provider_disabled: "The identity provider is disabled.",
  oidc_provider_discovery_failed: "The identity provider could not be validated.",
  oidc_provider_misconfigured: "The identity provider configuration is invalid.",
  oidc_provider_not_found: "The identity provider was not found.",
  oidc_provider_storage_failed: "The identity provider validation state could not be saved.",
};

/** A context-free error that never retains provider metadata or secret material. */
export class OidcProviderRegistryError extends Error {
  public readonly code: OidcProviderRegistryErrorCode;
  public readonly retryable: boolean;

  public constructor(code: OidcProviderRegistryErrorCode, retryable = false) {
    super(ERROR_MESSAGES[code]);
    this.name = "OidcProviderRegistryError";
    this.code = code;
    this.retryable = retryable;
    Object.freeze(this);
  }
}

export interface OidcProviderCapabilities {
  readonly authorizationCodeFlow: true;
  readonly idTokenSigningAlg: IdTokenSigningAlgorithm;
  readonly logout: {
    readonly backChannel: boolean;
    readonly backChannelSession: boolean;
    readonly frontChannel: boolean;
    readonly frontChannelSession: boolean;
    readonly rpInitiated: boolean;
  };
  readonly pkceS256: true;
  readonly schemaVersion: 1;
  readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  readonly userInfo: boolean;
}

/** The deliberately small, serialization-safe result of provider discovery. */
export interface DiscoveredOidcProvider {
  readonly allowJitProvisioning: boolean;
  readonly capabilities: OidcProviderCapabilities;
  readonly checkedAt: Date;
  readonly clientId: string;
  readonly displayName: string;
  readonly id: string;
  readonly issuer: string;
  readonly scopes: readonly string[];
}

const runtimeConstructorToken = Symbol("oidc-provider-runtime");

/**
 * Gateway-only protocol state. The validated Configuration is intentionally
 * non-enumerable and the handle refuses JSON serialization; HTTP responses must
 * select the sanitized `provider` snapshot explicitly.
 */
export class OidcProviderRuntime {
  readonly #configuration: Configuration;
  public readonly provider: DiscoveredOidcProvider;

  public constructor(
    token: typeof runtimeConstructorToken,
    configuration: Configuration,
    provider: DiscoveredOidcProvider,
  ) {
    if (token !== runtimeConstructorToken) throw registryError("oidc_provider_misconfigured");
    this.#configuration = configuration;
    this.provider = provider;
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new TypeError("OIDC provider runtime handles cannot be serialized.");
  }
}

export interface OidcProviderRegistryConfig {
  readonly encryptionKey: Buffer;
}

export interface OidcProviderRegistryDependencies {
  readonly clock?: () => Date;
  readonly createSafeFetch?: typeof createOidcSafeFetch;
  readonly discover?: typeof discovery;
}

interface ParsedProviderBase {
  readonly approvedOrigins: readonly string[];
  readonly clientId: string;
  readonly displayName: string;
  readonly idTokenSigningAlg: IdTokenSigningAlgorithm;
  readonly issuerIdentifier: string;
  readonly issuerUrl: URL;
  readonly scopes: readonly string[];
}

interface CachedOidcProviderRuntime {
  readonly cachedAtMs: number;
  readonly expiresAtMs: number;
  readonly providerId: string;
  readonly runtime: OidcProviderRuntime;
}

interface InFlightOidcProviderDiscovery {
  readonly fingerprint: string;
  readonly promise: Promise<OidcProviderRuntime>;
}

type ParsedProvider = ParsedProviderBase &
  (
    | {
        readonly tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
        readonly clientSecret: string;
      }
    | { readonly tokenEndpointAuthMethod: "none" }
  );

function registryError(
  code: OidcProviderRegistryErrorCode,
  retryable = false,
): OidcProviderRegistryError {
  return new OidcProviderRegistryError(code, retryable);
}

function isExactProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(value)
  );
}

export function oidcClientSecretEncryptionContext(providerId: string): string {
  if (!isExactProviderId(providerId)) throw registryError("oidc_provider_misconfigured");
  return `omnifin:v1:oidc-provider:${providerId}:client-secret`;
}

function boundedUtf8(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function parseDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_NAME_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw registryError("oidc_provider_misconfigured");
  }
  return value;
}

function parseClientId(value: unknown): string {
  if (
    !boundedUtf8(value, MAX_CLIENT_ID_BYTES) ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw registryError("oidc_provider_misconfigured");
  }
  return value;
}

function parseScopes(value: unknown): readonly string[] {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SCOPE_TEXT_LENGTH
  ) {
    throw registryError("oidc_provider_misconfigured");
  }

  const scopes = value.split(" ");
  if (
    scopes.length === 0 ||
    scopes.length > MAX_SCOPE_COUNT ||
    scopes.join(" ") !== value
  ) {
    throw registryError("oidc_provider_misconfigured");
  }

  const uniqueScopes = new Set<string>();
  for (const scope of scopes) {
    if (
      scope.length === 0 ||
      scope.length > MAX_SCOPE_LENGTH ||
      !SCOPE_TOKEN_PATTERN.test(scope) ||
      uniqueScopes.has(scope) ||
      scope.toLowerCase() === "offline_access"
    ) {
      throw registryError("oidc_provider_misconfigured");
    }
    uniqueScopes.add(scope);
  }
  if (!uniqueScopes.has("openid")) throw registryError("oidc_provider_misconfigured");

  return Object.freeze([...scopes]);
}

function parseApprovedOrigins(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length < 2 || value.length > 4_096) {
    throw registryError("oidc_provider_misconfigured");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw registryError("oidc_provider_misconfigured");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > OIDC_MAX_APPROVED_ORIGINS
  ) {
    throw registryError("oidc_provider_misconfigured");
  }

  const origins = new Set<string>();
  for (const candidate of parsed) {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > OIDC_MAX_URL_LENGTH
    ) {
      throw registryError("oidc_provider_misconfigured");
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw registryError("oidc_provider_misconfigured");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== candidate ||
      origins.has(url.origin)
    ) {
      throw registryError("oidc_provider_misconfigured");
    }
    origins.add(url.origin);
  }

  return Object.freeze([...origins]);
}

function parseIssuer(
  value: unknown,
  approvedOrigins: readonly string[],
): { readonly identifier: string; readonly url: URL } {
  if (typeof value !== "string" || value.length === 0 || value.length > OIDC_MAX_URL_LENGTH) {
    throw registryError("oidc_provider_misconfigured");
  }

  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw registryError("oidc_provider_misconfigured");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    issuer.href !== value ||
    WELL_KNOWN_PATH_SEGMENT_PATTERN.test(issuer.pathname) ||
    !approvedOrigins.includes(issuer.origin)
  ) {
    throw registryError("oidc_provider_misconfigured");
  }
  return { identifier: value, url: issuer };
}

function parseTokenEndpointAuthMethod(value: unknown): TokenEndpointAuthMethod {
  if (value !== "client_secret_basic" && value !== "client_secret_post" && value !== "none") {
    throw registryError("oidc_provider_misconfigured");
  }
  return value;
}

function parseIdTokenSigningAlgorithm(value: unknown): IdTokenSigningAlgorithm {
  if (typeof value !== "string" || !ID_TOKEN_SIGNING_ALGORITHMS.has(value)) {
    throw registryError("oidc_provider_misconfigured");
  }
  return value as IdTokenSigningAlgorithm;
}

function parseProvider(record: ProviderRecord, cipher: EnvelopeCipher): ParsedProvider {
  if (!isExactProviderId(record.id)) throw registryError("oidc_provider_misconfigured");
  const approvedOrigins = parseApprovedOrigins(record.approvedEndpointOriginsJson);
  const tokenEndpointAuthMethod = parseTokenEndpointAuthMethod(record.tokenEndpointAuthMethod);
  const issuer = parseIssuer(record.issuer, approvedOrigins);
  const parsed: ParsedProviderBase = {
    approvedOrigins,
    clientId: parseClientId(record.clientId),
    displayName: parseDisplayName(record.displayName),
    idTokenSigningAlg: parseIdTokenSigningAlgorithm(record.idTokenSigningAlg),
    issuerIdentifier: issuer.identifier,
    issuerUrl: issuer.url,
    scopes: parseScopes(record.scopes),
  };

  if (tokenEndpointAuthMethod === "none") {
    if (record.encryptedClientSecret !== null) {
      throw registryError("oidc_provider_misconfigured");
    }
    return { ...parsed, tokenEndpointAuthMethod };
  }
  if (
    typeof record.encryptedClientSecret !== "string" ||
    record.encryptedClientSecret.length === 0 ||
    record.encryptedClientSecret.length > 8_192
  ) {
    throw registryError("oidc_provider_misconfigured");
  }

  let clientSecret: string;
  try {
    clientSecret = cipher.decrypt(
      record.encryptedClientSecret,
      oidcClientSecretEncryptionContext(record.id),
    );
  } catch {
    throw registryError("oidc_provider_misconfigured");
  }
  if (!boundedUtf8(clientSecret, MAX_CLIENT_SECRET_BYTES)) {
    throw registryError("oidc_provider_misconfigured");
  }

  return { ...parsed, clientSecret, tokenEndpointAuthMethod };
}

function selectClientAuthentication(provider: ParsedProvider): ClientAuth {
  switch (provider.tokenEndpointAuthMethod) {
    case "client_secret_basic":
      return ClientSecretBasic(provider.clientSecret);
    case "client_secret_post":
      return ClientSecretPost(provider.clientSecret);
    case "none":
      return None();
  }
}

function requireMetadataArray(value: unknown, expected: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_METADATA_ARRAY_LENGTH
  ) {
    throw registryError("oidc_provider_misconfigured");
  }

  const entries = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_SCOPE_TEXT_LENGTH ||
      entry.trim() !== entry ||
      CONTROL_CHARACTER_PATTERN.test(entry) ||
      entries.has(entry)
    ) {
      throw registryError("oidc_provider_misconfigured");
    }
    entries.add(entry);
  }
  if (!entries.has(expected)) throw registryError("oidc_provider_misconfigured");
}

function requireApprovedEndpoint(
  value: unknown,
  approvedOrigins: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > OIDC_MAX_URL_LENGTH) {
    throw registryError("oidc_provider_misconfigured");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw registryError("oidc_provider_misconfigured");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    !approvedOrigins.has(endpoint.origin)
  ) {
    throw registryError("oidc_provider_misconfigured");
  }
  return endpoint.href;
}

function validateOptionalApprovedEndpoint(
  value: unknown,
  approvedOrigins: ReadonlySet<string>,
): boolean {
  if (value === undefined) return false;
  requireApprovedEndpoint(value, approvedOrigins);
  return true;
}

function optionalMetadataBoolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw registryError("oidc_provider_misconfigured");
  return value;
}

function validateMetadata(
  configuration: Configuration,
  provider: ParsedProvider,
): OidcProviderCapabilities {
  const metadata: Readonly<ServerMetadata> = configuration.serverMetadata();
  const client: Readonly<ClientMetadata> = configuration.clientMetadata();
  if (
    metadata.issuer !== provider.issuerIdentifier ||
    client.client_id !== provider.clientId ||
    client.client_secret !== undefined ||
    client.id_token_signed_response_alg !== provider.idTokenSigningAlg ||
    client.token_endpoint_auth_method !== provider.tokenEndpointAuthMethod
  ) {
    throw registryError("oidc_provider_misconfigured");
  }
  requireMetadataArray(client.response_types, "code");
  requireMetadataArray(client.grant_types, "authorization_code");

  const approvedOrigins = new Set(provider.approvedOrigins);
  requireApprovedEndpoint(metadata.authorization_endpoint, approvedOrigins);
  requireApprovedEndpoint(metadata.token_endpoint, approvedOrigins);
  requireApprovedEndpoint(metadata.jwks_uri, approvedOrigins);
  requireMetadataArray(metadata.response_types_supported, "code");
  requireMetadataArray(metadata.grant_types_supported, "authorization_code");
  requireMetadataArray(metadata.code_challenge_methods_supported, "S256");
  requireMetadataArray(
    metadata.token_endpoint_auth_methods_supported,
    provider.tokenEndpointAuthMethod,
  );
  requireMetadataArray(
    metadata.id_token_signing_alg_values_supported,
    provider.idTokenSigningAlg,
  );

  const frontChannel = optionalMetadataBoolean(metadata.frontchannel_logout_supported);
  const backChannel = optionalMetadataBoolean(metadata.backchannel_logout_supported);
  const frontChannelSession = optionalMetadataBoolean(
    metadata.frontchannel_logout_session_supported,
  );
  const backChannelSession = optionalMetadataBoolean(metadata.backchannel_logout_session_supported);
  const capabilities: OidcProviderCapabilities = {
    authorizationCodeFlow: true,
    idTokenSigningAlg: provider.idTokenSigningAlg,
    logout: Object.freeze({
      backChannel,
      backChannelSession: backChannel && backChannelSession,
      frontChannel,
      frontChannelSession: frontChannel && frontChannelSession,
      rpInitiated: validateOptionalApprovedEndpoint(
        metadata.end_session_endpoint,
        approvedOrigins,
      ),
    }),
    pkceS256: true,
    schemaVersion: 1,
    tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
    userInfo: validateOptionalApprovedEndpoint(metadata.userinfo_endpoint, approvedOrigins),
  };
  return Object.freeze(capabilities);
}

function validatedTimestampMilliseconds(value: unknown): number {
  if (!(value instanceof Date)) throw registryError("oidc_provider_storage_failed", true);
  const milliseconds = value.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    new Date(milliseconds).getTime() !== milliseconds
  ) {
    throw registryError("oidc_provider_storage_failed", true);
  }
  return milliseconds;
}

function validateProviderRecordTimestamps(record: ProviderRecord): void {
  const createdAt = validatedTimestampMilliseconds(record.createdAt);
  const updatedAt = validatedTimestampMilliseconds(record.updatedAt);
  if (updatedAt < createdAt) throw registryError("oidc_provider_storage_failed", true);
  if (record.discoveryCheckedAt !== null) {
    const checkedAt = validatedTimestampMilliseconds(record.discoveryCheckedAt);
    if (checkedAt < createdAt) throw registryError("oidc_provider_storage_failed", true);
  }
}

function providerConfigFingerprint(record: ProviderRecord): string {
  const digest = createHash("sha256");
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["id", record.id],
    ["slug", record.slug],
    ["displayName", record.displayName],
    ["issuer", record.issuer],
    ["clientId", record.clientId],
    ["encryptedClientSecret", record.encryptedClientSecret ?? ""],
    ["tokenEndpointAuthMethod", record.tokenEndpointAuthMethod],
    ["idTokenSigningAlg", record.idTokenSigningAlg],
    ["scopes", record.scopes],
    ["claimConfigJson", record.claimConfigJson],
    ["approvedEndpointOriginsJson", record.approvedEndpointOriginsJson],
    ["allowJitProvisioning", record.allowJitProvisioning ? "1" : "0"],
    ["enabled", record.enabled ? "1" : "0"],
    ["createdAt", String(validatedTimestampMilliseconds(record.createdAt))],
    ["updatedAt", String(validatedTimestampMilliseconds(record.updatedAt))],
  ];

  for (const [name, value] of fields) {
    digest.update(`${name}:${Buffer.byteLength(value, "utf8")}:`, "utf8");
    digest.update(value, "utf8");
  }
  return digest.digest("base64url");
}

function providerSnapshot(record: ProviderRecord) {
  return and(
    eq(oidcProviders.id, record.id),
    eq(oidcProviders.slug, record.slug),
    eq(oidcProviders.displayName, record.displayName),
    eq(oidcProviders.issuer, record.issuer),
    eq(oidcProviders.clientId, record.clientId),
    record.encryptedClientSecret === null
      ? isNull(oidcProviders.encryptedClientSecret)
      : eq(oidcProviders.encryptedClientSecret, record.encryptedClientSecret),
    eq(oidcProviders.tokenEndpointAuthMethod, record.tokenEndpointAuthMethod),
    eq(oidcProviders.idTokenSigningAlg, record.idTokenSigningAlg),
    eq(oidcProviders.scopes, record.scopes),
    eq(oidcProviders.claimConfigJson, record.claimConfigJson),
    eq(oidcProviders.approvedEndpointOriginsJson, record.approvedEndpointOriginsJson),
    eq(oidcProviders.discoveryState, record.discoveryState),
    eq(oidcProviders.discoveryCapabilitiesJson, record.discoveryCapabilitiesJson),
    record.discoveryCheckedAt === null
      ? isNull(oidcProviders.discoveryCheckedAt)
      : eq(oidcProviders.discoveryCheckedAt, record.discoveryCheckedAt),
    eq(oidcProviders.allowJitProvisioning, record.allowJitProvisioning),
    eq(oidcProviders.enabled, record.enabled),
    eq(oidcProviders.createdAt, record.createdAt),
    eq(oidcProviders.updatedAt, record.updatedAt),
  );
}

export class OidcProviderRegistry {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createSafeFetch: typeof createOidcSafeFetch;
  readonly #database: DatabaseHandle;
  readonly #discover: typeof discovery;
  readonly #inFlightDiscoveries = new Map<string, InFlightOidcProviderDiscovery>();
  readonly #runtimeCache = new Map<string, CachedOidcProviderRuntime>();

  public constructor(
    database: DatabaseHandle,
    config: OidcProviderRegistryConfig,
    dependencies: OidcProviderRegistryDependencies = {},
  ) {
    this.#database = database;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createSafeFetch = dependencies.createSafeFetch ?? createOidcSafeFetch;
    this.#discover = dependencies.discover ?? discovery;
  }

  public async discover(providerId: string): Promise<OidcProviderRuntime> {
    if (!isExactProviderId(providerId)) throw registryError("oidc_provider_not_found");
    let record: ProviderRecord | undefined;
    try {
      record = this.#database.db
        .select()
        .from(oidcProviders)
        .where(eq(oidcProviders.id, providerId))
        .get();
    } catch {
      throw registryError("oidc_provider_storage_failed", true);
    }
    if (!record) {
      this.#evictProviderRuntimeCache(providerId);
      throw registryError("oidc_provider_not_found");
    }
    if (!record.enabled) {
      this.#evictProviderRuntimeCache(providerId);
      throw registryError("oidc_provider_disabled");
    }

    validateProviderRecordTimestamps(record);
    const fingerprint = providerConfigFingerprint(record);
    const cacheTime = this.#clockNow();
    const cachedRuntime = this.#readCachedRuntime(providerId, fingerprint, cacheTime);
    if (cachedRuntime) return cachedRuntime;
    this.#evictProviderRuntimeCache(providerId, fingerprint);

    const existingDiscovery = this.#inFlightDiscoveries.get(providerId);
    if (existingDiscovery) {
      if (existingDiscovery.fingerprint === fingerprint) return existingDiscovery.promise;
      try {
        await existingDiscovery.promise;
      } catch {
        // A changed configuration must be retried against a fresh row regardless
        // of how the obsolete flight completed.
      }
      return this.discover(providerId);
    }
    if (this.#inFlightDiscoveries.size >= OIDC_PROVIDER_RUNTIME_CACHE_MAX_ENTRIES) {
      throw registryError("oidc_provider_discovery_failed", true);
    }

    const promise = this.#discoverUncached(record, fingerprint, cacheTime);
    this.#inFlightDiscoveries.set(providerId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.#inFlightDiscoveries.get(providerId)?.promise === promise) {
        this.#inFlightDiscoveries.delete(providerId);
      }
    }
  }

  async #discoverUncached(
    record: ProviderRecord,
    fingerprint: string,
    cacheTime: number,
  ): Promise<OidcProviderRuntime> {

    let provider: ParsedProvider;
    try {
      provider = parseProvider(record, this.#cipher);
    } catch {
      this.#persistFailed(record);
      throw registryError("oidc_provider_misconfigured");
    }

    let providerFetch: ReturnType<typeof createOidcSafeFetch>;
    try {
      providerFetch = this.#createSafeFetch({ approvedOrigins: provider.approvedOrigins });
    } catch {
      this.#persistFailed(record);
      throw registryError("oidc_provider_misconfigured");
    }

    let configuration: Configuration;
    try {
      configuration = await this.#discover(
        new URL(provider.issuerUrl),
        provider.clientId,
        {
          grant_types: ["authorization_code"],
          id_token_signed_response_alg: provider.idTokenSigningAlg,
          response_types: ["code"],
          token_endpoint_auth_method: provider.tokenEndpointAuthMethod,
        },
        selectClientAuthentication(provider),
        {
          algorithm: "oidc",
          [customFetch]: providerFetch,
          timeout: OIDC_REQUEST_TIMEOUT_MS / 1_000,
        },
      );
    } catch {
      this.#persistFailed(record);
      throw registryError("oidc_provider_discovery_failed", true);
    }

    let capabilities: OidcProviderCapabilities;
    try {
      capabilities = validateMetadata(configuration, provider);
      enableNonRepudiationChecks(configuration);
    } catch {
      this.#persistFailed(record);
      throw registryError("oidc_provider_misconfigured");
    }

    const checkedAt = this.#nextCheckedAt(record);
    this.#persistState(record, {
      discoveryCapabilitiesJson: JSON.stringify(capabilities),
      discoveryCheckedAt: checkedAt,
      discoveryState: "ready",
    });

    const sanitizedProvider: DiscoveredOidcProvider = Object.freeze({
      allowJitProvisioning: record.allowJitProvisioning,
      capabilities,
      checkedAt,
      clientId: provider.clientId,
      displayName: provider.displayName,
      id: record.id,
      issuer: provider.issuerIdentifier,
      scopes: provider.scopes,
    });
    const runtime = new OidcProviderRuntime(
      runtimeConstructorToken,
      configuration,
      sanitizedProvider,
    );
    this.#cacheRuntime(record.id, fingerprint, runtime, cacheTime);
    return runtime;
  }

  #clockNow(): number {
    let now: Date;
    try {
      now = this.#clock();
    } catch {
      throw registryError("oidc_provider_storage_failed", true);
    }
    return validatedTimestampMilliseconds(now);
  }

  #readCachedRuntime(
    providerId: string,
    fingerprint: string,
    now: number,
  ): OidcProviderRuntime | undefined {
    for (const [key, entry] of this.#runtimeCache) {
      if (now < entry.cachedAtMs || now >= entry.expiresAtMs) this.#runtimeCache.delete(key);
    }

    const entry = this.#runtimeCache.get(fingerprint);
    if (!entry || entry.providerId !== providerId) return undefined;
    this.#runtimeCache.delete(fingerprint);
    this.#runtimeCache.set(fingerprint, entry);
    return entry.runtime;
  }

  #cacheRuntime(
    providerId: string,
    fingerprint: string,
    runtime: OidcProviderRuntime,
    cachedAtMs: number,
  ): void {
    const expiresAtMs = cachedAtMs + OIDC_PROVIDER_RUNTIME_CACHE_TTL_MS;
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      new Date(expiresAtMs).getTime() !== expiresAtMs
    ) {
      return;
    }

    this.#evictProviderRuntimeCache(providerId);
    this.#runtimeCache.set(
      fingerprint,
      Object.freeze({ cachedAtMs, expiresAtMs, providerId, runtime }),
    );
    while (this.#runtimeCache.size > OIDC_PROVIDER_RUNTIME_CACHE_MAX_ENTRIES) {
      const oldest = this.#runtimeCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#runtimeCache.delete(oldest);
    }
  }

  #evictProviderRuntimeCache(providerId: string, exceptFingerprint?: string): void {
    for (const [fingerprint, entry] of this.#runtimeCache) {
      if (entry.providerId === providerId && fingerprint !== exceptFingerprint) {
        this.#runtimeCache.delete(fingerprint);
      }
    }
  }

  #nextCheckedAt(record: ProviderRecord): Date {
    const now = this.#clockNow();
    const createdAt = validatedTimestampMilliseconds(record.createdAt);
    const previousCheck =
      record.discoveryCheckedAt === null
        ? createdAt
        : validatedTimestampMilliseconds(record.discoveryCheckedAt);
    const candidate = Math.max(now, createdAt, previousCheck + 1);
    const checkedAt = new Date(candidate);
    if (!Number.isSafeInteger(candidate) || checkedAt.getTime() !== candidate) {
      throw registryError("oidc_provider_storage_failed", true);
    }
    return checkedAt;
  }

  #persistFailed(record: ProviderRecord): void {
    const checkedAt = this.#nextCheckedAt(record);
    this.#persistState(record, {
      discoveryCapabilitiesJson: "{}",
      discoveryCheckedAt: checkedAt,
      discoveryState: "failed",
    });
  }

  #persistState(
    record: ProviderRecord,
    state: Pick<
      ProviderRecord,
      "discoveryCapabilitiesJson" | "discoveryCheckedAt" | "discoveryState"
    >,
  ): void {
    let changes: number;
    try {
      changes = this.#database.db
        .update(oidcProviders)
        .set(state)
        .where(providerSnapshot(record))
        .run().changes;
    } catch {
      throw registryError("oidc_provider_storage_failed", true);
    }
    if (changes !== 1) throw registryError("oidc_provider_changed", true);
  }
}
