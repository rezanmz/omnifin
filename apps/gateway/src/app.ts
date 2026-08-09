import cookie from "@fastify/cookie";
import formBody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { createApiError } from "@omnifin/contracts/errors";
import type { RuntimeIdentity } from "@omnifin/contracts/runtime";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  acquisitionCalendarRoutes,
  type AcquisitionCalendarRoutesOptions,
} from "./acquisitions/calendar-routes.js";
import {
  acquisitionProvenanceRoutes,
  type AcquisitionProvenanceRoutesOptions,
} from "./acquisitions/provenance-routes.js";
import {
  manualReleaseRoutes,
  type ManualReleaseRoutesOptions,
} from "./acquisitions/manual-release-routes.js";
import { auditTrailRoutes, type AuditTrailRoutesOptions } from "./audit/audit-trail-routes.js";
import { appearanceRoutes } from "./auth/appearance-routes.js";
import {
  invitationAdminRoutes,
  type InvitationAdminRoutesOptions,
} from "./auth/invitation-admin-routes.js";
import {
  invitationPublicRoutes,
  type InvitationPublicRoutesOptions,
} from "./auth/invitation-public-routes.js";
import { authProviderRoutes } from "./auth/provider-routes.js";
import { identityLinkRoutes, type IdentityLinkRoutesOptions } from "./auth/identity-link-routes.js";
import { bootstrapConfiguredJellyfinConnector } from "./auth/jellyfin/connector-registry.js";
import type { JellyfinQuickConnectServiceDependencies } from "./auth/jellyfin/quick-connect-service.js";
import { jellyfinRoutes, type JellyfinRoutesOptions } from "./auth/jellyfin/routes.js";
import { oidcRoutes, type OidcRoutesDependencies } from "./auth/oidc/routes.js";
import {
  oidcProviderAdminRoutes,
  type OidcProviderAdminRoutesOptions,
} from "./auth/oidc/provider-admin-routes.js";
import {
  oidcRoleMappingAdminRoutes,
  type OidcRoleMappingAdminRoutesOptions,
} from "./auth/oidc/role-mapping-admin-routes.js";
import {
  OidcBackchannelLogoutError,
  OidcBackchannelLogoutService,
} from "./auth/oidc/backchannel-logout.js";
import { recoveryRoutes, type RecoveryRoutesOptions } from "./auth/recovery-routes.js";
import { revokeRecoverySessionsOnStartup } from "./auth/recovery-session.js";
import { SESSION_CSRF_HEADER, sessionCookieName } from "./auth/session-cookie.js";
import { sessionRoutes } from "./auth/session-routes.js";
import {
  SessionService,
  type SessionServiceDependencies,
  type ValidatedSession,
} from "./auth/session-service.js";
import {
  userAccessAdminRoutes,
  type UserAccessAdminRoutesOptions,
} from "./auth/user-access-admin-routes.js";
import { type AppConfig, loadConfig } from "./config.js";
import {
  assertDatabasePostMigrationChecks,
  initializeDatabase,
  initializeDatabaseKeyVerifier,
  type DatabaseHandle,
  openDatabase,
} from "./db/client.js";
import {
  connectorAdminRoutes,
  type ConnectorAdminRoutesOptions,
} from "./connectors/admin-routes.js";
import {
  discoverySearchRoutes,
  type DiscoverySearchRoutesOptions,
} from "./discovery/search-routes.js";
import { downloadQueueRoutes, type DownloadQueueRoutesOptions } from "./downloads/queue-routes.js";
import { healthRoutes } from "./health.js";
import { isSafeHttpError, SafeHttpError } from "./http-error.js";
import {
  indexerIntelligenceRoutes,
  type IndexerIntelligenceRoutesOptions,
} from "./indexers/intelligence-routes.js";
import {
  libraryOperationRoutes,
  type LibraryOperationRoutesOptions,
} from "./library/operation-routes.js";
import { createLoggerOptions, safeFailureDiagnostics } from "./logger.js";
import { runtimeIdentityRoutes } from "./runtime/identity-routes.js";
import { loadRuntimeIdentity } from "./runtime/identity.js";
import { savedListRoutes, type SavedListRoutesOptions } from "./saved/list-routes.js";
import { purgeExpiredSavedState, SAVED_MAINTENANCE_INTERVAL_MS } from "./saved/maintenance.js";
import { savedTargetRoutes, type SavedTargetRoutesOptions } from "./saved/target-routes.js";
import {
  continueWatchingRoutes,
  type ContinueWatchingRoutesOptions,
} from "./media/continue-watching-routes.js";
import { playbackIssueRoutes, type PlaybackIssueRoutesOptions } from "./media/issue-routes.js";
import {
  issueWorkbenchRoutes,
  type IssueWorkbenchRoutesOptions,
} from "./media/issue-workbench-routes.js";
import { MAX_PLAYBACK_ASSET_TOKEN_LENGTH } from "./media/playback-limits.js";
import { playbackRoutes, type PlaybackRoutesOptions } from "./media/playback-routes.js";
import {
  originalDownloadRoutes,
  type OriginalDownloadRoutesOptions,
} from "./media/original-download-routes.js";
import {
  playbackPreferenceRoutes,
  type PlaybackPreferenceRoutesOptions,
} from "./media/playback-preference-routes.js";
import {
  mediaRequestRoutes,
  type MediaRequestRoutesOptions,
} from "./requests/media-request-routes.js";
import {
  requestReviewRoutes,
  type RequestReviewRoutesOptions,
} from "./requests/request-review-routes.js";
import { asStartupError } from "./startup-error.js";
import { clientNetworkGroup } from "./security/client-network.js";
import { installRequestPolicy } from "./security/request-policy.js";
import {
  setupReadinessRoutes,
  type SetupReadinessRoutesOptions,
} from "./setup/readiness-routes.js";
import {
  deploymentReadinessRoutes,
  type DeploymentReadinessRoutesOptions,
} from "./setup/deployment-readiness-routes.js";
import {
  stackVerificationRoutes,
  type StackVerificationRoutesOptions,
} from "./setup/stack-verification-routes.js";
import {
  subtitleOperationRoutes,
  type SubtitleOperationRoutesOptions,
} from "./subtitles/operation-routes.js";
import { systemStatusRoutes, type SystemStatusRoutesOptions } from "./system/status-routes.js";

declare module "fastify" {
  interface FastifyInstance {
    appConfig: AppConfig;
    database: DatabaseHandle;
    sessionService: SessionService;
  }

  interface FastifyRequest {
    validatedSession: ValidatedSession | null;
  }
}

export interface CreateAppOptions {
  config?: AppConfig;
  database?: DatabaseHandle;
  migrate?: boolean;
  oidcDependencies?: OidcRoutesDependencies;
  oidcProviderAdminDependencies?: OidcProviderAdminRoutesOptions["dependencies"];
  oidcRoleMappingAdminDependencies?: OidcRoleMappingAdminRoutesOptions["dependencies"];
  userAccessAdminDependencies?: UserAccessAdminRoutesOptions["dependencies"];
  invitationAdminDependencies?: InvitationAdminRoutesOptions["dependencies"];
  invitationPublicDependencies?: InvitationPublicRoutesOptions["dependencies"];
  auditTrailDependencies?: AuditTrailRoutesOptions["dependencies"];
  jellyfinDependencies?: JellyfinRoutesOptions["dependencies"];
  jellyfinQuickConnectDependencies?: JellyfinQuickConnectServiceDependencies;
  identityLinkDependencies?: IdentityLinkRoutesOptions["dependencies"];
  connectorAdminDependencies?: ConnectorAdminRoutesOptions["dependencies"];
  discoverySearchDependencies?: DiscoverySearchRoutesOptions["dependencies"];
  downloadQueueDependencies?: DownloadQueueRoutesOptions["dependencies"];
  downloadQueueEventDependencies?: DownloadQueueRoutesOptions["eventDependencies"];
  continueWatchingDependencies?: ContinueWatchingRoutesOptions["dependencies"];
  originalDownloadDependencies?: OriginalDownloadRoutesOptions["dependencies"];
  playbackIssueDependencies?: PlaybackIssueRoutesOptions["dependencies"];
  issueWorkbenchDependencies?: IssueWorkbenchRoutesOptions["dependencies"];
  playbackDependencies?: PlaybackRoutesOptions["dependencies"];
  playbackPreferenceDependencies?: PlaybackPreferenceRoutesOptions["dependencies"];
  subtitleOperationDependencies?: SubtitleOperationRoutesOptions["dependencies"];
  libraryOperationDependencies?: LibraryOperationRoutesOptions["dependencies"];
  savedListDependencies?: SavedListRoutesOptions["dependencies"];
  savedTargetDependencies?: SavedTargetRoutesOptions["dependencies"];
  mediaRequestDependencies?: MediaRequestRoutesOptions["dependencies"];
  requestReviewDependencies?: RequestReviewRoutesOptions["dependencies"];
  acquisitionProvenanceDependencies?: AcquisitionProvenanceRoutesOptions["dependencies"];
  acquisitionProvenanceEventDependencies?: AcquisitionProvenanceRoutesOptions["eventDependencies"];
  acquisitionCalendarDependencies?: AcquisitionCalendarRoutesOptions["dependencies"];
  manualReleaseDependencies?: ManualReleaseRoutesOptions["dependencies"];
  indexerIntelligenceDependencies?: IndexerIntelligenceRoutesOptions["dependencies"];
  systemStatusDependencies?: SystemStatusRoutesOptions["dependencies"];
  systemStatusEventDependencies?: SystemStatusRoutesOptions["eventDependencies"];
  setupReadinessDependencies?: SetupReadinessRoutesOptions["dependencies"];
  deploymentReadinessDependencies?: DeploymentReadinessRoutesOptions["dependencies"];
  stackVerificationDependencies?: StackVerificationRoutesOptions["dependencies"];
  recoveryAccessDependencies?: RecoveryRoutesOptions["dependencies"];
  runtimeIdentity?: RuntimeIdentity;
  sessionDependencies?: SessionServiceDependencies;
}

function requestId(incomingId: string | undefined) {
  if (incomingId && /^[a-zA-Z0-9_-]{8,64}$/.test(incomingId)) return incomingId;
  return randomUUID();
}

function frameworkErrorStatus(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : 500;
}

function sessionCsrfProof(request: FastifyRequest) {
  if (request.method !== "POST" || request.routeOptions.url !== "/v1/auth/oidc/logout") {
    return request.headers[SESSION_CSRF_HEADER];
  }
  if (request.headers[SESSION_CSRF_HEADER] !== undefined) return undefined;
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
  ) {
    return undefined;
  }
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return undefined;
  }
  const body = request.body as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "csrfToken")) return undefined;
  const csrfToken = Object.getOwnPropertyDescriptor(body, "csrfToken");
  return csrfToken && "value" in csrfToken && typeof csrfToken.value === "string"
    ? csrfToken.value
    : undefined;
}

function oidcBackchannelRequest(request: FastifyRequest) {
  if (
    request.method !== "POST" ||
    request.routeOptions.url !== "/v1/auth/oidc/backchannel/:providerId"
  ) {
    return undefined;
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim()) ||
    !request.body ||
    typeof request.body !== "object" ||
    Array.isArray(request.body) ||
    !request.params ||
    typeof request.params !== "object" ||
    Array.isArray(request.params)
  ) {
    return undefined;
  }
  const logoutToken = Object.getOwnPropertyDescriptor(request.body, "logout_token");
  const providerId = Object.getOwnPropertyDescriptor(request.params, "providerId");
  if (
    !logoutToken ||
    !("value" in logoutToken) ||
    typeof logoutToken.value !== "string" ||
    !providerId ||
    !("value" in providerId) ||
    typeof providerId.value !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({ logoutToken: logoutToken.value, providerId: providerId.value });
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const startupPrepared = options.database === undefined && options.migrate !== false;
  const database =
    options.database ??
    (startupPrepared
      ? await initializeDatabase({
          backupDirectory: config.backupDirectory ?? "/backups",
          backupRetentionCount: config.backupRetentionCount ?? 14,
          databaseUrl: config.databaseUrl,
          ...(config.imageReference ? { imageReference: config.imageReference } : {}),
          rootKey: config.encryptionKey,
        })
      : openDatabase(config.databaseUrl));
  let databaseClosed = false;
  const closeDatabase = () => {
    if (databaseClosed) return;
    databaseClosed = true;
    database.close();
  };
  let app: FastifyInstance | undefined;

  try {
    const runtimeIdentity = options.runtimeIdentity ?? loadRuntimeIdentity();
    if (options.migrate !== false && !startupPrepared) {
      try {
        database.migrate();
        initializeDatabaseKeyVerifier(database.sqlite, config.encryptionKey);
        assertDatabasePostMigrationChecks(database.sqlite, config.encryptionKey);
      } catch (error) {
        throw asStartupError(error, "database_migration_failed");
      }
    }
    let sessionsTableExists: boolean;
    try {
      sessionsTableExists = Boolean(
        database.sqlite
          .prepare("select 1 from sqlite_master where type = 'table' and name = 'sessions'")
          .get(),
      );
    } catch (error) {
      throw asStartupError(error, "database_initialization_failed");
    }
    if (options.migrate !== false || sessionsTableExists) {
      try {
        revokeRecoverySessionsOnStartup(database);
      } catch (error) {
        throw asStartupError(error, "database_initialization_failed");
      }
    }
    if (options.migrate !== false) {
      try {
        bootstrapConfiguredJellyfinConnector(database, config);
      } catch (error) {
        throw asStartupError(error, "jellyfin_configuration_invalid");
      }
    }

    app = Fastify({
      bodyLimit: 64 * 1_024,
      genReqId: (request) => requestId(request.headers["x-request-id"] as string | undefined),
      logger: createLoggerOptions(config),
      requestIdHeader: false,
      routerOptions: { maxParamLength: MAX_PLAYBACK_ASSET_TOKEN_LENGTH },
      trustProxy: config.trustProxyHops,
    });

    app.decorate("appConfig", config);
    app.decorate("database", database);
    const sessionService = new SessionService(database, config, options.sessionDependencies);
    const backchannelDependencies = options.oidcDependencies?.backchannelLogout;
    const oidcBackchannelLogout = new OidcBackchannelLogoutService(database, config, {
      ...(backchannelDependencies ?? {}),
      ...(options.oidcDependencies?.providerRegistry === undefined
        ? {}
        : { providerRegistry: options.oidcDependencies.providerRegistry }),
    });
    app.decorate("sessionService", sessionService);
    app.decorateRequest("validatedSession", null);

    app.addHook("onRequest", async (request, reply) => {
      reply.header("x-request-id", request.id);
      reply.header(
        "permissions-policy",
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      );
    });

    await app.register(cookie, { hook: "onRequest" });
    await app.register(formBody, { bodyLimit: 64 * 1_024 });
    await app.register(sensible);
    await app.register(rateLimit, {
      global: false,
      max: 300,
      timeWindow: "1 minute",
      hook: "onRequest",
      keyGenerator: (request) => clientNetworkGroup(request.ip),
    });
    const globalRateLimit = app.createRateLimit();
    app.addHook("onRequest", async (request, reply) => {
      const result = await globalRateLimit(request);
      if (result.isAllowed || !result.isExceeded) return;
      reply.header("x-ratelimit-limit", result.max);
      reply.header("x-ratelimit-remaining", 0);
      reply.header("x-ratelimit-reset", result.ttlInSeconds);
      reply.header("retry-after", result.ttlInSeconds);
      throw request.server.httpErrors.tooManyRequests("Rate limit exceeded.");
    });
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      frameguard: { action: "deny" },
      hsts: config.environment === "production" ? { maxAge: 63_072_000, preload: true } : false,
      permittedCrossDomainPolicies: { permittedPolicies: "none" },
      referrerPolicy: { policy: "no-referrer" },
    });

    installRequestPolicy(app, {
      allowedOrigin: config.baseUrl.origin,
      validateOidcBackchannel: async (request) => {
        const input = oidcBackchannelRequest(request);
        if (!input) return false;
        try {
          await oidcBackchannelLogout.process({ ...input, requestId: request.id });
          return true;
        } catch (error) {
          if (
            error instanceof OidcBackchannelLogoutError &&
            error.code === "logout_storage_failed"
          ) {
            throw new SafeHttpError({
              code: "backchannel_temporarily_unavailable",
              message: "The logout request could not be completed.",
              statusCode: 503,
            });
          }
          return false;
        }
      },
      validateSessionCsrf: (request) => {
        const validatedSession = sessionService.validateSessionCsrf(
          request.cookies[sessionCookieName(config)],
          sessionCsrfProof(request),
          { ipAddress: request.ip, requestId: request.id },
        );
        request.validatedSession = validatedSession;
        return validatedSession !== null;
      },
    });

    app.setErrorHandler(async (error, request, reply) => {
      const handledError = error as Error & {
        code?: string;
        statusCode?: number;
        validation?: unknown;
      };
      const validationFailure = handledError.validation || handledError instanceof ZodError;
      const safeHttpError = isSafeHttpError(error) ? error : undefined;
      const statusCode = validationFailure
        ? 400
        : (safeHttpError?.statusCode ?? frameworkErrorStatus(handledError.statusCode));
      const publicCode = safeHttpError
        ? safeHttpError.code
        : validationFailure
          ? "invalid_request"
          : statusCode >= 500
            ? "internal_error"
            : "request_failed";
      const publicMessage = safeHttpError
        ? safeHttpError.message
        : statusCode >= 500
          ? "The gateway could not complete the request."
          : validationFailure
            ? "The request did not match the expected shape."
            : "The gateway rejected the request.";
      if (statusCode >= 500) {
        request.log.error(
          {
            err: handledError,
            ...safeFailureDiagnostics(handledError),
            operation: "http.request",
            requestId: request.id,
          },
          "Request failed",
        );
      } else {
        request.log.warn(
          {
            errorCode: publicCode,
            operation: "http.request",
            requestId: request.id,
            statusCode,
          },
          "Request rejected",
        );
      }

      await reply.status(statusCode).send(
        createApiError({
          code: publicCode,
          message: publicMessage,
          requestId: request.id,
          ...(safeHttpError?.details === undefined ? {} : { details: safeHttpError.details }),
        }),
      );
    });

    app.setNotFoundHandler(async (request, reply) => {
      await reply.status(404).send(
        createApiError({
          code: "request_failed",
          message: "The requested resource does not exist.",
          requestId: request.id,
        }),
      );
    });

    const savedMaintenance = setInterval(() => {
      try {
        purgeExpiredSavedState(database, Date.now());
      } catch (error) {
        app?.log.error(
          { err: error, operation: "saved.maintenance" },
          "Saved-state maintenance failed",
        );
      }
    }, SAVED_MAINTENANCE_INTERVAL_MS);
    savedMaintenance.unref();
    app.addHook("onClose", async () => {
      clearInterval(savedMaintenance);
      closeDatabase();
    });

    await app.register(healthRoutes);
    await app.register(runtimeIdentityRoutes, { identity: runtimeIdentity });
    await app.register(authProviderRoutes);
    await app.register(connectorAdminRoutes, {
      ...(options.connectorAdminDependencies === undefined
        ? {}
        : { dependencies: options.connectorAdminDependencies }),
    });
    await app.register(discoverySearchRoutes, {
      ...(options.discoverySearchDependencies === undefined
        ? {}
        : { dependencies: options.discoverySearchDependencies }),
    });
    await app.register(downloadQueueRoutes, {
      ...(options.downloadQueueDependencies === undefined
        ? {}
        : { dependencies: options.downloadQueueDependencies }),
      ...(options.downloadQueueEventDependencies === undefined
        ? {}
        : { eventDependencies: options.downloadQueueEventDependencies }),
    });
    await app.register(continueWatchingRoutes, {
      ...(options.continueWatchingDependencies === undefined
        ? {}
        : { dependencies: options.continueWatchingDependencies }),
    });
    await app.register(originalDownloadRoutes, {
      ...(options.originalDownloadDependencies === undefined
        ? {}
        : { dependencies: options.originalDownloadDependencies }),
    });
    await app.register(playbackRoutes, {
      ...(options.playbackDependencies === undefined
        ? {}
        : { dependencies: options.playbackDependencies }),
    });
    await app.register(playbackPreferenceRoutes, {
      ...(options.playbackPreferenceDependencies === undefined
        ? {}
        : { dependencies: options.playbackPreferenceDependencies }),
    });
    await app.register(playbackIssueRoutes, {
      ...(options.playbackIssueDependencies === undefined
        ? {}
        : { dependencies: options.playbackIssueDependencies }),
    });
    await app.register(issueWorkbenchRoutes, {
      ...(options.issueWorkbenchDependencies === undefined
        ? {}
        : { dependencies: options.issueWorkbenchDependencies }),
    });
    await app.register(subtitleOperationRoutes, {
      ...(options.subtitleOperationDependencies === undefined
        ? {}
        : { dependencies: options.subtitleOperationDependencies }),
    });
    await app.register(libraryOperationRoutes, {
      ...(options.libraryOperationDependencies === undefined
        ? {}
        : { dependencies: options.libraryOperationDependencies }),
    });
    await app.register(savedListRoutes, {
      ...(options.continueWatchingDependencies === undefined
        ? {}
        : { artworkDependencies: options.continueWatchingDependencies }),
      ...(options.savedListDependencies === undefined
        ? {}
        : { dependencies: options.savedListDependencies }),
    });
    await app.register(savedTargetRoutes, {
      ...(options.savedTargetDependencies === undefined
        ? {}
        : { dependencies: options.savedTargetDependencies }),
    });
    await app.register(mediaRequestRoutes, {
      ...(options.mediaRequestDependencies === undefined
        ? {}
        : { dependencies: options.mediaRequestDependencies }),
    });
    await app.register(requestReviewRoutes, {
      ...(options.requestReviewDependencies === undefined
        ? {}
        : { dependencies: options.requestReviewDependencies }),
    });
    await app.register(acquisitionProvenanceRoutes, {
      ...(options.acquisitionProvenanceDependencies === undefined
        ? {}
        : { dependencies: options.acquisitionProvenanceDependencies }),
      ...(options.acquisitionProvenanceEventDependencies === undefined
        ? {}
        : { eventDependencies: options.acquisitionProvenanceEventDependencies }),
    });
    await app.register(acquisitionCalendarRoutes, {
      ...(options.acquisitionCalendarDependencies === undefined
        ? {}
        : { dependencies: options.acquisitionCalendarDependencies }),
    });
    await app.register(manualReleaseRoutes, {
      ...(options.manualReleaseDependencies === undefined
        ? {}
        : { dependencies: options.manualReleaseDependencies }),
    });
    await app.register(indexerIntelligenceRoutes, {
      ...(options.indexerIntelligenceDependencies === undefined
        ? {}
        : { dependencies: options.indexerIntelligenceDependencies }),
    });
    await app.register(systemStatusRoutes, {
      ...(options.systemStatusDependencies === undefined
        ? {}
        : { dependencies: options.systemStatusDependencies }),
      ...(options.systemStatusEventDependencies === undefined
        ? {}
        : { eventDependencies: options.systemStatusEventDependencies }),
    });
    await app.register(setupReadinessRoutes, {
      ...(options.setupReadinessDependencies === undefined
        ? {}
        : { dependencies: options.setupReadinessDependencies }),
    });
    await app.register(deploymentReadinessRoutes, {
      ...(options.deploymentReadinessDependencies === undefined
        ? {}
        : { dependencies: options.deploymentReadinessDependencies }),
    });
    await app.register(stackVerificationRoutes, {
      ...(options.stackVerificationDependencies === undefined
        ? {}
        : { dependencies: options.stackVerificationDependencies }),
    });
    await app.register(oidcProviderAdminRoutes, {
      ...(options.oidcProviderAdminDependencies === undefined
        ? {}
        : { dependencies: options.oidcProviderAdminDependencies }),
    });
    await app.register(oidcRoleMappingAdminRoutes, {
      ...(options.oidcRoleMappingAdminDependencies === undefined
        ? {}
        : { dependencies: options.oidcRoleMappingAdminDependencies }),
    });
    await app.register(userAccessAdminRoutes, {
      ...(options.userAccessAdminDependencies === undefined
        ? {}
        : { dependencies: options.userAccessAdminDependencies }),
    });
    await app.register(invitationAdminRoutes, {
      ...(options.invitationAdminDependencies === undefined
        ? {}
        : { dependencies: options.invitationAdminDependencies }),
    });
    await app.register(invitationPublicRoutes, {
      ...(options.invitationPublicDependencies === undefined
        ? {}
        : { dependencies: options.invitationPublicDependencies }),
    });
    await app.register(auditTrailRoutes, {
      ...(options.auditTrailDependencies === undefined
        ? {}
        : { dependencies: options.auditTrailDependencies }),
    });
    await app.register(jellyfinRoutes, {
      ...(options.jellyfinDependencies === undefined
        ? {}
        : { dependencies: options.jellyfinDependencies }),
      ...(options.jellyfinQuickConnectDependencies === undefined
        ? {}
        : { quickConnectDependencies: options.jellyfinQuickConnectDependencies }),
    });
    await app.register(
      oidcRoutes,
      options.oidcDependencies === undefined ? {} : { dependencies: options.oidcDependencies },
    );
    await app.register(
      recoveryRoutes,
      options.recoveryAccessDependencies === undefined
        ? {}
        : { dependencies: options.recoveryAccessDependencies },
    );
    await app.register(sessionRoutes);
    await app.register(appearanceRoutes);
    await app.register(
      identityLinkRoutes,
      options.identityLinkDependencies === undefined
        ? {}
        : { dependencies: options.identityLinkDependencies },
    );
    return app;
  } catch (initializationError) {
    const cleanupErrors: unknown[] = [];
    if (app) {
      try {
        await app.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      closeDatabase();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [initializationError, ...cleanupErrors],
        "Gateway initialization failed and cleanup did not complete.",
      );
    }
    throw initializationError;
  }
}
