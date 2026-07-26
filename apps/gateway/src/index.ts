export { createApp, type CreateAppOptions } from "./app.js";
export { hasPermission, requirePermission } from "./auth/authorization.js";
export {
  IdentityLinkService,
  IdentityLinkServiceError,
  type IdentityLinkRevocationResult,
  type IdentityLinkServiceDependencies,
  type RevokeIdentityLinkInput,
} from "./auth/identity-link-service.js";
export {
  bootstrapConfiguredJellyfinConnector,
  JellyfinConnectorConfigurationError,
  JellyfinConnectorRegistry,
  type JellyfinConnectorTarget,
} from "./auth/jellyfin/connector-registry.js";
export {
  JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT,
  JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
  JELLYFIN_QUICK_CONNECT_TRANSACTION_TTL_MS,
  JELLYFIN_QUICK_CONNECT_UNEXPIRED_ROW_LIMIT,
  jellyfinQuickConnectBrowserBindingCookieName,
  JellyfinQuickConnectService,
  JellyfinQuickConnectServiceError,
  type JellyfinQuickConnectPollResult,
  type JellyfinQuickConnectServiceDependencies,
  type PollJellyfinQuickConnectInput,
  type StartedJellyfinQuickConnect,
  type StartJellyfinQuickConnectInput,
} from "./auth/jellyfin/quick-connect-service.js";
export {
  JellyfinSignInService,
  JellyfinSignInServiceError,
  type JellyfinAuthenticatedSignInInput,
  type JellyfinPasswordSignInInput,
  type JellyfinSignInDenialReason,
  type JellyfinSignInResult,
  type JellyfinSignInServiceDependencies,
} from "./auth/jellyfin/sign-in-service.js";
export {
  canonicalLocalReturnPath,
  canonicalOidcCallbackUri,
  LOCAL_OIDC_BROWSER_BINDING_COOKIE_NAME,
  OIDC_BROWSER_BINDING_COOKIE_NAME,
  OIDC_TRANSACTION_TTL_MS,
  oidcBrowserBindingCookieName,
  OidcAuthorizationTransactionError,
  OidcAuthorizationTransactionService,
  type ConsumeOidcAuthorizationTransactionInput,
  type ConsumedOidcAuthorizationTransaction,
  type CreatedOidcAuthorizationTransaction,
  type CreateOidcAuthorizationTransactionInput,
  type OidcAuthorizationTransactionConfig,
  type OidcAuthorizationTransactionDependencies,
  type OidcAuthorizationTransactionErrorCode,
  type OidcBrowserBindingCookieWriter,
  writeOidcBrowserBindingCookie,
} from "./auth/oidc/authorization-transaction.js";
export {
  OidcProviderRegistry,
  OidcProviderRegistryError,
  OIDC_PROVIDER_RUNTIME_CACHE_MAX_ENTRIES,
  OIDC_PROVIDER_RUNTIME_CACHE_TTL_MS,
  oidcClientSecretEncryptionContext,
  type DiscoveredOidcProvider,
  type IdTokenSigningAlgorithm,
  type OidcProviderCapabilities,
  type OidcProviderRegistryConfig,
  type OidcProviderRegistryDependencies,
  type OidcProviderRegistryErrorCode,
  type TokenEndpointAuthMethod,
} from "./auth/oidc/provider-registry.js";
export { revokeRecoverySessionsOnStartup } from "./auth/recovery-session.js";
export {
  clearSessionCookie,
  LOCAL_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_CSRF_HEADER,
  sessionCookieName,
  writeSessionCookie,
} from "./auth/session-cookie.js";
export {
  SessionService,
  type CreateSessionInput,
  type IssuedSession,
  type ResolvedSession,
  type SessionAttribution,
  type SessionRequestContext,
  type SessionServiceDependencies,
} from "./auth/session-service.js";
export { loadConfig, type AppConfig } from "./config.js";
export { openDatabase, type DatabaseHandle } from "./db/client.js";
export * as databaseSchema from "./db/schema.js";
export { SafeHttpError } from "./http-error.js";
export {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  privacyHash,
  type PrivacyHashDomain,
  randomToken,
} from "./security/crypto.js";
