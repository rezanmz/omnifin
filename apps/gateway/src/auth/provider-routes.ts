import {
  AUTH_PROVIDERS_MAX_COUNT,
  authProviderSchema,
  authProvidersResponseSchema,
  type AuthProvider,
} from "@omnifin/contracts/auth";
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { DatabaseHandle } from "../db/client.js";
import { connectorConfigs, oidcProviders } from "../db/schema.js";

const MAX_PUBLIC_AUTH_PROVIDERS = AUTH_PROVIDERS_MAX_COUNT;
export const OIDC_PROVIDER_PRESENTATION_PAGE_SIZE = 50;
export const OIDC_PROVIDER_PRESENTATION_SCAN_LIMIT = 250;
const OPAQUE_256_BIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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
const TOKEN_ENDPOINT_AUTH_METHODS = new Set(["client_secret_basic", "client_secret_post", "none"]);

interface OidcProviderPresentationRecord {
  allowJitProvisioning: boolean;
  createdAt: Date;
  discoveryCapabilitiesJson: string;
  discoveryCheckedAt: Date | null;
  discoveryState: "failed" | "ready" | "unchecked";
  displayName: string;
  id: string;
  idTokenSigningAlg: string;
  issuer: string;
  tokenEndpointAuthMethod: string;
}

interface PublicLogoutCapabilities {
  supportsBackChannelLogout: boolean;
  supportsFrontChannelLogout: boolean;
  supportsRpInitiatedLogout: boolean;
}

function exactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function canonicalRuntimeSecuritySeal(value: unknown): boolean {
  if (typeof value !== "string" || !OPAQUE_256_BIT_TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function validDiscoveryTimestamp(value: unknown): value is Date {
  if (!(value instanceof Date)) return false;
  const milliseconds = value.getTime();
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length < 2 || value.length > 8_192) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseReadyLogoutCapabilities(
  record: OidcProviderPresentationRecord,
): PublicLogoutCapabilities | undefined {
  const snapshot = parseJsonObject(record.discoveryCapabilitiesJson);
  if (
    !exactObjectKeys(snapshot, ["capabilities", "runtimeSecuritySeal", "schemaVersion"]) ||
    snapshot.schemaVersion !== 1 ||
    !canonicalRuntimeSecuritySeal(snapshot.runtimeSecuritySeal)
  ) {
    return undefined;
  }
  const capabilities = snapshot.capabilities;
  if (
    !exactObjectKeys(capabilities, [
      "authorizationCodeFlow",
      "idTokenSigningAlg",
      "logout",
      "pkceS256",
      "schemaVersion",
      "tokenEndpointAuthMethod",
      "userInfo",
    ]) ||
    capabilities.authorizationCodeFlow !== true ||
    capabilities.pkceS256 !== true ||
    capabilities.schemaVersion !== 1 ||
    !ID_TOKEN_SIGNING_ALGORITHMS.has(record.idTokenSigningAlg) ||
    capabilities.idTokenSigningAlg !== record.idTokenSigningAlg ||
    !TOKEN_ENDPOINT_AUTH_METHODS.has(record.tokenEndpointAuthMethod) ||
    capabilities.tokenEndpointAuthMethod !== record.tokenEndpointAuthMethod ||
    typeof capabilities.userInfo !== "boolean"
  ) {
    return undefined;
  }
  const logout = capabilities.logout;
  if (
    !exactObjectKeys(logout, [
      "backChannel",
      "backChannelSession",
      "frontChannel",
      "frontChannelSession",
      "rpInitiated",
    ]) ||
    typeof logout.backChannel !== "boolean" ||
    typeof logout.backChannelSession !== "boolean" ||
    typeof logout.frontChannel !== "boolean" ||
    typeof logout.frontChannelSession !== "boolean" ||
    typeof logout.rpInitiated !== "boolean" ||
    (logout.backChannelSession && !logout.backChannel) ||
    (logout.frontChannelSession && !logout.frontChannel)
  ) {
    return undefined;
  }
  return {
    supportsBackChannelLogout: logout.backChannel,
    supportsFrontChannelLogout: logout.frontChannel,
    supportsRpInitiatedLogout: logout.rpInitiated,
  };
}

const noLogoutCapabilities: PublicLogoutCapabilities = Object.freeze({
  supportsBackChannelLogout: false,
  supportsFrontChannelLogout: false,
  supportsRpInitiatedLogout: false,
});

function uncheckedSnapshotIsEmpty(record: OidcProviderPresentationRecord): boolean {
  const snapshot = parseJsonObject(record.discoveryCapabilitiesJson);
  return (
    validDiscoveryTimestamp(record.createdAt) &&
    record.discoveryCheckedAt === null &&
    exactObjectKeys(snapshot, [])
  );
}

function readyDiscoveryAttributionIsValid(record: OidcProviderPresentationRecord): boolean {
  const createdAt = record.createdAt;
  const checkedAt = record.discoveryCheckedAt;
  return (
    validDiscoveryTimestamp(createdAt) &&
    validDiscoveryTimestamp(checkedAt) &&
    checkedAt.getTime() >= createdAt.getTime()
  );
}

function presentOidcProvider(record: OidcProviderPresentationRecord): AuthProvider | undefined {
  if (!PROVIDER_ID_PATTERN.test(record.id)) return undefined;
  let state: "available" | "misconfigured" | "unavailable";
  let logout = noLogoutCapabilities;
  if (record.discoveryState === "unchecked") {
    state = uncheckedSnapshotIsEmpty(record) ? "unavailable" : "misconfigured";
  } else if (record.discoveryState === "failed") {
    state = "unavailable";
  } else if (record.discoveryState === "ready" && readyDiscoveryAttributionIsValid(record)) {
    const parsedLogout = parseReadyLogoutCapabilities(record);
    state = parsedLogout ? "available" : "misconfigured";
    logout = parsedLogout ?? noLogoutCapabilities;
  } else {
    state = "misconfigured";
  }

  try {
    const parsed = authProviderSchema.safeParse({
      displayName: record.displayName,
      id: record.id,
      issuer: record.issuer,
      jitProvisioningEnabled: record.allowJitProvisioning,
      kind: "oidc",
      state,
      ...logout,
    });
    if (
      !parsed.success ||
      parsed.data.kind !== "oidc" ||
      parsed.data.id !== record.id ||
      parsed.data.displayName !== record.displayName ||
      parsed.data.issuer !== record.issuer
    ) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

function readPublicOidcProviders(database: DatabaseHandle, responseLimit: number): AuthProvider[] {
  const providers: AuthProvider[] = [];
  let cursor: Pick<OidcProviderPresentationRecord, "displayName" | "id"> | undefined;
  let scanned = 0;

  while (providers.length < responseLimit && scanned < OIDC_PROVIDER_PRESENTATION_SCAN_LIMIT) {
    const pageLimit = Math.min(
      OIDC_PROVIDER_PRESENTATION_PAGE_SIZE,
      OIDC_PROVIDER_PRESENTATION_SCAN_LIMIT - scanned,
    );
    const cursorCondition = cursor
      ? or(
          gt(oidcProviders.displayName, cursor.displayName),
          and(eq(oidcProviders.displayName, cursor.displayName), gt(oidcProviders.id, cursor.id)),
        )
      : undefined;
    const candidates = database.db
      .select({
        allowJitProvisioning: oidcProviders.allowJitProvisioning,
        createdAt: oidcProviders.createdAt,
        discoveryCapabilitiesJson: oidcProviders.discoveryCapabilitiesJson,
        discoveryCheckedAt: oidcProviders.discoveryCheckedAt,
        discoveryState: oidcProviders.discoveryState,
        displayName: oidcProviders.displayName,
        id: oidcProviders.id,
        idTokenSigningAlg: oidcProviders.idTokenSigningAlg,
        issuer: oidcProviders.issuer,
        tokenEndpointAuthMethod: oidcProviders.tokenEndpointAuthMethod,
      })
      .from(oidcProviders)
      .where(
        cursorCondition
          ? and(eq(oidcProviders.enabled, true), cursorCondition)
          : eq(oidcProviders.enabled, true),
      )
      .orderBy(asc(oidcProviders.displayName), asc(oidcProviders.id))
      .limit(pageLimit)
      .all();
    if (candidates.length === 0) break;

    scanned += candidates.length;
    const lastCandidate = candidates.at(-1)!;
    cursor = { displayName: lastCandidate.displayName, id: lastCandidate.id };
    for (const candidate of candidates) {
      const presented = presentOidcProvider(candidate);
      if (presented) providers.push(presented);
      if (providers.length === responseLimit) break;
    }
    if (candidates.length < pageLimit) break;
  }

  return providers;
}

export const authProviderRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/auth/providers",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["providers"],
            properties: {
              providers: {
                type: "array",
                maxItems: MAX_PUBLIC_AUTH_PROVIDERS,
                items: {
                  anyOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "id",
                        "kind",
                        "displayName",
                        "issuer",
                        "state",
                        "jitProvisioningEnabled",
                        "supportsRpInitiatedLogout",
                        "supportsFrontChannelLogout",
                        "supportsBackChannelLogout",
                      ],
                      properties: {
                        id: { type: "string" },
                        kind: { const: "oidc" },
                        displayName: { type: "string" },
                        issuer: { type: "string" },
                        state: { enum: ["available", "unavailable", "misconfigured"] },
                        jitProvisioningEnabled: { type: "boolean" },
                        supportsRpInitiatedLogout: { type: "boolean" },
                        supportsFrontChannelLogout: { type: "boolean" },
                        supportsBackChannelLogout: { type: "boolean" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "id",
                        "kind",
                        "displayName",
                        "state",
                        "passwordLoginAvailable",
                        "quickConnectAvailable",
                        "pairingRequiredAfterOidc",
                      ],
                      properties: {
                        id: { type: "string" },
                        kind: { const: "jellyfin" },
                        displayName: { type: "string" },
                        state: { enum: ["available", "unavailable", "misconfigured"] },
                        passwordLoginAvailable: { type: "boolean" },
                        quickConnectAvailable: { type: "boolean" },
                        pairingRequiredAfterOidc: { const: true },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      const configuredJellyfin = app.database.db
        .select({ enabled: connectorConfigs.enabled, id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.type, "jellyfin"))
        .limit(2)
        .all();
      const jellyfinAvailable = configuredJellyfin.length > 0 || Boolean(app.appConfig.jellyfinUrl);
      const oidcLimit = MAX_PUBLIC_AUTH_PROVIDERS - (jellyfinAvailable ? 1 : 0);
      const providers = readPublicOidcProviders(app.database, oidcLimit);

      if (jellyfinAvailable) {
        const connectorIsUsable =
          configuredJellyfin.length === 1 && configuredJellyfin[0]?.enabled === true;
        providers.push({
          displayName: "Jellyfin",
          id: "jellyfin",
          kind: "jellyfin",
          pairingRequiredAfterOidc: true,
          passwordLoginAvailable: connectorIsUsable,
          quickConnectAvailable: false,
          state:
            configuredJellyfin.length > 1
              ? "misconfigured"
              : connectorIsUsable
                ? "available"
                : "unavailable",
        });
      }

      return authProvidersResponseSchema.parse({ providers });
    },
  );
};
