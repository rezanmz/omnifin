import {
  SessionIssuanceLimitError,
  type CreateSessionInput,
  type IssuedSession,
  type SessionService,
} from "../session-service.js";
import type { AdministratorRecoveryConfirmationRequest } from "@omnifin/contracts/auth";
import {
  AdministratorRecoveryError,
  type AdministratorRecoveryReplacementResult,
  type AdministratorRecoveryService,
} from "../administrator-recovery-service.js";
import type { OidcIdentityDenialReason, OidcIdentityService } from "./identity-service.js";
import type { VerifiedOidcGrant } from "./protocol.js";
import type { DatabaseHandle } from "../../db/client.js";

export interface OidcSignInInput {
  readonly currentSessionToken?: unknown;
  readonly grant: VerifiedOidcGrant;
  readonly invitation?: {
    readonly handoffToken: unknown;
    readonly invitationId: string;
  };
  readonly ipAddress?: string;
  readonly requestId?: string;
  readonly userAgent?: string;
}

export interface OidcAdministratorBootstrapInput extends OidcSignInInput {
  readonly recoverySessionId: string;
}

export interface OidcAdministratorReplacementInput
  extends Omit<OidcSignInInput, "currentSessionToken">, AdministratorRecoveryConfirmationRequest {
  readonly currentRecoverySessionToken?: unknown;
  readonly recoverySessionId: string;
}

export interface OidcSignInDeniedResult {
  readonly reason: OidcIdentityDenialReason;
  readonly status: "denied";
  toJSON(): never;
}

export interface OidcSignInSuccessResult {
  readonly session: IssuedSession;
  readonly status: "signed_in";
  toJSON(): never;
}

export type OidcSignInResult = OidcSignInDeniedResult | OidcSignInSuccessResult;

export class OidcSignInServiceError extends Error {
  public readonly code = "oidc_sign_in_failed";

  public constructor(options?: ErrorOptions) {
    super("OIDC sign-in failed.", options);
    this.name = "OidcSignInServiceError";
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
      throw new TypeError("OIDC sign-in results cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(result);
}

export class OidcSignInService {
  readonly #administratorRecovery: AdministratorRecoveryService | undefined;
  readonly #database: DatabaseHandle;
  readonly #identityService: OidcIdentityService;
  readonly #sessionService: SessionService;

  public constructor(
    database: DatabaseHandle,
    identityService: OidcIdentityService,
    sessionService: SessionService,
    administratorRecovery?: AdministratorRecoveryService,
  ) {
    if (
      !identityService.isBoundToDatabase(database) ||
      !sessionService.isBoundToDatabase(database) ||
      (administratorRecovery !== undefined && !administratorRecovery.isBoundToDatabase(database))
    ) {
      throw new OidcSignInServiceError();
    }

    this.#database = database;
    this.#administratorRecovery = administratorRecovery;
    this.#identityService = identityService;
    this.#sessionService = sessionService;
  }

  public toJSON(): never {
    throw new TypeError("OIDC sign-in services cannot be serialized.");
  }

  public signIn(input: OidcSignInInput): OidcSignInResult {
    try {
      return this.#database.sqlite
        .transaction(() =>
          this.#sessionService.withSessionReplacementCapability(
            input.currentSessionToken,
            (capability) => {
              const identityInput =
                input.requestId === undefined
                  ? { grant: input.grant }
                  : { grant: input.grant, requestId: input.requestId };
              const identityOptions = {
                ...(capability === undefined
                  ? {}
                  : {
                      sessionReplacement: {
                        capability,
                        sessionService: this.#sessionService,
                      },
                    }),
                ...(input.invitation === undefined
                  ? {}
                  : {
                      registration: {
                        handoffToken: input.invitation.handoffToken,
                        invitationId: input.invitation.invitationId,
                      },
                    }),
              };
              const identity =
                Object.keys(identityOptions).length === 0
                  ? this.#identityService.resolveInExistingTransaction(identityInput)
                  : this.#identityService.resolveInExistingTransaction(
                      identityInput,
                      identityOptions,
                    );
              if (identity.status === "denied") {
                return internalResult({ reason: identity.reason, status: "denied" as const });
              }

              const sessionInput: CreateSessionInput = {
                attribution: identity.attribution,
              };
              if (input.ipAddress !== undefined) sessionInput.ipAddress = input.ipAddress;
              if (input.requestId !== undefined) sessionInput.requestId = input.requestId;
              if (input.userAgent !== undefined) sessionInput.userAgent = input.userAgent;

              const session =
                capability === undefined
                  ? this.#sessionService.createSession(sessionInput)
                  : this.#sessionService.replaceSessionWithCapability(capability, sessionInput);
              return internalResult({ session, status: "signed_in" as const });
            },
          ),
        )
        .immediate();
    } catch (error) {
      if (error instanceof SessionIssuanceLimitError) throw error;
      if (error instanceof OidcSignInServiceError) throw error;
      throw new OidcSignInServiceError({ cause: error });
    }
  }

  public bootstrapAdministrator(input: OidcAdministratorBootstrapInput): OidcSignInResult {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const bootstrapSession = this.#sessionService.resumeRecoveryBootstrapSession(
            input.currentSessionToken,
            input.recoverySessionId,
          );
          if (!bootstrapSession) {
            return internalResult({
              reason: "invalid_request" as const,
              status: "denied" as const,
            });
          }
          const identityInput =
            input.requestId === undefined
              ? { grant: input.grant }
              : { grant: input.grant, requestId: input.requestId };
          const identity = this.#identityService.resolveAdministratorBootstrapInExistingTransaction(
            identityInput,
            bootstrapSession.operationTime,
          );
          if (identity.status === "denied") {
            return internalResult({ reason: identity.reason, status: "denied" as const });
          }
          const session = this.#sessionService.completeValidatedRecoveryOidcBootstrapSession(
            bootstrapSession,
            identity.attribution,
            {
              ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
            },
          );
          return internalResult({ session, status: "signed_in" as const });
        })
        .immediate();
    } catch (error) {
      if (error instanceof SessionIssuanceLimitError) throw error;
      if (error instanceof OidcSignInServiceError) throw error;
      throw new OidcSignInServiceError({ cause: error });
    }
  }

  public replaceAdministrator(
    input: OidcAdministratorReplacementInput,
  ): AdministratorRecoveryReplacementResult {
    if (!this.#administratorRecovery) {
      return internalResult({
        reason: "state_unavailable" as const,
        status: "unavailable" as const,
      });
    }
    try {
      return this.#administratorRecovery.replaceWithOidc({
        administratorId: input.administratorId,
        confirmation: input.confirmation,
        currentRecoverySessionToken: input.currentRecoverySessionToken,
        expectedUpdatedAt: input.expectedUpdatedAt,
        grant: input.grant,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        recoverySessionId: input.recoverySessionId,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      });
    } catch (error) {
      if (error instanceof SessionIssuanceLimitError) throw error;
      if (error instanceof AdministratorRecoveryError) throw error;
      throw new OidcSignInServiceError({ cause: error });
    }
  }
}
