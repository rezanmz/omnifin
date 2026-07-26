import type { AuthorizationCodeGrantChecks } from "openid-client";
import { constantTimeTextEqual } from "../../security/crypto.js";
import {
  buildOidcRuntimeAuthorizationUrl,
  executeOidcRuntimeAuthorizationCodeGrant,
  oidcProviderRuntimeBinding,
  type OidcProviderRuntime,
  type OidcProviderRuntimeBinding,
  type OidcRuntimeAuthorizationCodeGrantResult,
} from "./provider-registry.js";
import type {
  ConsumedOidcAuthorizationTransaction,
  CreatedOidcAuthorizationTransaction,
} from "./authorization-transaction.js";
import { isValidatedOidcClaims, validateOidcClaims, type ValidatedOidcClaims } from "./claims.js";

const MAX_AUTHORIZATION_URL_LENGTH = 4_096;
const MAX_CALLBACK_URL_LENGTH = 16_384;
const MAX_ID_TOKEN_HINT_BYTES = 16 * 1_024;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_256_BIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const verifiedGrantBrand: unique symbol = Symbol("verified-oidc-grant");

export type OidcProtocolErrorCode =
  "oidc_protocol_failed" | "oidc_protocol_invalid" | "oidc_protocol_provider_changed";

const ERROR_MESSAGES: Readonly<Record<OidcProtocolErrorCode, string>> = Object.freeze({
  oidc_protocol_failed: "The identity provider could not complete authentication.",
  oidc_protocol_invalid: "The authentication response is invalid or has expired.",
  oidc_protocol_provider_changed: "The identity provider changed during authentication.",
});

export class OidcProtocolError extends Error {
  public readonly code: OidcProtocolErrorCode;

  public constructor(code: OidcProtocolErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OidcProtocolError";
    this.code = code;
    Object.freeze(this);
  }
}

export interface OidcAuthorizationRedirect {
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
  readonly providerId: string;
}

export interface CompleteOidcAuthorizationInput {
  readonly callbackUrl: URL;
  readonly runtime: OidcProviderRuntime;
  readonly transaction: ConsumedOidcAuthorizationTransaction;
}

export interface VerifiedOidcGrant {
  readonly [verifiedGrantBrand]: true;
  toJSON(): never;
}

/**
 * Gateway-internal material released exactly once from a verified grant.
 * Its properties are deliberately non-enumerable and JSON serialization is
 * disabled because the ID-token hint is retained only for provider logout.
 */
export interface ConsumedVerifiedOidcGrant {
  readonly claims: ValidatedOidcClaims;
  readonly clientId: string;
  readonly idTokenHint: string;
  readonly issuer: string;
  readonly providerId: string;
  readonly providerRuntimeBinding: OidcProviderRuntimeBinding;
  readonly sessionId?: string;
  toJSON(): never;
}

interface VerifiedOidcGrantBinding {
  readonly claims: ValidatedOidcClaims;
  readonly clientId: string;
  readonly idTokenHint: string;
  readonly issuer: string;
  readonly providerId: string;
  readonly providerRuntimeBinding: OidcProviderRuntimeBinding;
}

export interface OidcProtocolDependencies {
  readonly authorizationCodeGrant?: (
    runtime: OidcProviderRuntime,
    currentUrl: URL,
    checks: Readonly<AuthorizationCodeGrantChecks>,
  ) => Promise<OidcRuntimeAuthorizationCodeGrantResult>;
}

const verifiedGrantBindings = new WeakMap<VerifiedOidcGrant, VerifiedOidcGrantBinding>();

function protocolError(code: OidcProtocolErrorCode): never {
  throw new OidcProtocolError(code);
}

function isCanonical256BitToken(value: unknown): value is string {
  if (typeof value !== "string" || !OPAQUE_256_BIT_TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function isValidProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isSafeInteger(value.getTime()) && value.getTime() >= 0;
}

function requireRuntimeBinding(runtime: OidcProviderRuntime): OidcProviderRuntimeBinding {
  try {
    return oidcProviderRuntimeBinding(runtime);
  } catch {
    protocolError("oidc_protocol_invalid");
  }
}

function requireMatchingRuntime(
  runtime: OidcProviderRuntime,
  providerId: unknown,
  providerRuntimeBinding: unknown,
) {
  let runtimeProviderId: string;
  try {
    runtimeProviderId = runtime.provider.id;
  } catch {
    protocolError("oidc_protocol_invalid");
  }
  if (!isValidProviderId(providerId) || runtimeProviderId !== providerId) {
    protocolError("oidc_protocol_invalid");
  }
  const binding = requireRuntimeBinding(runtime);
  if (
    !isCanonical256BitToken(providerRuntimeBinding) ||
    !constantTimeTextEqual(binding, providerRuntimeBinding)
  ) {
    protocolError("oidc_protocol_provider_changed");
  }
  return binding;
}

function requireExactParameter(url: URL, name: string, expected: string) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0] !== expected) protocolError("oidc_protocol_invalid");
}

function exactCallbackUrl(
  callbackUrl: URL,
  transaction: ConsumedOidcAuthorizationTransaction,
): URL {
  if (!(callbackUrl instanceof URL) || callbackUrl.href.length > MAX_CALLBACK_URL_LENGTH) {
    protocolError("oidc_protocol_invalid");
  }
  const current = new URL(callbackUrl.href);
  if (current.username !== "" || current.password !== "" || current.hash !== "") {
    protocolError("oidc_protocol_invalid");
  }
  const callbackWithoutResponse = new URL(current);
  callbackWithoutResponse.search = "";
  if (callbackWithoutResponse.href !== transaction.redirectUri) {
    protocolError("oidc_protocol_invalid");
  }
  if (!isCanonical256BitToken(transaction.expectedState)) {
    protocolError("oidc_protocol_invalid");
  }
  requireExactParameter(current, "state", transaction.expectedState);
  return current;
}

function isBoundedCompactIdToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= MAX_ID_TOKEN_HINT_BYTES &&
    COMPACT_JWS_PATTERN.test(value)
  );
}

function mintVerifiedGrant(binding: VerifiedOidcGrantBinding): VerifiedOidcGrant {
  const grant = Object.create(null) as VerifiedOidcGrant;
  Object.defineProperties(grant, {
    [verifiedGrantBrand]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    toJSON: {
      configurable: false,
      enumerable: false,
      value: () => {
        throw new TypeError("Verified OIDC grants cannot be serialized.");
      },
      writable: false,
    },
  });
  verifiedGrantBindings.set(grant, Object.freeze(binding));
  return Object.freeze(grant);
}

export function isVerifiedOidcGrant(value: unknown): value is VerifiedOidcGrant {
  return (
    typeof value === "object" &&
    value !== null &&
    verifiedGrantBindings.has(value as VerifiedOidcGrant)
  );
}

/** Gateway-internal protocol capability. Do not re-export from the package root. */
export function consumeVerifiedOidcGrant(grant: unknown): ConsumedVerifiedOidcGrant {
  const binding =
    typeof grant === "object" && grant !== null
      ? verifiedGrantBindings.get(grant as VerifiedOidcGrant)
      : undefined;
  if (!binding) protocolError("oidc_protocol_invalid");

  const material = Object.create(null) as ConsumedVerifiedOidcGrant;
  const values: Record<
    Exclude<keyof ConsumedVerifiedOidcGrant, "sessionId" | "toJSON">,
    unknown
  > = {
    claims: binding.claims,
    clientId: binding.clientId,
    idTokenHint: binding.idTokenHint,
    issuer: binding.issuer,
    providerId: binding.providerId,
    providerRuntimeBinding: binding.providerRuntimeBinding,
  };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(material, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  if (binding.claims.sessionId !== undefined) {
    Object.defineProperty(material, "sessionId", {
      configurable: false,
      enumerable: false,
      value: binding.claims.sessionId,
      writable: false,
    });
  }
  Object.defineProperty(material, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => {
      throw new TypeError("Consumed OIDC grant material cannot be serialized.");
    },
    writable: false,
  });
  Object.freeze(material);

  if (!verifiedGrantBindings.delete(grant as VerifiedOidcGrant)) {
    protocolError("oidc_protocol_invalid");
  }
  return material;
}

export class OidcProtocolService {
  readonly #authorizationCodeGrant: NonNullable<OidcProtocolDependencies["authorizationCodeGrant"]>;

  public constructor(dependencies: OidcProtocolDependencies = {}) {
    this.#authorizationCodeGrant =
      dependencies.authorizationCodeGrant ?? executeOidcRuntimeAuthorizationCodeGrant;
  }

  public buildAuthorizationRequest(
    runtime: OidcProviderRuntime,
    transaction: CreatedOidcAuthorizationTransaction,
  ): OidcAuthorizationRedirect {
    try {
      requireMatchingRuntime(runtime, transaction.providerId, transaction.providerRuntimeBinding);
      if (
        transaction.codeChallengeMethod !== "S256" ||
        !isCanonical256BitToken(transaction.codeChallenge) ||
        !isCanonical256BitToken(transaction.state) ||
        !isCanonical256BitToken(transaction.nonce) ||
        !isValidDate(transaction.expiresAt) ||
        typeof transaction.redirectUri !== "string"
      ) {
        protocolError("oidc_protocol_invalid");
      }
      const redirectUri = new URL(transaction.redirectUri);
      if (
        redirectUri.username !== "" ||
        redirectUri.password !== "" ||
        redirectUri.search !== "" ||
        redirectUri.hash !== "" ||
        redirectUri.href !== transaction.redirectUri
      ) {
        protocolError("oidc_protocol_invalid");
      }

      const scope = runtime.provider.scopes.join(" ");
      const authorizationUrl = buildOidcRuntimeAuthorizationUrl(runtime, {
        code_challenge: transaction.codeChallenge,
        code_challenge_method: "S256",
        nonce: transaction.nonce,
        redirect_uri: transaction.redirectUri,
        response_mode: "query",
        scope,
        state: transaction.state,
      });
      if (
        authorizationUrl.href.length > MAX_AUTHORIZATION_URL_LENGTH ||
        authorizationUrl.username !== "" ||
        authorizationUrl.password !== "" ||
        authorizationUrl.hash !== ""
      ) {
        protocolError("oidc_protocol_invalid");
      }
      requireExactParameter(authorizationUrl, "client_id", runtime.provider.clientId);
      requireExactParameter(authorizationUrl, "response_type", "code");
      requireExactParameter(authorizationUrl, "response_mode", "query");
      requireExactParameter(authorizationUrl, "redirect_uri", transaction.redirectUri);
      requireExactParameter(authorizationUrl, "scope", scope);
      requireExactParameter(authorizationUrl, "code_challenge", transaction.codeChallenge);
      requireExactParameter(authorizationUrl, "code_challenge_method", "S256");
      requireExactParameter(authorizationUrl, "state", transaction.state);
      requireExactParameter(authorizationUrl, "nonce", transaction.nonce);

      return Object.freeze({
        authorizationUrl: authorizationUrl.href,
        expiresAt: new Date(transaction.expiresAt),
        providerId: transaction.providerId,
      });
    } catch (error) {
      if (error instanceof OidcProtocolError) throw error;
      protocolError("oidc_protocol_invalid");
    }
  }

  public async completeAuthorization(
    input: CompleteOidcAuthorizationInput,
  ): Promise<VerifiedOidcGrant> {
    let runtimeBinding: OidcProviderRuntimeBinding;
    let callbackUrl: URL;
    try {
      runtimeBinding = requireMatchingRuntime(
        input.runtime,
        input.transaction.providerId,
        input.transaction.providerRuntimeBinding,
      );
      if (
        !PKCE_CODE_VERIFIER_PATTERN.test(input.transaction.codeVerifier) ||
        !isCanonical256BitToken(input.transaction.nonce)
      ) {
        protocolError("oidc_protocol_invalid");
      }
      callbackUrl = exactCallbackUrl(input.callbackUrl, input.transaction);
    } catch (error) {
      if (error instanceof OidcProtocolError) throw error;
      protocolError("oidc_protocol_invalid");
    }

    let result: OidcRuntimeAuthorizationCodeGrantResult;
    try {
      result = await this.#authorizationCodeGrant(input.runtime, callbackUrl, {
        expectedNonce: input.transaction.nonce,
        expectedState: input.transaction.expectedState,
        idTokenExpected: true,
        pkceCodeVerifier: input.transaction.codeVerifier,
      });
    } catch {
      protocolError("oidc_protocol_failed");
    }

    let idToken: unknown;
    let rawClaims: unknown;
    try {
      idToken = result.idToken;
      rawClaims = result.claims;
    } catch {
      protocolError("oidc_protocol_failed");
    }
    if (!isBoundedCompactIdToken(idToken)) protocolError("oidc_protocol_failed");
    const claims = validateOidcClaims(rawClaims);
    if (!claims.ok || !isValidatedOidcClaims(claims.value)) {
      protocolError("oidc_protocol_failed");
    }

    return mintVerifiedGrant({
      claims: claims.value,
      clientId: input.runtime.provider.clientId,
      idTokenHint: idToken,
      issuer: input.runtime.provider.issuer,
      providerId: input.runtime.provider.id,
      providerRuntimeBinding: runtimeBinding,
    });
  }
}
