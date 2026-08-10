import {
  JellyfinAuthenticationClient,
  type JellyfinAuthenticationResult,
  type JellyfinPublicSystemInfo,
} from "@omnifin/connectors/auth/jellyfin-authentication-client";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import { createHmac, randomUUID } from "node:crypto";
import type {
  AdministratorRecoveryConfirmationRequest,
  AdministratorRecoveryTarget,
} from "@omnifin/contracts/auth";

import type { AppConfig } from "../../config.js";
import type { ConnectorHttpLane } from "@omnifin/connectors/http/connector-http-lane";
import type { ConnectorHttpLaneLifecycle } from "../../connectors/http-lane-registry.js";
import type { DatabaseHandle } from "../../db/client.js";
import { EnvelopeCipher } from "../../security/crypto.js";
import {
  InvitationService,
  InvitationServiceError,
  type InvitationRegistrationHandoffInput,
} from "../invitation-service.js";
import {
  AdministratorRecoveryService,
  type AdministratorRecoveryReplacementResult,
} from "../administrator-recovery-service.js";
import {
  SessionIssuanceLimitError,
  type CreateSessionInput,
  type IssuedSession,
  type SessionService,
  type ValidatedOidcPairingSession,
} from "../session-service.js";
import {
  JellyfinConnectorConfigurationError,
  JellyfinConnectorRegistry,
  type JellyfinConnectorTarget,
} from "./connector-registry.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const DISPLAY_WHITESPACE = /\s+/gu;

interface ExistingLinkRow {
  connectorId: string;
  connectorInstanceGeneration: number;
  createdAt: number;
  externalServerId: string;
  externalUserId: string;
  healthState: string;
  id: string;
  linkUserId: string;
  revision: number;
  service: string;
  userId: string | null;
  userRole: string | null;
  userRoleSource: string | null;
  userStatus: string | null;
}

export interface JellyfinPasswordSignInInput {
  readonly currentSessionToken?: unknown;
  readonly ipAddress?: string;
  readonly password: string;
  readonly requestId?: string;
  readonly userAgent?: string;
  readonly username: string;
}

export interface JellyfinPasswordPairingInput extends Omit<
  JellyfinPasswordSignInInput,
  "currentSessionToken"
> {
  readonly validatedSession?: unknown;
}

export interface JellyfinPasswordBootstrapInput extends Omit<
  JellyfinPasswordSignInInput,
  "currentSessionToken"
> {
  readonly validatedSession?: unknown;
}

export interface JellyfinPasswordAdministratorReplacementInput
  extends
    Omit<JellyfinPasswordSignInInput, "currentSessionToken">,
    AdministratorRecoveryConfirmationRequest {
  readonly validatedSession?: unknown;
}

export interface JellyfinAuthenticatedSignInInput {
  readonly authentication: JellyfinAuthenticationResult;
  readonly currentSessionToken?: unknown;
  readonly deviceId: string;
  readonly ipAddress?: string;
  readonly proof: "password" | "quick_connect";
  readonly requestId?: string;
  readonly target: JellyfinConnectorTarget;
  readonly userAgent?: string;
  readonly registrationHandoff?: InvitationRegistrationHandoffInput;
}

export interface JellyfinAuthenticatedPairingInput {
  readonly authentication: JellyfinAuthenticationResult;
  readonly deviceId: string;
  readonly ipAddress?: string;
  readonly proof: "password" | "quick_connect";
  readonly requestId?: string;
  readonly target: JellyfinConnectorTarget;
  readonly userAgent?: string;
  readonly validatedSession?: unknown;
}

export interface JellyfinAuthenticatedBootstrapInput extends Omit<
  JellyfinAuthenticatedPairingInput,
  "validatedSession"
> {
  readonly validatedSession?: unknown;
}

export interface JellyfinAuthenticatedAdministratorReplacementInput
  extends
    Omit<JellyfinAuthenticatedPairingInput, "validatedSession">,
    AdministratorRecoveryConfirmationRequest {
  readonly validatedSession?: unknown;
}

export type JellyfinSignInDenialReason =
  "account_disabled" | "invalid_credentials" | "invitation_identity_already_exists";

export interface JellyfinSignInDeniedResult {
  readonly reason: JellyfinSignInDenialReason;
  readonly status: "denied";
  toJSON(): never;
}

export interface JellyfinSignInSuccessResult {
  readonly session: IssuedSession;
  readonly status: "signed_in";
  toJSON(): never;
}

export type JellyfinSignInResult = JellyfinSignInDeniedResult | JellyfinSignInSuccessResult;

export type JellyfinPairingDenialReason =
  | "account_disabled"
  | "identity_already_linked"
  | "invalid_credentials"
  | "link_already_exists"
  | "pairing_session_required";

export interface JellyfinPairingDeniedResult {
  readonly reason: JellyfinPairingDenialReason;
  readonly status: "denied";
  toJSON(): never;
}

export interface JellyfinPairingSuccessResult {
  readonly session: IssuedSession;
  readonly status: "paired";
  toJSON(): never;
}

export type JellyfinPairingResult = JellyfinPairingDeniedResult | JellyfinPairingSuccessResult;

export type JellyfinBootstrapDenialReason =
  | "account_disabled"
  | "administrator_already_exists"
  | "invalid_credentials"
  | "jellyfin_admin_required"
  | "recovery_session_required";

export interface JellyfinBootstrapDeniedResult {
  readonly reason: JellyfinBootstrapDenialReason;
  readonly status: "denied";
  toJSON(): never;
}

export interface JellyfinBootstrapSuccessResult {
  readonly session: IssuedSession;
  readonly status: "bootstrapped";
  toJSON(): never;
}

export type JellyfinBootstrapResult =
  JellyfinBootstrapDeniedResult | JellyfinBootstrapSuccessResult;

export interface JellyfinSignInServiceDependencies {
  readonly clock?: () => Date;
  readonly createClient?: (
    target: JellyfinConnectorTarget & { readonly lane?: ConnectorHttpLane },
  ) => Pick<JellyfinAuthenticationClient, "authenticateByName" | "getPublicSystemInfo">;
  readonly createDeviceId?: () => string;
  readonly createId?: () => string;
  readonly invitationService?: InvitationService;
  readonly laneProvider?: ConnectorHttpLaneLifecycle;
}

export class JellyfinSignInServiceError extends Error {
  public readonly code = "jellyfin_sign_in_failed";
  public readonly reason: "configuration_invalid" | "provider_unavailable" | "server_mismatch";

  public constructor(reason: JellyfinSignInServiceError["reason"], options?: ErrorOptions) {
    super("Jellyfin sign-in could not be completed.", options);
    this.name = "JellyfinSignInServiceError";
    this.reason = reason;
  }
}

function internalResult<T extends Readonly<Record<string, unknown>>>(
  properties: T,
): Readonly<T> & { toJSON(): never } {
  const result = Object.create(null) as T & { toJSON(): never };
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(result, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  Object.defineProperty(result, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => {
      throw new TypeError("Jellyfin sign-in results cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(result);
}

function normalizedDisplayText(value: string, maximumLength: number) {
  const normalized = value
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, "")
    .replace(DISPLAY_WHITESPACE, " ")
    .trim();
  if (normalized.length < 1 || normalized.length > maximumLength) {
    throw new JellyfinSignInServiceError("provider_unavailable");
  }
  return normalized;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

export class JellyfinSignInService {
  readonly #cipher: EnvelopeCipher;
  readonly #administratorRecovery: AdministratorRecoveryService;
  readonly #clock: () => Date;
  readonly #createClient: NonNullable<JellyfinSignInServiceDependencies["createClient"]>;
  readonly #createDeviceId: () => string;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #identityHashKey: Buffer;
  readonly #invitations: InvitationService | undefined;
  readonly #registry: JellyfinConnectorRegistry;
  readonly #sessionService: SessionService;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    sessionService: SessionService,
    dependencies: JellyfinSignInServiceDependencies = {},
  ) {
    if (!sessionService.isBoundToDatabase(database)) {
      throw new JellyfinSignInServiceError("configuration_invalid");
    }
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#identityHashKey = Buffer.from(config.encryptionKey);
    this.#invitations =
      dependencies.invitationService ?? new InvitationService(database, config as AppConfig);
    this.#administratorRecovery = new AdministratorRecoveryService(
      database,
      sessionService,
      config,
      {
        ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      },
    );
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createClient =
      dependencies.createClient === undefined
        ? (target) =>
            new JellyfinAuthenticationClient({
              baseUrl: target.baseUrl,
              connectorId: target.connectorId,
              displayName: target.displayName,
              insecureHttpApproved: target.insecureHttpApproved,
              ...(dependencies.laneProvider === undefined
                ? {}
                : { lane: dependencies.laneProvider.laneFor("jellyfin", target.connectorId) }),
              tlsPolicy: target.tlsPolicy ?? "strict",
              ...(target.tlsCaCertificatePem === undefined
                ? {}
                : { tlsCaCertificatePem: target.tlsCaCertificatePem }),
            })
        : (target) =>
            dependencies.createClient!({
              ...target,
              ...(dependencies.laneProvider === undefined
                ? {}
                : { lane: dependencies.laneProvider.laneFor("jellyfin", target.connectorId) }),
            });
    this.#createDeviceId = dependencies.createDeviceId ?? randomUUID;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#registry = new JellyfinConnectorRegistry(database, config.encryptionKey);
    this.#sessionService = sessionService;
  }

  public toJSON(): never {
    throw new TypeError("Jellyfin sign-in services cannot be serialized.");
  }

  /** @internal Resolves only the exact pending OIDC session eligible for account pairing. */
  public resolveEligiblePairingSession(validatedSession: unknown) {
    return this.#sessionService.beginValidatedOidcPairingSession(validatedSession);
  }

  /** @internal Resolves only the exact recovery session eligible for first-admin bootstrap. */
  public resolveEligibleRecoveryBootstrapSession(validatedSession: unknown) {
    return this.#sessionService.beginValidatedRecoveryBootstrapSession(validatedSession);
  }

  /** @internal Resolves an exact recovery session and optional administrator target. */
  public resolveEligibleAdministratorReplacementSession(
    validatedSession: unknown,
    target?: AdministratorRecoveryTarget,
  ) {
    return this.#administratorRecovery.beginValidatedReplacement(validatedSession, target);
  }

  public async signInWithPassword(
    input: JellyfinPasswordSignInInput,
  ): Promise<JellyfinSignInResult> {
    this.#validatePasswordInput(input);
    let target: JellyfinConnectorTarget;
    try {
      target = this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinSignInServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(target);
    let publicInfo: JellyfinPublicSystemInfo;
    let authentication: JellyfinAuthenticationResult;
    try {
      publicInfo = await client.getPublicSystemInfo();
      if (!this.#serverIdentityMatchesTarget(publicInfo.Id, target)) {
        throw new JellyfinSignInServiceError("server_mismatch");
      }
      authentication = await client.authenticateByName({
        deviceId,
        password: input.password,
        username: input.username,
      });
    } catch (error) {
      if (error instanceof SafeConnectorError && error.code === "invalid_credentials") {
        return internalResult({
          reason: "invalid_credentials" as const,
          status: "denied" as const,
        });
      }
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
    if (
      publicInfo.Id !== authentication.ServerId ||
      !this.#serverIdentityMatchesTarget(publicInfo.Id, target)
    ) {
      throw new JellyfinSignInServiceError("server_mismatch");
    }

    return this.#reconcileAndIssueSession({
      authentication,
      deviceId,
      requestContext: input,
      proof: "password",
      target,
    });
  }

  public async signInWithInvitationPassword(
    input: JellyfinPasswordSignInInput & {
      readonly registrationHandoff: InvitationRegistrationHandoffInput;
    },
  ): Promise<JellyfinSignInResult> {
    this.#validatePasswordInput(input);
    const target = this.#resolveConnectorTarget();
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(target);
    let publicInfo: JellyfinPublicSystemInfo;
    let authentication: JellyfinAuthenticationResult;
    try {
      publicInfo = await client.getPublicSystemInfo();
      if (!this.#serverIdentityMatchesTarget(publicInfo.Id, target)) {
        throw new JellyfinSignInServiceError("server_mismatch");
      }
      authentication = await client.authenticateByName({
        deviceId,
        password: input.password,
        username: input.username,
      });
    } catch (error) {
      if (error instanceof SafeConnectorError && error.code === "invalid_credentials") {
        return internalResult({
          reason: "invalid_credentials" as const,
          status: "denied" as const,
        });
      }
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
    if (
      publicInfo.Id !== authentication.ServerId ||
      !this.#serverIdentityMatchesTarget(publicInfo.Id, target)
    ) {
      throw new JellyfinSignInServiceError("server_mismatch");
    }
    return this.completeAuthenticatedSignIn({
      authentication,
      deviceId,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      proof: "password",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      registrationHandoff: input.registrationHandoff,
      target,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    });
  }

  public async pairWithPassword(
    input: JellyfinPasswordPairingInput,
  ): Promise<JellyfinPairingResult> {
    this.#validatePasswordInput(input);
    if (!input.validatedSession) {
      return internalResult({
        reason: "pairing_session_required" as const,
        status: "denied" as const,
      });
    }
    if (!this.#sessionService.beginValidatedOidcPairingSession(input.validatedSession)) {
      return internalResult({
        reason: "pairing_session_required" as const,
        status: "denied" as const,
      });
    }
    let target: JellyfinConnectorTarget;
    try {
      target = this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinSignInServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(target);
    let publicInfo: JellyfinPublicSystemInfo;
    let authentication: JellyfinAuthenticationResult;
    try {
      publicInfo = await client.getPublicSystemInfo();
      if (!this.#serverIdentityMatchesTarget(publicInfo.Id, target)) {
        throw new JellyfinSignInServiceError("server_mismatch");
      }
      authentication = await client.authenticateByName({
        deviceId,
        password: input.password,
        username: input.username,
      });
    } catch (error) {
      if (error instanceof SafeConnectorError && error.code === "invalid_credentials") {
        return internalResult({
          reason: "invalid_credentials" as const,
          status: "denied" as const,
        });
      }
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
    if (
      publicInfo.Id !== authentication.ServerId ||
      !this.#serverIdentityMatchesTarget(publicInfo.Id, target)
    ) {
      throw new JellyfinSignInServiceError("server_mismatch");
    }

    return this.completeAuthenticatedPairing({
      authentication,
      deviceId,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      proof: "password",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      target,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      validatedSession: input.validatedSession,
    });
  }

  public async bootstrapWithPassword(
    input: JellyfinPasswordBootstrapInput,
  ): Promise<JellyfinBootstrapResult> {
    this.#validatePasswordInput(input);
    if (!this.#sessionService.beginValidatedRecoveryBootstrapSession(input.validatedSession)) {
      return internalResult({
        reason: "recovery_session_required" as const,
        status: "denied" as const,
      });
    }
    let target: JellyfinConnectorTarget;
    try {
      target = this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinSignInServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(target);
    let publicInfo: JellyfinPublicSystemInfo;
    let authentication: JellyfinAuthenticationResult;
    try {
      publicInfo = await client.getPublicSystemInfo();
      if (!this.#serverIdentityMatchesTarget(publicInfo.Id, target)) {
        throw new JellyfinSignInServiceError("server_mismatch");
      }
      authentication = await client.authenticateByName({
        deviceId,
        password: input.password,
        username: input.username,
      });
    } catch (error) {
      if (error instanceof SafeConnectorError && error.code === "invalid_credentials") {
        return internalResult({
          reason: "invalid_credentials" as const,
          status: "denied" as const,
        });
      }
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
    if (
      publicInfo.Id !== authentication.ServerId ||
      !this.#serverIdentityMatchesTarget(publicInfo.Id, target)
    ) {
      throw new JellyfinSignInServiceError("server_mismatch");
    }

    return this.completeAuthenticatedBootstrap({
      authentication,
      deviceId,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      proof: "password",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      target,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      validatedSession: input.validatedSession,
    });
  }

  public async replaceAdministratorWithPassword(
    input: JellyfinPasswordAdministratorReplacementInput,
  ): Promise<AdministratorRecoveryReplacementResult> {
    this.#validatePasswordInput(input);
    const target = {
      administratorId: input.administratorId,
      expectedUpdatedAt: input.expectedUpdatedAt,
    };
    if (!this.#administratorRecovery.beginValidatedReplacement(input.validatedSession, target)) {
      return internalResult({
        reason: "state_unavailable" as const,
        status: "unavailable" as const,
      });
    }
    let connectorTarget: JellyfinConnectorTarget;
    try {
      connectorTarget = this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinSignInServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(connectorTarget);
    let publicInfo: JellyfinPublicSystemInfo;
    let authentication: JellyfinAuthenticationResult;
    try {
      publicInfo = await client.getPublicSystemInfo();
      if (!this.#serverIdentityMatchesTarget(publicInfo.Id, connectorTarget)) {
        throw new JellyfinSignInServiceError("server_mismatch");
      }
      authentication = await client.authenticateByName({
        deviceId,
        password: input.password,
        username: input.username,
      });
    } catch (error) {
      if (error instanceof SafeConnectorError && error.code === "invalid_credentials") {
        return internalResult({
          reason: "proof_denied" as const,
          status: "denied" as const,
        });
      }
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
    if (
      publicInfo.Id !== authentication.ServerId ||
      !this.#serverIdentityMatchesTarget(publicInfo.Id, connectorTarget)
    ) {
      throw new JellyfinSignInServiceError("server_mismatch");
    }
    return this.completeAuthenticatedAdministratorReplacement({
      administratorId: input.administratorId,
      authentication,
      confirmation: input.confirmation,
      deviceId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      proof: "password",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      target: connectorTarget,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      validatedSession: input.validatedSession,
    });
  }

  public completeAuthenticatedSignIn(
    input: JellyfinAuthenticatedSignInInput,
  ): JellyfinSignInResult {
    this.#validateAuthenticatedSignInInput(input);
    if (input.registrationHandoff) this.#resolveRegistrationHandoff(input.registrationHandoff);
    return this.#reconcileAndIssueSession({
      authentication: input.authentication,
      deviceId: input.deviceId,
      proof: input.proof,
      requestContext: input,
      ...(input.registrationHandoff === undefined
        ? {}
        : { registrationHandoff: input.registrationHandoff }),
      target: input.target,
    });
  }

  public completeAuthenticatedPairing(
    input: JellyfinAuthenticatedPairingInput,
  ): JellyfinPairingResult {
    this.#validateAuthenticatedPairingInput(input);
    try {
      return this.#database.sqlite
        .transaction(() => {
          const pairingSession = this.#sessionService.beginValidatedOidcPairingSession(
            input.validatedSession,
          );
          if (!pairingSession) {
            return internalResult({
              reason: "pairing_session_required" as const,
              status: "denied" as const,
            });
          }
          const identity = this.#pairIdentity({
            authentication: input.authentication,
            deviceId: input.deviceId,
            occurredAt: pairingSession.operationTime,
            pairingSession,
            proof: input.proof,
            requestContext: input,
            target: input.target,
          });
          if (identity.status === "denied") return identity;
          const session = this.#sessionService.completeValidatedOidcPairingSession(
            pairingSession,
            identity.linkId,
            {
              ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
            },
          );
          return internalResult({ session, status: "paired" as const });
        })
        .immediate();
    } catch (error) {
      if (error instanceof SessionIssuanceLimitError) throw error;
      if (error instanceof InvitationServiceError) throw error;
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
  }

  public completeAuthenticatedBootstrap(
    input: JellyfinAuthenticatedBootstrapInput,
  ): JellyfinBootstrapResult {
    this.#validateAuthenticatedBootstrapInput(input);
    try {
      return this.#database.sqlite
        .transaction(() => {
          const bootstrapSession = this.#sessionService.beginValidatedRecoveryBootstrapSession(
            input.validatedSession,
          );
          if (!bootstrapSession) {
            return internalResult({
              reason: "recovery_session_required" as const,
              status: "denied" as const,
            });
          }
          const identity = this.#bootstrapIdentity({
            authentication: input.authentication,
            deviceId: input.deviceId,
            occurredAt: bootstrapSession.operationTime,
            proof: input.proof,
            requestContext: input,
            target: input.target,
          });
          if (identity.status === "denied") return identity;
          const session = this.#sessionService.completeValidatedRecoveryBootstrapSession(
            bootstrapSession,
            identity.userId,
            identity.linkId,
            {
              ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
            },
          );
          return internalResult({ session, status: "bootstrapped" as const });
        })
        .immediate();
    } catch (error) {
      if (error instanceof SessionIssuanceLimitError) throw error;
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
  }

  public completeAuthenticatedAdministratorReplacement(
    input: JellyfinAuthenticatedAdministratorReplacementInput,
  ): AdministratorRecoveryReplacementResult {
    this.#validateAuthenticatedPairingInput(input);
    if (!this.#serverIdentityMatchesTarget(input.authentication.ServerId, input.target)) {
      throw new JellyfinSignInServiceError("server_mismatch");
    }
    return this.#administratorRecovery.replaceWithJellyfin(input);
  }

  #reconcileAndIssueSession(input: {
    authentication: JellyfinAuthenticationResult;
    deviceId: string;
    proof: "password" | "quick_connect";
    requestContext: Pick<
      JellyfinPasswordSignInInput,
      "currentSessionToken" | "ipAddress" | "requestId" | "userAgent"
    >;
    registrationHandoff?: InvitationRegistrationHandoffInput;
    target: JellyfinConnectorTarget;
  }): JellyfinSignInResult {
    try {
      return this.#database.sqlite
        .transaction(() =>
          this.#sessionService.withSessionReplacementCapability(
            input.requestContext.currentSessionToken,
            (capability) => {
              const replacement = capability
                ? this.#sessionService.verifyReplacementCapabilityForIdentity(capability)
                : undefined;
              const occurredAt = replacement?.operationTime ?? this.#currentTime();
              const identity = this.#reconcileIdentity({ ...input, occurredAt });
              if (capability) {
                this.#sessionService.completeReplacementIdentityResolution(
                  capability,
                  identity.status,
                );
              }
              if (identity.status === "denied") return identity;

              const sessionInput: CreateSessionInput = {
                attribution: {
                  authMethod: "jellyfin",
                  serviceIdentityLinkId: identity.linkId,
                  userId: identity.userId,
                },
                ...(input.requestContext.ipAddress === undefined
                  ? {}
                  : { ipAddress: input.requestContext.ipAddress }),
                ...(input.requestContext.requestId === undefined
                  ? {}
                  : { requestId: input.requestContext.requestId }),
                ...(input.requestContext.userAgent === undefined
                  ? {}
                  : { userAgent: input.requestContext.userAgent }),
              };
              const session = capability
                ? this.#sessionService.replaceSessionWithCapability(capability, sessionInput)
                : this.#sessionService.createSession(sessionInput);
              return internalResult({ session, status: "signed_in" as const });
            },
          ),
        )
        .immediate();
    } catch (error) {
      if (error instanceof SessionIssuanceLimitError) throw error;
      if (error instanceof InvitationServiceError) throw error;
      if (error instanceof JellyfinSignInServiceError) throw error;
      throw new JellyfinSignInServiceError("provider_unavailable", { cause: error });
    }
  }

  #pairIdentity(input: {
    authentication: JellyfinAuthenticationResult;
    deviceId: string;
    occurredAt: number;
    pairingSession: ValidatedOidcPairingSession;
    proof: "password" | "quick_connect";
    requestContext: Pick<JellyfinPasswordSignInInput, "ipAddress" | "requestId">;
    target: JellyfinConnectorTarget;
  }): JellyfinPairingDeniedResult | { readonly linkId: string; readonly status: "resolved" } {
    if (
      !this.#database.sqlite.inTransaction ||
      !this.#registry.bindingIsCurrent(input.target) ||
      !this.#serverIdentityMatchesTarget(input.authentication.ServerId, input.target)
    ) {
      throw new JellyfinSignInServiceError("configuration_invalid");
    }
    const externalUserId = normalizedDisplayText(input.authentication.User.Id, 256);
    const externalUsername = normalizedDisplayText(input.authentication.User.Name, 160);
    const existingIdentity = this.#database.sqlite
      .prepare(
        `select
          l.id,
          l.user_id as linkUserId,
          l.service,
          l.connector_id as connectorId,
          l.connector_instance_generation as connectorInstanceGeneration,
          l.external_server_id as externalServerId,
          l.external_user_id as externalUserId,
          l.health_state as healthState,
          l.revision,
          l.created_at as createdAt,
          u.id as userId,
          u.role as userRole,
          u.role_source as userRoleSource,
          u.status as userStatus
         from service_identity_links l
         left join users u on u.id = l.user_id
         where l.connector_id = ?
           and l.connector_instance_generation = ?
           and l.external_server_id = ?
           and l.external_user_id = ?`,
      )
      .get(
        input.target.connectorId,
        input.target.instanceGeneration ?? 0,
        input.authentication.ServerId,
        input.authentication.User.Id,
      ) as ExistingLinkRow | undefined;
    if (existingIdentity) {
      if (!this.#existingLinkIsValid(existingIdentity, input, externalUserId)) {
        throw new JellyfinSignInServiceError("provider_unavailable");
      }
      const activeRelink =
        input.pairingSession.serviceIdentityLinkId === existingIdentity.id &&
        existingIdentity.userId === input.pairingSession.userId &&
        existingIdentity.userStatus === "active" &&
        (existingIdentity.healthState === "linked" ||
          existingIdentity.healthState === "unavailable");
      const revokedRelink =
        input.pairingSession.serviceIdentityLinkId === null &&
        existingIdentity.userId === input.pairingSession.userId &&
        existingIdentity.userStatus === "pending_link" &&
        (existingIdentity.healthState === "relink_required" ||
          existingIdentity.healthState === "revoked");
      if (activeRelink || revokedRelink) {
        const encryptedAccessToken = this.#cipher.encrypt(
          input.authentication.AccessToken,
          accessTokenContext(existingIdentity.id),
        );
        const linkUpdate = this.#database.sqlite
          .prepare(
            `update service_identity_links
             set
               external_username = ?,
               external_display_name = ?,
               encrypted_access_token = ?,
               device_id = ?,
               token_created_at = ?,
               health_state = 'linked',
               last_verified_at = ?,
               revoked_at = null,
               revision = revision + 1,
               updated_at = ?
             where id = ?
               and user_id = ?
               and revision = ?`,
          )
          .run(
            externalUsername,
            externalUsername,
            encryptedAccessToken,
            input.deviceId,
            input.occurredAt,
            input.occurredAt,
            input.occurredAt,
            existingIdentity.id,
            input.pairingSession.userId,
            existingIdentity.revision,
          );
        if (linkUpdate.changes !== 1) {
          throw new JellyfinSignInServiceError("provider_unavailable");
        }
        const userUpdate = this.#database.sqlite
          .prepare(
            `update users
             set status = 'active', updated_at = ?
             where id = ? and status <> 'disabled'`,
          )
          .run(input.occurredAt, input.pairingSession.userId);
        if (userUpdate.changes !== 1) {
          throw new JellyfinSignInServiceError("provider_unavailable");
        }
        this.#insertAudit({
          actorUserId: input.pairingSession.userId,
          eventType: "auth.jellyfin.identity.paired",
          metadata: { proof: input.proof, provisioned: false, relinked: true },
          occurredAt: input.occurredAt,
          outcome: "success",
          ...(input.requestContext.requestId === undefined
            ? {}
            : { requestId: input.requestContext.requestId }),
          targetId: existingIdentity.id,
          targetType: "service_identity_link",
        });
        return Object.freeze({ linkId: existingIdentity.id, status: "resolved" as const });
      }
      this.#insertAudit({
        actorUserId: input.pairingSession.userId,
        eventType: "auth.jellyfin.identity.pairing_denied",
        metadata: { reason: "identity_already_linked" },
        occurredAt: input.occurredAt,
        outcome: "denied",
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        targetId: existingIdentity.id,
        targetType: "service_identity_link",
      });
      return internalResult({
        reason: "identity_already_linked" as const,
        status: "denied" as const,
      });
    }

    const existingUserLink = this.#database.sqlite
      .prepare(
        `select
           l.id,
           l.user_id as linkUserId,
           l.service,
           l.connector_id as connectorId,
           l.connector_instance_generation as connectorInstanceGeneration,
           l.external_server_id as externalServerId,
           l.external_user_id as externalUserId,
           l.health_state as healthState,
           l.revision,
           l.created_at as createdAt,
           u.id as userId,
           u.role as userRole,
           u.role_source as userRoleSource,
           u.status as userStatus
         from service_identity_links l
         left join users u on u.id = l.user_id
         where l.user_id = ? and l.service = 'jellyfin'
         limit 1`,
      )
      .get(input.pairingSession.userId) as ExistingLinkRow | undefined;
    if (existingUserLink) {
      const replacementRelink =
        input.pairingSession.serviceIdentityLinkId === null &&
        existingUserLink.userId === input.pairingSession.userId &&
        existingUserLink.userStatus === "pending_link" &&
        existingUserLink.connectorId === input.target.connectorId &&
        existingUserLink.connectorInstanceGeneration < (input.target.instanceGeneration ?? 0) &&
        (existingUserLink.healthState === "relink_required" ||
          existingUserLink.healthState === "revoked") &&
        (existingUserLink.externalServerId !== input.authentication.ServerId ||
          existingUserLink.externalUserId === input.authentication.User.Id) &&
        this.#replacementLinkIsValid(existingUserLink, input.occurredAt);
      if (replacementRelink) {
        const encryptedAccessToken = this.#cipher.encrypt(
          input.authentication.AccessToken,
          accessTokenContext(existingUserLink.id),
        );
        const relinked = this.#database.sqlite
          .prepare(
            `update service_identity_links
             set connector_instance_generation = ?,
                 external_server_id = ?,
                 external_user_id = ?,
                 external_username = ?,
                 external_display_name = ?,
                 encrypted_access_token = ?,
                 device_id = ?,
                 token_created_at = ?,
                 health_state = 'linked',
                 last_verified_at = ?,
                 revoked_at = null,
                 revision = revision + 1,
                 updated_at = ?
             where id = ? and user_id = ?
               and connector_instance_generation = ? and revision = ?`,
          )
          .run(
            input.target.instanceGeneration ?? 0,
            input.authentication.ServerId,
            input.authentication.User.Id,
            externalUsername,
            externalUsername,
            encryptedAccessToken,
            input.deviceId,
            input.occurredAt,
            input.occurredAt,
            input.occurredAt,
            existingUserLink.id,
            input.pairingSession.userId,
            existingUserLink.connectorInstanceGeneration,
            existingUserLink.revision,
          );
        if (relinked.changes !== 1) {
          throw new JellyfinSignInServiceError("provider_unavailable");
        }
        const activated = this.#database.sqlite
          .prepare(
            `update users set status = 'active', updated_at = ?
             where id = ? and status = 'pending_link'`,
          )
          .run(input.occurredAt, input.pairingSession.userId);
        if (activated.changes !== 1) {
          throw new JellyfinSignInServiceError("provider_unavailable");
        }
        this.#insertAudit({
          actorUserId: input.pairingSession.userId,
          eventType: "auth.jellyfin.identity.paired",
          metadata: {
            instanceReplaced: true,
            proof: input.proof,
            provisioned: false,
            relinked: true,
          },
          occurredAt: input.occurredAt,
          outcome: "success",
          ...(input.requestContext.requestId === undefined
            ? {}
            : { requestId: input.requestContext.requestId }),
          targetId: existingUserLink.id,
          targetType: "service_identity_link",
        });
        return Object.freeze({ linkId: existingUserLink.id, status: "resolved" as const });
      }
      this.#insertAudit({
        actorUserId: input.pairingSession.userId,
        eventType: "auth.jellyfin.identity.pairing_denied",
        metadata: { reason: "link_already_exists" },
        occurredAt: input.occurredAt,
        outcome: "denied",
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        targetId: existingUserLink.id,
        targetType: "service_identity_link",
      });
      return internalResult({ reason: "link_already_exists" as const, status: "denied" as const });
    }

    const linkId = this.#nextIdentifier(this.#createId());
    const encryptedAccessToken = this.#cipher.encrypt(
      input.authentication.AccessToken,
      accessTokenContext(linkId),
    );
    this.#database.sqlite
      .prepare(
        `insert into service_identity_links (
          id,
          user_id,
          service,
          connector_id,
          connector_instance_generation,
          external_server_id,
          external_user_id,
          external_username,
          external_display_name,
          encrypted_access_token,
          device_id,
          token_created_at,
          health_state,
          last_verified_at,
          revision,
          created_at,
          updated_at
        ) values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, 0, ?, ?)`,
      )
      .run(
        linkId,
        input.pairingSession.userId,
        input.target.connectorId,
        input.target.instanceGeneration ?? 0,
        input.authentication.ServerId,
        input.authentication.User.Id,
        externalUsername,
        externalUsername,
        encryptedAccessToken,
        input.deviceId,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
      );
    const userUpdate = this.#database.sqlite
      .prepare(
        `update users
         set status = 'active', updated_at = ?
         where id = ? and status = 'pending_link'`,
      )
      .run(input.occurredAt, input.pairingSession.userId);
    if (userUpdate.changes !== 1) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
    this.#insertAudit({
      actorUserId: input.pairingSession.userId,
      eventType: "auth.jellyfin.identity.paired",
      metadata: { proof: input.proof, provisioned: true },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestContext.requestId === undefined
        ? {}
        : { requestId: input.requestContext.requestId }),
      targetId: linkId,
      targetType: "service_identity_link",
    });
    return Object.freeze({ linkId, status: "resolved" as const });
  }

  #reconcileIdentity(input: {
    authentication: JellyfinAuthenticationResult;
    deviceId: string;
    proof: "password" | "quick_connect";
    requestContext: Pick<JellyfinPasswordSignInInput, "ipAddress" | "requestId">;
    occurredAt: number;
    registrationHandoff?: InvitationRegistrationHandoffInput;
    target: JellyfinConnectorTarget;
  }):
    | JellyfinSignInDeniedResult
    | { readonly linkId: string; readonly status: "resolved"; readonly userId: string } {
    if (
      !this.#database.sqlite.inTransaction ||
      !this.#registry.bindingIsCurrent(input.target) ||
      !this.#serverIdentityMatchesTarget(input.authentication.ServerId, input.target)
    ) {
      throw new JellyfinSignInServiceError("configuration_invalid");
    }
    const externalUserId = normalizedDisplayText(input.authentication.User.Id, 256);
    const externalUsername = normalizedDisplayText(input.authentication.User.Name, 160);
    const externalDisplayName = externalUsername;
    const existing = this.#database.sqlite
      .prepare(
        `select
          l.id,
          l.user_id as linkUserId,
          l.service,
          l.connector_id as connectorId,
          l.connector_instance_generation as connectorInstanceGeneration,
          l.external_server_id as externalServerId,
          l.external_user_id as externalUserId,
          l.health_state as healthState,
          l.revision,
          l.created_at as createdAt,
          u.id as userId,
          u.role as userRole,
          u.role_source as userRoleSource,
          u.status as userStatus
         from service_identity_links l
         left join users u on u.id = l.user_id
         where l.connector_id = ?
           and l.connector_instance_generation = ?
           and l.external_server_id = ?
           and l.external_user_id = ?`,
      )
      .get(
        input.target.connectorId,
        input.target.instanceGeneration ?? 0,
        input.authentication.ServerId,
        input.authentication.User.Id,
      ) as ExistingLinkRow | undefined;

    if (existing) {
      if (!this.#existingLinkIsValid(existing, input, externalUserId)) {
        throw new JellyfinSignInServiceError("provider_unavailable");
      }
      if (input.registrationHandoff) {
        return this.#denyInvitationForExistingIdentity(input, existing.id, existing.userId);
      }
      if (existing.userStatus === "disabled") {
        this.#insertAudit({
          actorUserId: existing.userId!,
          eventType: "auth.jellyfin.sign_in",
          metadata: { reason: "account_disabled" },
          occurredAt: input.occurredAt,
          outcome: "denied",
          ...(input.requestContext.requestId === undefined
            ? {}
            : { requestId: input.requestContext.requestId }),
          targetId: existing.id,
          targetType: "service_identity_link",
        });
        return internalResult({ reason: "account_disabled" as const, status: "denied" as const });
      }
      const encryptedAccessToken = this.#cipher.encrypt(
        input.authentication.AccessToken,
        accessTokenContext(existing.id),
      );
      const linkUpdate = this.#database.sqlite
        .prepare(
          `update service_identity_links
           set
             external_username = ?,
             external_display_name = ?,
             encrypted_access_token = ?,
             device_id = ?,
             token_created_at = ?,
             health_state = 'linked',
             last_verified_at = ?,
             revoked_at = null,
             revision = revision + 1,
             updated_at = ?
           where id = ?
             and user_id = ?
             and revision = ?`,
        )
        .run(
          externalUsername,
          externalDisplayName,
          encryptedAccessToken,
          input.deviceId,
          input.occurredAt,
          input.occurredAt,
          input.occurredAt,
          existing.id,
          existing.userId,
          existing.revision,
        );
      if (linkUpdate.changes !== 1) throw new JellyfinSignInServiceError("provider_unavailable");
      const userUpdate = this.#database.sqlite
        .prepare(
          `update users
           set status = 'active', updated_at = ?
           where id = ? and status <> 'disabled'`,
        )
        .run(input.occurredAt, existing.userId);
      if (userUpdate.changes !== 1) throw new JellyfinSignInServiceError("provider_unavailable");
      this.#insertAudit({
        actorUserId: existing.userId!,
        eventType: "auth.jellyfin.sign_in",
        metadata: {
          proof: input.proof,
          provisioned: false,
          relinked: existing.healthState !== "linked",
        },
        occurredAt: input.occurredAt,
        outcome: "success",
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        targetId: existing.id,
        targetType: "service_identity_link",
      });
      return Object.freeze({
        linkId: existing.id,
        status: "resolved" as const,
        userId: existing.userId!,
      });
    }

    const replacedIdentity = this.#database.sqlite
      .prepare(
        `select id
         from service_identity_links
         where connector_id = ?
           and connector_instance_generation < ?
           and external_user_id = ?
           ${input.registrationHandoff ? "" : "and health_state in ('relink_required', 'revoked')"}
         limit 1`,
      )
      .get(
        input.target.connectorId,
        input.target.instanceGeneration ?? 0,
        input.authentication.User.Id,
      ) as { id: string } | undefined;
    if (replacedIdentity) {
      if (input.registrationHandoff) {
        return this.#denyInvitationForExistingIdentity(input, replacedIdentity.id);
      }
      this.#insertAudit({
        eventType: "auth.jellyfin.sign_in",
        metadata: { reason: "proved_relink_required" },
        occurredAt: input.occurredAt,
        outcome: "denied",
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        targetId: replacedIdentity.id,
        targetType: "service_identity_link",
      });
      return internalResult({ reason: "invalid_credentials" as const, status: "denied" as const });
    }

    const userId = this.#nextIdentifier(this.#createId());
    const linkId = this.#nextIdentifier(this.#createId());
    if (input.registrationHandoff) {
      if (!this.#invitations) throw new JellyfinSignInServiceError("configuration_invalid");
      this.#invitations.consumeRegistrationHandoffInExistingTransaction(input.registrationHandoff, {
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        ...(input.requestContext.ipAddress === undefined
          ? {}
          : { ipAddress: input.requestContext.ipAddress }),
      });
    }
    const encryptedAccessToken = this.#cipher.encrypt(
      input.authentication.AccessToken,
      accessTokenContext(linkId),
    );
    this.#database.sqlite
      .prepare(
        `insert into users (
          id, display_name, role, role_source, status, created_at, updated_at
        ) values (?, ?, 'viewer', 'default', 'active', ?, ?)`,
      )
      .run(userId, externalDisplayName, input.occurredAt, input.occurredAt);
    this.#database.sqlite
      .prepare(
        `insert into service_identity_links (
          id,
          user_id,
          service,
          connector_id,
          connector_instance_generation,
          external_server_id,
          external_user_id,
          external_username,
          external_display_name,
          encrypted_access_token,
          device_id,
          token_created_at,
          health_state,
          last_verified_at,
          revision,
          created_at,
          updated_at
        ) values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, 0, ?, ?)`,
      )
      .run(
        linkId,
        userId,
        input.target.connectorId,
        input.target.instanceGeneration ?? 0,
        input.authentication.ServerId,
        input.authentication.User.Id,
        externalUsername,
        externalDisplayName,
        encryptedAccessToken,
        input.deviceId,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
      );
    this.#insertAudit({
      actorUserId: userId,
      eventType: "auth.jellyfin.identity.linked",
      metadata: { proof: input.proof, provisioned: true },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestContext.requestId === undefined
        ? {}
        : { requestId: input.requestContext.requestId }),
      targetId: linkId,
      targetType: "service_identity_link",
    });
    this.#insertAudit({
      actorUserId: userId,
      eventType: "auth.jellyfin.sign_in",
      metadata: { proof: input.proof, provisioned: true, relinked: false },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestContext.requestId === undefined
        ? {}
        : { requestId: input.requestContext.requestId }),
      targetId: linkId,
      targetType: "service_identity_link",
    });
    return Object.freeze({ linkId, status: "resolved" as const, userId });
  }

  #bootstrapIdentity(input: {
    authentication: JellyfinAuthenticationResult;
    deviceId: string;
    proof: "password" | "quick_connect";
    requestContext: Pick<JellyfinPasswordSignInInput, "requestId">;
    occurredAt: number;
    target: JellyfinConnectorTarget;
  }):
    | JellyfinBootstrapDeniedResult
    | { readonly linkId: string; readonly status: "resolved"; readonly userId: string } {
    if (
      !this.#database.sqlite.inTransaction ||
      !this.#registry.bindingIsCurrent(input.target) ||
      !this.#serverIdentityMatchesTarget(input.authentication.ServerId, input.target)
    ) {
      throw new JellyfinSignInServiceError("configuration_invalid");
    }
    if (input.authentication.User.Policy.IsAdministrator !== true) {
      this.#insertAudit({
        eventType: "auth.admin.bootstrap",
        metadata: { proof: input.proof, reason: "jellyfin_admin_required" },
        occurredAt: input.occurredAt,
        outcome: "denied",
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        targetId: input.target.connectorId,
        targetType: "connector",
      });
      return internalResult({
        reason: "jellyfin_admin_required" as const,
        status: "denied" as const,
      });
    }
    const activeAdministrator = this.#database.sqlite
      .prepare("select id from users where role = 'admin' and status = 'active' limit 1")
      .get() as { id: string } | undefined;
    if (activeAdministrator) {
      this.#insertAudit({
        eventType: "auth.admin.bootstrap",
        metadata: { proof: input.proof, reason: "administrator_already_exists" },
        occurredAt: input.occurredAt,
        outcome: "denied",
        ...(input.requestContext.requestId === undefined
          ? {}
          : { requestId: input.requestContext.requestId }),
        targetId: input.target.connectorId,
        targetType: "connector",
      });
      return internalResult({
        reason: "administrator_already_exists" as const,
        status: "denied" as const,
      });
    }

    const existingLink = this.#database.sqlite
      .prepare(
        `select id
         from service_identity_links
         where connector_id = ? and connector_instance_generation = ?
           and external_server_id = ? and external_user_id = ?`,
      )
      .get(
        input.target.connectorId,
        input.target.instanceGeneration ?? 0,
        input.authentication.ServerId,
        input.authentication.User.Id,
      ) as { id: string } | undefined;
    const identity = this.#reconcileIdentity(input);
    if (identity.status === "denied") {
      return internalResult({
        reason:
          identity.reason === "invitation_identity_already_exists"
            ? ("invalid_credentials" as const)
            : identity.reason,
        status: "denied" as const,
      });
    }
    const promoted = this.#database.sqlite
      .prepare(
        `update users
         set role = 'admin', role_source = 'recovery_bootstrap', status = 'active', updated_at = @now
         where id = @userId
           and status <> 'disabled'
           and not exists (
             select 1 from users
             where role = 'admin' and status = 'active' and id <> @userId
           )`,
      )
      .run({ now: input.occurredAt, userId: identity.userId });
    if (promoted.changes !== 1) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
    this.#insertAudit({
      actorUserId: identity.userId,
      eventType: "auth.admin.bootstrap",
      metadata: { proof: input.proof, provisioned: existingLink === undefined },
      occurredAt: input.occurredAt,
      outcome: "success",
      ...(input.requestContext.requestId === undefined
        ? {}
        : { requestId: input.requestContext.requestId }),
      targetId: identity.userId,
      targetType: "user",
    });
    return identity;
  }

  #existingLinkIsValid(
    row: ExistingLinkRow,
    input: {
      authentication: JellyfinAuthenticationResult;
      occurredAt: number;
      target: JellyfinConnectorTarget;
    },
    normalizedExternalUserId: string,
  ) {
    return (
      validIdentifier(row.id) &&
      validIdentifier(row.linkUserId) &&
      row.userId === row.linkUserId &&
      row.service === "jellyfin" &&
      row.connectorId === input.target.connectorId &&
      row.connectorInstanceGeneration === (input.target.instanceGeneration ?? 0) &&
      row.externalServerId === input.authentication.ServerId &&
      row.externalUserId === normalizedExternalUserId &&
      ["linked", "relink_required", "revoked", "unavailable"].includes(row.healthState) &&
      Number.isSafeInteger(row.revision) &&
      row.revision >= 0 &&
      row.revision < 2_147_483_647 &&
      validTimestamp(row.createdAt, input.occurredAt) &&
      ["viewer", "requester", "operator", "admin"].includes(row.userRole ?? "") &&
      ["default", "oidc_mapping", "manual", "recovery_bootstrap"].includes(
        row.userRoleSource ?? "",
      ) &&
      ["active", "pending_link", "disabled"].includes(row.userStatus ?? "")
    );
  }

  #replacementLinkIsValid(row: ExistingLinkRow, occurredAt: number) {
    return (
      validIdentifier(row.id) &&
      validIdentifier(row.linkUserId) &&
      row.userId === row.linkUserId &&
      row.service === "jellyfin" &&
      Number.isSafeInteger(row.connectorInstanceGeneration) &&
      row.connectorInstanceGeneration >= 0 &&
      Number.isSafeInteger(row.revision) &&
      row.revision >= 0 &&
      row.revision < 2_147_483_647 &&
      validTimestamp(row.createdAt, occurredAt) &&
      ["viewer", "requester", "operator", "admin"].includes(row.userRole ?? "") &&
      ["default", "oidc_mapping", "manual", "recovery_bootstrap"].includes(row.userRoleSource ?? "")
    );
  }

  #insertAudit(event: {
    actorUserId?: string;
    eventType: string;
    metadata: Readonly<Record<string, boolean | string>>;
    occurredAt: number;
    outcome: "denied" | "success";
    requestId?: string;
    targetId: string;
    targetType: string;
  }) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (
          id,
          actor_user_id,
          event_type,
          outcome,
          target_type,
          target_id,
          request_id,
          metadata_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#nextIdentifier(this.#createId()),
        event.actorUserId ?? null,
        event.eventType,
        event.outcome,
        event.targetType,
        event.targetId,
        event.requestId ?? null,
        JSON.stringify(event.metadata),
        event.occurredAt,
      );
  }

  #denyInvitationForExistingIdentity(
    input: {
      proof: "password" | "quick_connect";
      requestContext: Pick<JellyfinPasswordSignInInput, "ipAddress" | "requestId">;
      occurredAt: number;
    },
    targetId: string,
    actorUserId?: string | null,
  ): JellyfinSignInDeniedResult {
    this.#insertAudit({
      ...(actorUserId === undefined || actorUserId === null ? {} : { actorUserId }),
      eventType: "auth.jellyfin.sign_in",
      metadata: { proof: input.proof, reason: "invitation_identity_already_exists" },
      occurredAt: input.occurredAt,
      outcome: "denied",
      ...(input.requestContext.requestId === undefined
        ? {}
        : { requestId: input.requestContext.requestId }),
      targetId,
      targetType: "service_identity_link",
    });
    return internalResult({
      reason: "invitation_identity_already_exists" as const,
      status: "denied" as const,
    });
  }

  #currentTime() {
    const time = this.#clock().getTime();
    if (!Number.isSafeInteger(time) || time < 0) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
    return time;
  }

  #resolveConnectorTarget() {
    try {
      return this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinSignInServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
  }

  #resolveRegistrationHandoff(input: InvitationRegistrationHandoffInput) {
    if (!this.#invitations) throw new JellyfinSignInServiceError("configuration_invalid");
    return this.#invitations.resolveRegistrationHandoff(input);
  }

  #serverIdentityMatchesTarget(serverId: string, target: JellyfinConnectorTarget) {
    if ((target.instanceIdentityHash ?? null) === null) return true;
    if (typeof serverId !== "string" || serverId.length < 1 || serverId.length > 256) return false;
    const hash = createHmac("sha256", this.#identityHashKey)
      .update("omnifin:v1:connector-instance-identity\0", "utf8")
      .update(serverId, "utf8")
      .digest("base64url");
    return hash === target.instanceIdentityHash;
  }

  #nextIdentifier(value: string) {
    if (!validIdentifier(value)) throw new JellyfinSignInServiceError("provider_unavailable");
    return value;
  }

  #validatePasswordInput(input: JellyfinPasswordSignInInput) {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.username !== "string" ||
      input.username.length < 1 ||
      input.username.length > 160 ||
      input.username.trim() !== input.username ||
      input.username.search(CONTROL_CHARACTERS) !== -1 ||
      typeof input.password !== "string" ||
      input.password.length < 1 ||
      input.password.length > 1_024 ||
      (input.requestId !== undefined &&
        (typeof input.requestId !== "string" ||
          input.requestId.length < 1 ||
          input.requestId.length > 128))
    ) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
  }

  #validateAuthenticatedSignInInput(input: JellyfinAuthenticatedSignInInput) {
    if (
      !input ||
      typeof input !== "object" ||
      !validIdentifier(input.deviceId) ||
      (input.proof !== "password" && input.proof !== "quick_connect") ||
      !input.authentication ||
      typeof input.authentication !== "object" ||
      !validIdentifier(input.target?.connectorId) ||
      (input.requestId !== undefined &&
        (typeof input.requestId !== "string" ||
          input.requestId.length < 1 ||
          input.requestId.length > 128))
    ) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
  }

  #validateAuthenticatedPairingInput(input: JellyfinAuthenticatedPairingInput) {
    if (
      !input ||
      typeof input !== "object" ||
      !input.validatedSession ||
      !validIdentifier(input.deviceId) ||
      (input.proof !== "password" && input.proof !== "quick_connect") ||
      !input.authentication ||
      typeof input.authentication !== "object" ||
      !validIdentifier(input.target?.connectorId) ||
      (input.requestId !== undefined &&
        (typeof input.requestId !== "string" ||
          input.requestId.length < 1 ||
          input.requestId.length > 128))
    ) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
  }

  #validateAuthenticatedBootstrapInput(input: JellyfinAuthenticatedBootstrapInput) {
    if (
      !input ||
      typeof input !== "object" ||
      !validIdentifier(input.deviceId) ||
      (input.proof !== "password" && input.proof !== "quick_connect") ||
      !input.authentication ||
      typeof input.authentication !== "object" ||
      !validIdentifier(input.target?.connectorId) ||
      (input.requestId !== undefined &&
        (typeof input.requestId !== "string" ||
          input.requestId.length < 1 ||
          input.requestId.length > 128))
    ) {
      throw new JellyfinSignInServiceError("provider_unavailable");
    }
  }
}
