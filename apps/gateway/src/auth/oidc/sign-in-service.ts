import {
  SessionIssuanceLimitError,
  type CreateSessionInput,
  type IssuedSession,
  type SessionService,
} from "../session-service.js";
import type { OidcIdentityDenialReason, OidcIdentityService } from "./identity-service.js";
import type { VerifiedOidcGrant } from "./protocol.js";
import type { DatabaseHandle } from "../../db/client.js";

export interface OidcSignInInput {
  readonly currentSessionToken?: unknown;
  readonly grant: VerifiedOidcGrant;
  readonly ipAddress?: string;
  readonly requestId?: string;
  readonly userAgent?: string;
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
  readonly #database: DatabaseHandle;
  readonly #identityService: OidcIdentityService;
  readonly #sessionService: SessionService;

  public constructor(
    database: DatabaseHandle,
    identityService: OidcIdentityService,
    sessionService: SessionService,
  ) {
    if (
      !identityService.isBoundToDatabase(database) ||
      !sessionService.isBoundToDatabase(database)
    ) {
      throw new OidcSignInServiceError();
    }

    this.#database = database;
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
              const identity =
                capability === undefined
                  ? this.#identityService.resolveInExistingTransaction(identityInput)
                  : this.#identityService.resolveInExistingTransaction(identityInput, {
                      sessionReplacement: {
                        capability,
                        sessionService: this.#sessionService,
                      },
                    });
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
}
