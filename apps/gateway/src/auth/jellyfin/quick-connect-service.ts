import {
  JellyfinAuthenticationClient,
  type JellyfinQuickConnectResult,
} from "@omnifin/connectors/auth/jellyfin-authentication-client";
import { randomUUID } from "node:crypto";
import {
  ADMINISTRATOR_RECOVERY_CONFIRMATION,
  type AdministratorRecoveryConfirmationRequest,
} from "@omnifin/contracts/auth";

import type { AppConfig } from "../../config.js";
import type { DatabaseHandle } from "../../db/client.js";
import {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  randomToken,
} from "../../security/crypto.js";
import type { IssuedSession } from "../session-service.js";
import {
  InvitationService,
  type InvitationRegistrationHandoffInput,
} from "../invitation-service.js";
import {
  JellyfinConnectorConfigurationError,
  JellyfinConnectorRegistry,
  type JellyfinConnectorTarget,
} from "./connector-registry.js";
import type { AdministratorRecoveryReplacementResult } from "../administrator-recovery-service.js";
import type {
  JellyfinBootstrapDenialReason,
  JellyfinPairingDenialReason,
  JellyfinSignInDenialReason,
  JellyfinSignInService,
} from "./sign-in-service.js";

export const JELLYFIN_QUICK_CONNECT_TRANSACTION_TTL_MS = 5 * 60 * 1_000;
export const JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS = 2_000;
export const JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT = 4;
export const JELLYFIN_QUICK_CONNECT_UNEXPIRED_ROW_LIMIT = 512;
export const JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME =
  "__Host-omnifin_jellyfin_qc_binding";
export const LOCAL_JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME =
  "omnifin_local_jellyfin_qc_binding";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const MAX_INSERTION_ATTEMPTS = 8;
const CLEANUP_BATCH_SIZE = 64;
const MAX_POLL_COUNT = 150;

type QuickConnectPurpose =
  "administrator_replacement" | "bootstrap" | "invitation" | "pairing" | "sign_in";
type StoredQuickConnectPurpose = Exclude<QuickConnectPurpose, "administrator_replacement">;

type QuickConnectClient = Pick<
  JellyfinAuthenticationClient,
  | "authenticateWithQuickConnect"
  | "getPublicSystemInfo"
  | "initiateQuickConnect"
  | "pollQuickConnect"
  | "quickConnectEnabled"
>;

export interface JellyfinQuickConnectServiceDependencies {
  readonly clock?: () => Date;
  readonly createBrowserBinding?: () => string;
  readonly createClient?: (target: JellyfinConnectorTarget) => QuickConnectClient;
  readonly createDeviceId?: () => string;
  readonly createId?: () => string;
  readonly invitationService?: InvitationService;
}

export interface StartJellyfinQuickConnectInput {
  readonly browserBindingToken?: unknown;
}

export interface StartJellyfinQuickConnectInvitationInput extends StartJellyfinQuickConnectInput {
  readonly registrationHandoff: InvitationRegistrationHandoffInput;
}

export interface StartJellyfinQuickConnectPairingInput extends StartJellyfinQuickConnectInput {
  readonly validatedSession?: unknown;
}

export interface StartJellyfinQuickConnectBootstrapInput extends StartJellyfinQuickConnectInput {
  readonly validatedSession?: unknown;
}

export interface StartJellyfinQuickConnectAdministratorReplacementInput
  extends StartJellyfinQuickConnectInput, AdministratorRecoveryConfirmationRequest {
  readonly validatedSession?: unknown;
}

export interface PollJellyfinQuickConnectInput {
  readonly browserBindingToken?: unknown;
  readonly currentSessionToken?: unknown;
  readonly ipAddress?: string;
  readonly requestId?: string;
  readonly transactionId: string;
  readonly userAgent?: string;
  readonly registrationHandoffToken?: unknown;
}

export interface PollJellyfinQuickConnectInvitationInput extends Omit<
  PollJellyfinQuickConnectInput,
  "currentSessionToken"
> {
  readonly registrationHandoffToken: unknown;
}

export interface PollJellyfinQuickConnectPairingInput extends Omit<
  PollJellyfinQuickConnectInput,
  "currentSessionToken"
> {
  readonly validatedSession?: unknown;
}

export interface PollJellyfinQuickConnectBootstrapInput extends Omit<
  PollJellyfinQuickConnectInput,
  "currentSessionToken"
> {
  readonly validatedSession?: unknown;
}

export interface PollJellyfinQuickConnectAdministratorReplacementInput extends Omit<
  PollJellyfinQuickConnectInput,
  "currentSessionToken"
> {
  readonly validatedSession?: unknown;
}

export interface StartedJellyfinQuickConnect {
  readonly browserBindingToken: string;
  readonly code: string;
  readonly expiresAt: Date;
  readonly pollAfterMs: number;
  readonly transactionId: string;
  toJSON(): never;
}

export type JellyfinQuickConnectPollResult =
  | {
      readonly expiresAt: Date;
      readonly pollAfterMs: number;
      readonly status: "pending";
      toJSON(): never;
    }
  | { readonly status: "expired"; toJSON(): never }
  | {
      readonly reason: JellyfinSignInDenialReason;
      readonly status: "denied";
      toJSON(): never;
    }
  | { readonly session: IssuedSession; readonly status: "signed_in"; toJSON(): never };

export type JellyfinQuickConnectPairingPollResult =
  | {
      readonly expiresAt: Date;
      readonly pollAfterMs: number;
      readonly status: "pending";
      toJSON(): never;
    }
  | { readonly status: "expired"; toJSON(): never }
  | {
      readonly reason: JellyfinPairingDenialReason;
      readonly status: "denied";
      toJSON(): never;
    }
  | { readonly session: IssuedSession; readonly status: "paired"; toJSON(): never };

export type JellyfinQuickConnectBootstrapPollResult =
  | {
      readonly expiresAt: Date;
      readonly pollAfterMs: number;
      readonly status: "pending";
      toJSON(): never;
    }
  | { readonly status: "expired"; toJSON(): never }
  | {
      readonly reason: JellyfinBootstrapDenialReason;
      readonly status: "denied";
      toJSON(): never;
    }
  | { readonly session: IssuedSession; readonly status: "bootstrapped"; toJSON(): never };

export type JellyfinQuickConnectAdministratorReplacementPollResult =
  | {
      readonly expiresAt: Date;
      readonly pollAfterMs: number;
      readonly status: "pending";
      toJSON(): never;
    }
  | { readonly status: "expired"; toJSON(): never }
  | AdministratorRecoveryReplacementResult;

export class JellyfinQuickConnectServiceError extends Error {
  public readonly code = "jellyfin_quick_connect_failed";
  public readonly reason:
    | "capacity_exceeded"
    | "configuration_invalid"
    | "invalid_transaction"
    | "pairing_session_required"
    | "provider_unavailable"
    | "quick_connect_disabled"
    | "recovery_session_required";

  public constructor(reason: JellyfinQuickConnectServiceError["reason"], options?: ErrorOptions) {
    super("Jellyfin Quick Connect could not be completed.", options);
    this.name = "JellyfinQuickConnectServiceError";
    this.reason = reason;
  }
}

interface StoredQuickConnectTransaction {
  browserBindingHash: string;
  connectorId: string;
  connectorInstanceGeneration: number;
  connectorType: string;
  consumedAt: number | null;
  createdAt: number;
  encryptedPayload: string;
  expiresAt: number;
  id: string;
  nextPollAt: number;
  pollCount: number;
  pairingSessionId: string | null;
  purpose: StoredQuickConnectPurpose;
}

interface QuickConnectPayload {
  administratorId: string | null;
  baseUrl: string;
  code: string;
  configGeneration: number | null;
  confirmation: typeof ADMINISTRATOR_RECOVERY_CONFIRMATION | null;
  connectorId: string;
  deviceId: string;
  expectedUpdatedAt: string | null;
  insecureHttpApproved: boolean;
  instanceGeneration: number | null;
  pairingSessionId: string | null;
  purpose: QuickConnectPurpose;
  recoverySessionId: string | null;
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  secret: string;
  serverId: string;
  targetUpdatedAt: number;
  invitationId: string | null;
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
      throw new TypeError("Jellyfin Quick Connect results cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(result);
}

function isCanonicalToken(value: unknown): value is string {
  if (typeof value !== "string" || !OPAQUE_TOKEN_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function payloadContext(transactionId: string) {
  return `jellyfin-quick-connect:${transactionId}:payload`;
}

function parsePayload(plaintext: string): QuickConnectPayload {
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    throw new JellyfinQuickConnectServiceError("invalid_transaction");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new JellyfinQuickConnectServiceError("invalid_transaction");
  }
  const candidate = value as Record<string, unknown>;
  const legacyKeys =
    "baseUrl,code,connectorId,deviceId,insecureHttpApproved,schemaVersion,secret,serverId,targetUpdatedAt";
  const currentKeys =
    "baseUrl,code,connectorId,deviceId,insecureHttpApproved,pairingSessionId,purpose,schemaVersion,secret,serverId,targetUpdatedAt";
  const replacementKeys =
    "administratorId,baseUrl,code,confirmation,connectorId,deviceId,expectedUpdatedAt,insecureHttpApproved,pairingSessionId,purpose,recoverySessionId,schemaVersion,secret,serverId,targetUpdatedAt";
  const generationKeys =
    "administratorId,baseUrl,code,configGeneration,confirmation,connectorId,deviceId,expectedUpdatedAt,insecureHttpApproved,instanceGeneration,pairingSessionId,purpose,recoverySessionId,schemaVersion,secret,serverId,targetUpdatedAt";
  const invitationKeys =
    "administratorId,baseUrl,code,configGeneration,confirmation,connectorId,deviceId,expectedUpdatedAt,insecureHttpApproved,instanceGeneration,invitationId,pairingSessionId,purpose,recoverySessionId,schemaVersion,secret,serverId,targetUpdatedAt";
  const keys = Object.keys(candidate).sort().join(",");
  if (
    ((candidate.schemaVersion !== 1 || keys !== legacyKeys) &&
      (candidate.schemaVersion !== 2 || keys !== currentKeys) &&
      (candidate.schemaVersion !== 3 || keys !== currentKeys) &&
      (candidate.schemaVersion !== 4 || keys !== replacementKeys) &&
      (candidate.schemaVersion !== 5 || keys !== generationKeys) &&
      (candidate.schemaVersion !== 6 || keys !== invitationKeys)) ||
    typeof candidate.baseUrl !== "string" ||
    candidate.baseUrl.length < 1 ||
    candidate.baseUrl.length > 2_048 ||
    !validIdentifier(candidate.connectorId) ||
    !validIdentifier(candidate.deviceId) ||
    typeof candidate.insecureHttpApproved !== "boolean" ||
    typeof candidate.secret !== "string" ||
    candidate.secret.length < 1 ||
    candidate.secret.length > 256 ||
    typeof candidate.code !== "string" ||
    !CODE_PATTERN.test(candidate.code) ||
    typeof candidate.serverId !== "string" ||
    candidate.serverId.length < 1 ||
    candidate.serverId.length > 256 ||
    !Number.isSafeInteger(candidate.targetUpdatedAt) ||
    (candidate.targetUpdatedAt as number) < 0
  ) {
    throw new JellyfinQuickConnectServiceError("invalid_transaction");
  }
  if (candidate.schemaVersion === 1) {
    return {
      ...(candidate as unknown as Omit<QuickConnectPayload, "schemaVersion">),
      administratorId: null,
      configGeneration: null,
      confirmation: null,
      expectedUpdatedAt: null,
      instanceGeneration: null,
      pairingSessionId: null,
      purpose: "sign_in",
      recoverySessionId: null,
      schemaVersion: 1,
      invitationId: null,
    };
  }
  if (candidate.schemaVersion === 4) {
    const expectedUpdatedAtTime =
      typeof candidate.expectedUpdatedAt === "string"
        ? Date.parse(candidate.expectedUpdatedAt)
        : Number.NaN;
    if (
      candidate.purpose !== "administrator_replacement" ||
      !validIdentifier(candidate.pairingSessionId) ||
      !validIdentifier(candidate.recoverySessionId) ||
      candidate.pairingSessionId !== candidate.recoverySessionId ||
      !validIdentifier(candidate.administratorId) ||
      candidate.confirmation !== ADMINISTRATOR_RECOVERY_CONFIRMATION ||
      !Number.isFinite(expectedUpdatedAtTime) ||
      new Date(expectedUpdatedAtTime).toISOString() !== candidate.expectedUpdatedAt
    ) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    return {
      ...(candidate as unknown as QuickConnectPayload),
      configGeneration: null,
      instanceGeneration: null,
    };
  }
  if (candidate.schemaVersion === 5) {
    const administratorReplacement = candidate.purpose === "administrator_replacement";
    const expectedUpdatedAtTime =
      typeof candidate.expectedUpdatedAt === "string"
        ? Date.parse(candidate.expectedUpdatedAt)
        : Number.NaN;
    if (
      !Number.isSafeInteger(candidate.instanceGeneration) ||
      (candidate.instanceGeneration as number) < 0 ||
      !Number.isSafeInteger(candidate.configGeneration) ||
      (candidate.configGeneration as number) < 0 ||
      (administratorReplacement
        ? !validIdentifier(candidate.pairingSessionId) ||
          !validIdentifier(candidate.recoverySessionId) ||
          candidate.pairingSessionId !== candidate.recoverySessionId ||
          !validIdentifier(candidate.administratorId) ||
          candidate.confirmation !== ADMINISTRATOR_RECOVERY_CONFIRMATION ||
          !Number.isFinite(expectedUpdatedAtTime) ||
          new Date(expectedUpdatedAtTime).toISOString() !== candidate.expectedUpdatedAt
        : (candidate.purpose !== "sign_in" &&
            candidate.purpose !== "pairing" &&
            candidate.purpose !== "bootstrap") ||
          (candidate.purpose === "sign_in" && candidate.pairingSessionId !== null) ||
          (candidate.purpose !== "sign_in" && !validIdentifier(candidate.pairingSessionId)) ||
          candidate.administratorId !== null ||
          candidate.confirmation !== null ||
          candidate.expectedUpdatedAt !== null ||
          (candidate.purpose === "bootstrap"
            ? candidate.recoverySessionId !== candidate.pairingSessionId
            : candidate.recoverySessionId !== null))
    ) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    return candidate as unknown as QuickConnectPayload;
  }
  if (candidate.schemaVersion === 6) {
    if (
      candidate.purpose !== "invitation" ||
      !validIdentifier(candidate.invitationId) ||
      candidate.pairingSessionId !== null ||
      candidate.recoverySessionId !== null ||
      candidate.administratorId !== null ||
      candidate.confirmation !== null ||
      candidate.expectedUpdatedAt !== null
    ) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    return candidate as unknown as QuickConnectPayload;
  }
  if (
    (candidate.purpose !== "sign_in" &&
      candidate.purpose !== "pairing" &&
      candidate.purpose !== "bootstrap") ||
    (candidate.purpose === "sign_in" && candidate.pairingSessionId !== null) ||
    (candidate.purpose !== "sign_in" && !validIdentifier(candidate.pairingSessionId)) ||
    (candidate.schemaVersion === 2 && candidate.purpose === "bootstrap")
  ) {
    throw new JellyfinQuickConnectServiceError("invalid_transaction");
  }
  return {
    ...(candidate as unknown as Omit<
      QuickConnectPayload,
      "administratorId" | "confirmation" | "expectedUpdatedAt" | "recoverySessionId"
    >),
    administratorId: null,
    configGeneration: null,
    confirmation: null,
    expectedUpdatedAt: null,
    instanceGeneration: null,
    recoverySessionId:
      candidate.purpose === "bootstrap" ? (candidate.pairingSessionId as string) : null,
    invitationId: null,
  };
}

function serializePayload(payload: QuickConnectPayload) {
  if (payload.schemaVersion === 6) return JSON.stringify(payload);
  if (payload.schemaVersion === 4 || payload.schemaVersion === 5) {
    const { invitationId, ...legacyPayload } = payload;
    void invitationId;
    return JSON.stringify(legacyPayload);
  }
  return JSON.stringify({
    baseUrl: payload.baseUrl,
    code: payload.code,
    connectorId: payload.connectorId,
    deviceId: payload.deviceId,
    insecureHttpApproved: payload.insecureHttpApproved,
    pairingSessionId: payload.pairingSessionId,
    purpose: payload.purpose,
    schemaVersion: payload.schemaVersion,
    secret: payload.secret,
    serverId: payload.serverId,
    targetUpdatedAt: payload.targetUpdatedAt,
  });
}

function storedPurpose(purpose: QuickConnectPurpose): StoredQuickConnectPurpose {
  if (purpose === "administrator_replacement") return "bootstrap";
  if (purpose === "invitation") return "sign_in";
  return purpose;
}

function validQuickConnectResult(result: JellyfinQuickConnectResult, payload: QuickConnectPayload) {
  return (
    constantTimeTextEqual(result.Secret, payload.secret) &&
    constantTimeTextEqual(result.Code, payload.code)
  );
}

export function jellyfinQuickConnectBrowserBindingCookieName(
  config: Pick<AppConfig, "secureCookies">,
) {
  return config.secureCookies
    ? JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME
    : LOCAL_JELLYFIN_QUICK_CONNECT_BROWSER_BINDING_COOKIE_NAME;
}

export function writeJellyfinQuickConnectBrowserBindingCookie(
  reply: {
    setCookie: (
      name: string,
      value: string,
      options: {
        expires: Date;
        httpOnly: true;
        path: "/";
        sameSite: "lax";
        secure: boolean;
      },
    ) => unknown;
  },
  config: Pick<AppConfig, "secureCookies">,
  token: string,
  expiresAt: Date,
) {
  if (!isCanonicalToken(token) || !Number.isSafeInteger(expiresAt.getTime())) {
    throw new JellyfinQuickConnectServiceError("provider_unavailable");
  }
  reply.setCookie(jellyfinQuickConnectBrowserBindingCookieName(config), token, {
    expires: expiresAt,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies,
  });
}

export class JellyfinQuickConnectService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createBrowserBinding: () => string;
  readonly #createClient: (target: JellyfinConnectorTarget) => QuickConnectClient;
  readonly #createDeviceId: () => string;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #invitations: InvitationService | undefined;
  readonly #registry: JellyfinConnectorRegistry;
  readonly #signIn: JellyfinSignInService;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    signIn: JellyfinSignInService,
    dependencies: JellyfinQuickConnectServiceDependencies = {},
  ) {
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createBrowserBinding = dependencies.createBrowserBinding ?? (() => randomToken(32));
    this.#createClient =
      dependencies.createClient ??
      ((target) =>
        new JellyfinAuthenticationClient({
          baseUrl: target.baseUrl,
          connectorId: target.connectorId,
          displayName: target.displayName,
          insecureHttpApproved: target.insecureHttpApproved,
          tlsPolicy: target.tlsPolicy ?? "strict",
          ...(target.tlsCaCertificatePem === undefined
            ? {}
            : { tlsCaCertificatePem: target.tlsCaCertificatePem }),
        }));
    this.#createDeviceId = dependencies.createDeviceId ?? randomUUID;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#database = database;
    this.#invitations =
      dependencies.invitationService ?? new InvitationService(database, config as AppConfig);
    this.#registry = new JellyfinConnectorRegistry(database, config.encryptionKey);
    this.#signIn = signIn;
  }

  public toJSON(): never {
    throw new TypeError("Jellyfin Quick Connect services cannot be serialized.");
  }

  public async start(input: StartJellyfinQuickConnectInput): Promise<StartedJellyfinQuickConnect> {
    return this.#start(input, "sign_in", null, undefined);
  }

  public async startInvitation(
    input: StartJellyfinQuickConnectInvitationInput,
  ): Promise<StartedJellyfinQuickConnect> {
    if (!this.#invitations) throw new JellyfinQuickConnectServiceError("configuration_invalid");
    this.#invitations.resolveRegistrationHandoff(input.registrationHandoff);
    return this.#start(input, "invitation", null, undefined, undefined, input.registrationHandoff);
  }

  public async startPairing(
    input: StartJellyfinQuickConnectPairingInput,
  ): Promise<StartedJellyfinQuickConnect> {
    const pairingSession = this.#signIn.resolveEligiblePairingSession(input?.validatedSession);
    if (!pairingSession) {
      throw new JellyfinQuickConnectServiceError("pairing_session_required");
    }
    return this.#start(input, "pairing", pairingSession.sessionId, input.validatedSession);
  }

  public async startBootstrap(
    input: StartJellyfinQuickConnectBootstrapInput,
  ): Promise<StartedJellyfinQuickConnect> {
    const recoverySession = this.#signIn.resolveEligibleRecoveryBootstrapSession(
      input?.validatedSession,
    );
    if (!recoverySession) {
      throw new JellyfinQuickConnectServiceError("recovery_session_required");
    }
    return this.#start(input, "bootstrap", recoverySession.sessionId, input.validatedSession);
  }

  public async startAdministratorReplacement(
    input: StartJellyfinQuickConnectAdministratorReplacementInput,
  ): Promise<StartedJellyfinQuickConnect> {
    const target = {
      administratorId: input?.administratorId,
      expectedUpdatedAt: input?.expectedUpdatedAt,
    };
    const recoverySession = this.#signIn.resolveEligibleAdministratorReplacementSession(
      input?.validatedSession,
      target,
    );
    if (!recoverySession || input.confirmation !== ADMINISTRATOR_RECOVERY_CONFIRMATION) {
      throw new JellyfinQuickConnectServiceError("recovery_session_required");
    }
    return this.#start(
      input,
      "administrator_replacement",
      recoverySession.sessionId,
      input.validatedSession,
      input,
    );
  }

  async #start(
    input: StartJellyfinQuickConnectInput,
    purpose: QuickConnectPurpose,
    pairingSessionId: string | null,
    validatedSession: unknown,
    replacement?: AdministratorRecoveryConfirmationRequest,
    registrationHandoff?: InvitationRegistrationHandoffInput,
  ): Promise<StartedJellyfinQuickConnect> {
    if (!input || typeof input !== "object") {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    const now = this.#currentTime();
    let target = this.#resolveTarget();
    const deviceId = this.#nextIdentifier(this.#createDeviceId());
    const client = this.#createClient(target);
    let enabled: boolean;
    try {
      enabled = await client.quickConnectEnabled({ deviceId });
      this.#registry.recordQuickConnectCapability(target, enabled);
      target = this.#resolveTarget();
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (!enabled) throw new JellyfinQuickConnectServiceError("quick_connect_disabled");

    let publicInfo;
    let initiated;
    try {
      [publicInfo, initiated] = await Promise.all([
        client.getPublicSystemInfo(),
        client.initiateQuickConnect({ deviceId }),
      ]);
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (initiated.Authenticated || !CODE_PATTERN.test(initiated.Code)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    if (
      !this.#registry.bindingIsCurrent(target) ||
      !this.#registry.serverIdentityIsCurrent(target, publicInfo.Id)
    ) {
      throw new JellyfinQuickConnectServiceError("configuration_invalid");
    }
    if (purpose === "pairing") {
      const currentPairingSession = this.#signIn.resolveEligiblePairingSession(validatedSession);
      if (!currentPairingSession || currentPairingSession.sessionId !== pairingSessionId) {
        throw new JellyfinQuickConnectServiceError("pairing_session_required");
      }
    } else if (purpose === "bootstrap") {
      const currentRecoverySession =
        this.#signIn.resolveEligibleRecoveryBootstrapSession(validatedSession);
      if (!currentRecoverySession || currentRecoverySession.sessionId !== pairingSessionId) {
        throw new JellyfinQuickConnectServiceError("recovery_session_required");
      }
    } else if (purpose === "administrator_replacement") {
      const currentRecoverySession = this.#signIn.resolveEligibleAdministratorReplacementSession(
        validatedSession,
        {
          administratorId: replacement?.administratorId ?? "",
          expectedUpdatedAt: replacement?.expectedUpdatedAt ?? "",
        },
      );
      if (
        !currentRecoverySession ||
        currentRecoverySession.sessionId !== pairingSessionId ||
        replacement?.confirmation !== ADMINISTRATOR_RECOVERY_CONFIRMATION
      ) {
        throw new JellyfinQuickConnectServiceError("recovery_session_required");
      }
    }

    const browserBindingToken = isCanonicalToken(input.browserBindingToken)
      ? input.browserBindingToken
      : this.#createBrowserBinding();
    if (!isCanonicalToken(browserBindingToken)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    const expiresAt = new Date(now + JELLYFIN_QUICK_CONNECT_TRANSACTION_TTL_MS);
    const payload: QuickConnectPayload = {
      administratorId: replacement?.administratorId ?? null,
      baseUrl: target.baseUrl,
      code: initiated.Code,
      configGeneration: target.configGeneration ?? 0,
      confirmation: replacement?.confirmation ?? null,
      connectorId: target.connectorId,
      deviceId,
      expectedUpdatedAt: replacement?.expectedUpdatedAt ?? null,
      insecureHttpApproved: target.insecureHttpApproved,
      instanceGeneration: target.instanceGeneration ?? 0,
      invitationId: registrationHandoff?.invitationId ?? null,
      pairingSessionId,
      purpose,
      recoverySessionId:
        purpose === "administrator_replacement" || purpose === "bootstrap"
          ? pairingSessionId
          : null,
      schemaVersion: purpose === "invitation" ? 6 : 5,
      secret: initiated.Secret,
      serverId: publicInfo.Id,
      targetUpdatedAt: target.updatedAt,
    };

    this.#cleanupExpired(now);
    for (let attempt = 0; attempt < MAX_INSERTION_ATTEMPTS; attempt += 1) {
      const transactionId = this.#nextIdentifier(this.#createId());
      const inserted = this.#insert({
        browserBindingHash: hashToken(browserBindingToken),
        connectorId: target.connectorId,
        connectorInstanceGeneration: target.instanceGeneration ?? 0,
        createdAt: now,
        encryptedPayload: this.#cipher.encrypt(
          serializePayload(payload),
          payloadContext(transactionId),
        ),
        expiresAt: expiresAt.getTime(),
        id: transactionId,
        nextPollAt: now + JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
        pairingSessionId,
        purpose: storedPurpose(purpose),
      });
      if (inserted === "capacity") {
        throw new JellyfinQuickConnectServiceError("capacity_exceeded");
      }
      if (inserted === "collision") continue;
      return internalResult({
        browserBindingToken,
        code: initiated.Code,
        expiresAt,
        pollAfterMs: JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
        transactionId,
      });
    }
    throw new JellyfinQuickConnectServiceError("provider_unavailable");
  }

  public async poll(input: PollJellyfinQuickConnectInput): Promise<JellyfinQuickConnectPollResult> {
    return this.#poll(input, "sign_in", null);
  }

  public async pollInvitation(
    input: PollJellyfinQuickConnectInvitationInput,
  ): Promise<JellyfinQuickConnectPollResult> {
    return this.#poll(input, "invitation", null);
  }

  public async pollPairing(
    input: PollJellyfinQuickConnectPairingInput,
  ): Promise<JellyfinQuickConnectPairingPollResult> {
    const pairingSession = this.#signIn.resolveEligiblePairingSession(input?.validatedSession);
    if (!pairingSession) {
      throw new JellyfinQuickConnectServiceError("pairing_session_required");
    }
    return this.#poll(input, "pairing", pairingSession.sessionId);
  }

  public async pollBootstrap(
    input: PollJellyfinQuickConnectBootstrapInput,
  ): Promise<JellyfinQuickConnectBootstrapPollResult> {
    const recoverySession = this.#signIn.resolveEligibleRecoveryBootstrapSession(
      input?.validatedSession,
    );
    if (!recoverySession) {
      throw new JellyfinQuickConnectServiceError("recovery_session_required");
    }
    return this.#poll(input, "bootstrap", recoverySession.sessionId);
  }

  public async pollAdministratorReplacement(
    input: PollJellyfinQuickConnectAdministratorReplacementInput,
  ): Promise<JellyfinQuickConnectAdministratorReplacementPollResult> {
    const recoverySession = this.#signIn.resolveEligibleAdministratorReplacementSession(
      input?.validatedSession,
    );
    if (!recoverySession) {
      throw new JellyfinQuickConnectServiceError("recovery_session_required");
    }
    return this.#poll(input, "administrator_replacement", recoverySession.sessionId);
  }

  #poll(
    input: PollJellyfinQuickConnectInput,
    purpose: "sign_in",
    pairingSessionId: null,
  ): Promise<JellyfinQuickConnectPollResult>;
  #poll(
    input: PollJellyfinQuickConnectPairingInput,
    purpose: "pairing",
    pairingSessionId: string,
  ): Promise<JellyfinQuickConnectPairingPollResult>;
  #poll(
    input: PollJellyfinQuickConnectBootstrapInput,
    purpose: "bootstrap",
    pairingSessionId: string,
  ): Promise<JellyfinQuickConnectBootstrapPollResult>;
  #poll(
    input: PollJellyfinQuickConnectAdministratorReplacementInput,
    purpose: "administrator_replacement",
    pairingSessionId: string,
  ): Promise<JellyfinQuickConnectAdministratorReplacementPollResult>;
  #poll(
    input: PollJellyfinQuickConnectInvitationInput,
    purpose: "invitation",
    pairingSessionId: null,
  ): Promise<JellyfinQuickConnectPollResult>;
  async #poll(
    input:
      | PollJellyfinQuickConnectAdministratorReplacementInput
      | PollJellyfinQuickConnectBootstrapInput
      | PollJellyfinQuickConnectInvitationInput
      | PollJellyfinQuickConnectInput
      | PollJellyfinQuickConnectPairingInput,
    purpose: QuickConnectPurpose,
    pairingSessionId: string | null,
  ): Promise<
    | JellyfinQuickConnectBootstrapPollResult
    | JellyfinQuickConnectAdministratorReplacementPollResult
    | JellyfinQuickConnectPairingPollResult
    | JellyfinQuickConnectPollResult
  > {
    if (
      !input ||
      typeof input !== "object" ||
      !validIdentifier(input.transactionId) ||
      !isCanonicalToken(input.browserBindingToken)
    ) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    const now = this.#currentTime();
    const browserBindingHash = hashToken(input.browserBindingToken);
    const reservation = this.#reservePoll(
      input.transactionId,
      browserBindingHash,
      now,
      storedPurpose(purpose),
      pairingSessionId,
    );
    if (reservation.status === "expired") return internalResult({ status: "expired" as const });
    if (reservation.status === "pending") {
      if (purpose === "invitation") {
        const payload = this.#decryptPayload(reservation.row);
        this.#resolveInvitationHandoff(payload, input.registrationHandoffToken);
      }
      return internalResult({
        expiresAt: new Date(reservation.expiresAt),
        pollAfterMs: reservation.pollAfterMs,
        status: "pending" as const,
      });
    }

    const payload = this.#decryptPayload(reservation.row);
    if (purpose === "invitation") {
      this.#resolveInvitationHandoff(payload, input.registrationHandoffToken);
    }
    const target = this.#resolveTarget();
    if (
      !this.#payloadMatchesTarget(payload, target) ||
      reservation.row.connectorInstanceGeneration !== (target.instanceGeneration ?? 0) ||
      payload.purpose !== purpose ||
      payload.pairingSessionId !== pairingSessionId ||
      (purpose === "administrator_replacement" &&
        (payload.administratorId === null ||
          payload.confirmation !== ADMINISTRATOR_RECOVERY_CONFIRMATION ||
          payload.expectedUpdatedAt === null ||
          payload.recoverySessionId !== pairingSessionId))
    ) {
      throw new JellyfinQuickConnectServiceError("configuration_invalid");
    }
    const client = this.#createClient(target);
    let currentPublicInfo;
    try {
      currentPublicInfo = await client.getPublicSystemInfo();
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (
      currentPublicInfo.Id !== payload.serverId ||
      !this.#registry.serverIdentityIsCurrent(target, currentPublicInfo.Id) ||
      !this.#registry.bindingIsCurrent(target)
    ) {
      throw new JellyfinQuickConnectServiceError("configuration_invalid");
    }
    let upstream;
    try {
      upstream = await client.pollQuickConnect({
        deviceId: payload.deviceId,
        secret: payload.secret,
      });
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (!validQuickConnectResult(upstream, payload)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    if (!upstream.Authenticated) {
      return internalResult({
        expiresAt: new Date(reservation.row.expiresAt),
        pollAfterMs: JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS,
        status: "pending" as const,
      });
    }

    if (
      !this.#consume(
        reservation.row,
        browserBindingHash,
        now,
        target,
        storedPurpose(purpose),
        pairingSessionId,
      )
    ) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    let authentication;
    try {
      authentication = await client.authenticateWithQuickConnect({
        deviceId: payload.deviceId,
        secret: payload.secret,
      });
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
    if (authentication.ServerId !== payload.serverId) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    const result =
      purpose === "administrator_replacement"
        ? this.#signIn.completeAuthenticatedAdministratorReplacement({
            administratorId: payload.administratorId!,
            authentication,
            confirmation: payload.confirmation!,
            deviceId: payload.deviceId,
            expectedUpdatedAt: payload.expectedUpdatedAt!,
            ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
            proof: "quick_connect",
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
            target,
            ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
            validatedSession: (input as PollJellyfinQuickConnectAdministratorReplacementInput)
              .validatedSession,
          })
        : purpose === "pairing"
          ? this.#signIn.completeAuthenticatedPairing({
              authentication,
              deviceId: payload.deviceId,
              ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
              proof: "quick_connect",
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              target,
              ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
              validatedSession: (input as PollJellyfinQuickConnectPairingInput).validatedSession,
            })
          : purpose === "bootstrap"
            ? this.#signIn.completeAuthenticatedBootstrap({
                authentication,
                deviceId: payload.deviceId,
                ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
                proof: "quick_connect",
                ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
                target,
                ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
                validatedSession: (input as PollJellyfinQuickConnectBootstrapInput)
                  .validatedSession,
              })
            : this.#signIn.completeAuthenticatedSignIn({
                authentication,
                ...(purpose === "invitation"
                  ? {
                      registrationHandoff: {
                        handoffToken: input.registrationHandoffToken,
                        invitationId: payload.invitationId!,
                      },
                    }
                  : {
                      currentSessionToken: (input as PollJellyfinQuickConnectInput)
                        .currentSessionToken,
                    }),
                deviceId: payload.deviceId,
                ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
                proof: "quick_connect",
                ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
                target,
                ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
              });
    if (purpose === "administrator_replacement") {
      return result as AdministratorRecoveryReplacementResult;
    }
    if (result.status === "unavailable") return result;
    if (result.status === "denied") {
      return internalResult({ reason: result.reason, status: "denied" as const });
    }
    return internalResult({
      session: result.session,
      status:
        purpose === "pairing"
          ? ("paired" as const)
          : purpose === "bootstrap"
            ? ("bootstrapped" as const)
            : ("signed_in" as const),
    });
  }

  #insert(input: {
    browserBindingHash: string;
    connectorId: string;
    connectorInstanceGeneration: number;
    createdAt: number;
    encryptedPayload: string;
    expiresAt: number;
    id: string;
    nextPollAt: number;
    pairingSessionId: string | null;
    purpose: StoredQuickConnectPurpose;
  }): "capacity" | "collision" | "inserted" {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const globalCount = this.#database.sqlite
            .prepare(
              `select count(*) as count
               from jellyfin_quick_connect_transactions
               where expires_at > ?`,
            )
            .get(input.createdAt) as { count: number };
          const browserCount = this.#database.sqlite
            .prepare(
              `select count(*) as count
               from jellyfin_quick_connect_transactions
               where browser_binding_hash = ?
                 and consumed_at is null
                 and expires_at > ?`,
            )
            .get(input.browserBindingHash, input.createdAt) as { count: number };
          if (
            globalCount.count >= JELLYFIN_QUICK_CONNECT_UNEXPIRED_ROW_LIMIT ||
            browserCount.count >= JELLYFIN_QUICK_CONNECT_ACTIVE_PER_BROWSER_LIMIT
          ) {
            return "capacity" as const;
          }
          const existing = this.#database.sqlite
            .prepare("select 1 from jellyfin_quick_connect_transactions where id = ?")
            .get(input.id);
          if (existing) return "collision" as const;
          this.#database.sqlite
            .prepare(
              `insert into jellyfin_quick_connect_transactions (
                id,
                connector_id,
                connector_instance_generation,
                connector_type,
                purpose,
                pairing_session_id,
                browser_binding_hash,
                encrypted_payload,
                expires_at,
                next_poll_at,
                poll_count,
                created_at
              ) values (?, ?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, 0, ?)`,
            )
            .run(
              input.id,
              input.connectorId,
              input.connectorInstanceGeneration,
              input.purpose,
              input.pairingSessionId,
              input.browserBindingHash,
              input.encryptedPayload,
              input.expiresAt,
              input.nextPollAt,
              input.createdAt,
            );
          return "inserted" as const;
        })
        .immediate();
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #reservePoll(
    transactionId: string,
    browserBindingHash: string,
    now: number,
    purpose: StoredQuickConnectPurpose,
    pairingSessionId: string | null,
  ):
    | { status: "expired" }
    | {
        expiresAt: number;
        pollAfterMs: number;
        row: StoredQuickConnectTransaction;
        status: "pending";
      }
    | { row: StoredQuickConnectTransaction; status: "reserved" } {
    try {
      return this.#database.sqlite
        .transaction(() => {
          const row = this.#database.sqlite
            .prepare(
              `select
                id,
                connector_id as connectorId,
                connector_instance_generation as connectorInstanceGeneration,
                connector_type as connectorType,
                purpose,
                pairing_session_id as pairingSessionId,
                browser_binding_hash as browserBindingHash,
                encrypted_payload as encryptedPayload,
                expires_at as expiresAt,
                next_poll_at as nextPollAt,
                poll_count as pollCount,
                consumed_at as consumedAt,
                created_at as createdAt
               from jellyfin_quick_connect_transactions
               where id = ?`,
            )
            .get(transactionId) as StoredQuickConnectTransaction | undefined;
          if (
            !row ||
            row.connectorType !== "jellyfin" ||
            row.purpose !== purpose ||
            row.pairingSessionId !== pairingSessionId ||
            !constantTimeTextEqual(row.browserBindingHash, browserBindingHash) ||
            row.consumedAt !== null
          ) {
            throw new JellyfinQuickConnectServiceError("invalid_transaction");
          }
          if (now >= row.expiresAt || row.pollCount >= MAX_POLL_COUNT) {
            return { status: "expired" as const };
          }
          if (now < row.nextPollAt) {
            return {
              expiresAt: row.expiresAt,
              pollAfterMs: Math.max(row.nextPollAt - now, 1_000),
              row,
              status: "pending" as const,
            };
          }
          const nextPollAt = Math.min(now + JELLYFIN_QUICK_CONNECT_POLL_INTERVAL_MS, row.expiresAt);
          const update = this.#database.sqlite
            .prepare(
              `update jellyfin_quick_connect_transactions
               set next_poll_at = ?, poll_count = poll_count + 1
               where id = ?
                 and browser_binding_hash = ?
                 and purpose = ?
                 and pairing_session_id is ?
                 and connector_instance_generation = ?
                 and consumed_at is null
                 and poll_count = ?
                 and next_poll_at = ?`,
            )
            .run(
              nextPollAt,
              row.id,
              browserBindingHash,
              purpose,
              pairingSessionId,
              row.connectorInstanceGeneration,
              row.pollCount,
              row.nextPollAt,
            );
          if (update.changes !== 1) {
            throw new JellyfinQuickConnectServiceError("invalid_transaction");
          }
          return {
            row: { ...row, nextPollAt, pollCount: row.pollCount + 1 },
            status: "reserved" as const,
          };
        })
        .immediate();
    } catch (error) {
      if (error instanceof JellyfinQuickConnectServiceError) throw error;
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #consume(
    row: StoredQuickConnectTransaction,
    browserBindingHash: string,
    now: number,
    target: JellyfinConnectorTarget,
    purpose: StoredQuickConnectPurpose,
    pairingSessionId: string | null,
  ) {
    try {
      return this.#database.sqlite
        .transaction(() => {
          if (!this.#registry.bindingIsCurrent(target)) return false;
          const result = this.#database.sqlite
            .prepare(
              `update jellyfin_quick_connect_transactions
               set consumed_at = ?
               where id = ?
                 and browser_binding_hash = ?
                 and purpose = ?
                 and pairing_session_id is ?
                 and connector_instance_generation = ?
                 and consumed_at is null
                 and expires_at > ?
                 and poll_count = ?`,
            )
            .run(
              now,
              row.id,
              browserBindingHash,
              purpose,
              pairingSessionId,
              target.instanceGeneration ?? 0,
              now,
              row.pollCount,
            );
          return result.changes === 1;
        })
        .immediate();
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #cleanupExpired(now: number) {
    try {
      this.#database.sqlite
        .prepare(
          `delete from jellyfin_quick_connect_transactions
           where id in (
             select id
             from jellyfin_quick_connect_transactions
             where expires_at <= ?
             order by expires_at asc
             limit ?
           )`,
        )
        .run(now, CLEANUP_BATCH_SIZE);
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable", { cause: error });
    }
  }

  #decryptPayload(row: StoredQuickConnectTransaction) {
    try {
      return parsePayload(this.#cipher.decrypt(row.encryptedPayload, payloadContext(row.id)));
    } catch (error) {
      if (error instanceof JellyfinQuickConnectServiceError) throw error;
      throw new JellyfinQuickConnectServiceError("invalid_transaction", { cause: error });
    }
  }

  #resolveInvitationHandoff(payload: QuickConnectPayload, handoffToken: unknown) {
    if (!this.#invitations || payload.invitationId === null) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction");
    }
    try {
      this.#invitations.resolveRegistrationHandoff({
        handoffToken,
        invitationId: payload.invitationId,
      });
    } catch (error) {
      throw new JellyfinQuickConnectServiceError("invalid_transaction", { cause: error });
    }
  }

  #payloadMatchesTarget(payload: QuickConnectPayload, target: JellyfinConnectorTarget) {
    return (
      payload.connectorId === target.connectorId &&
      payload.baseUrl === target.baseUrl &&
      payload.insecureHttpApproved === target.insecureHttpApproved &&
      (payload.schemaVersion === 5 || payload.targetUpdatedAt === target.updatedAt) &&
      (payload.instanceGeneration === null ||
        payload.instanceGeneration === (target.instanceGeneration ?? 0)) &&
      (payload.configGeneration === null ||
        payload.configGeneration === (target.configGeneration ?? 0)) &&
      this.#registry.serverIdentityIsCurrent(target, payload.serverId) &&
      this.#registry.bindingIsCurrent(target)
    );
  }

  #resolveTarget() {
    try {
      return this.#registry.resolve();
    } catch (error) {
      if (error instanceof JellyfinConnectorConfigurationError) {
        throw new JellyfinQuickConnectServiceError("configuration_invalid", { cause: error });
      }
      throw error;
    }
  }

  #currentTime() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    return value;
  }

  #nextIdentifier(value: string) {
    if (!validIdentifier(value)) {
      throw new JellyfinQuickConnectServiceError("provider_unavailable");
    }
    return value;
  }
}
