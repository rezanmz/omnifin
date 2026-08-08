import type {
  AdministratorRecoveryConfirmationRequest,
  AdministratorRecoveryPreviewAdministrator,
  AuthProvider,
  JellyfinQuickConnectInitiationResponse,
  OidcAdministratorReplacementStartResponse,
} from "@omnifin/contracts/auth";

const CSRF_HEADER = "x-omnifin-csrf";

export const ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT: AdministratorRecoveryConfirmationRequest["confirmation"] =
  "REPLACE ADMINISTRATOR";

export type AdministratorRecoveryFailure =
  "denied" | "rate_limited" | "session_required" | "stale_target" | "unavailable" | "uncertain";

export type AdministratorRecoveryPreviewOutcome =
  | {
      administrator: AdministratorRecoveryPreviewAdministrator;
      status: "available";
    }
  | { status: "target_unavailable" }
  | { retryAfterSeconds?: number; status: AdministratorRecoveryFailure };

export type AdministratorRecoveryProviderOutcome =
  { providers: readonly AuthProvider[]; status: "ready" } | { status: "unavailable" };

export interface AdministratorRecoveryTargetInput {
  administratorId: string;
  confirmation: AdministratorRecoveryConfirmationRequest["confirmation"];
  expectedUpdatedAt: string;
}

export interface AdministratorRecoveryPasswordInput extends AdministratorRecoveryTargetInput {
  password: string;
  username: string;
}

export type AdministratorRecoveryReplacementOutcome =
  { status: "replaced" } | { retryAfterSeconds?: number; status: AdministratorRecoveryFailure };

export type AdministratorRecoveryQuickConnectStartOutcome =
  | { status: "started"; transaction: JellyfinQuickConnectInitiationResponse }
  | { retryAfterSeconds?: number; status: AdministratorRecoveryFailure };

export type AdministratorRecoveryQuickConnectPollOutcome =
  | { expiresAt: string; pollAfterMs: number; status: "pending" }
  | { status: "expired" | "replaced" }
  | { retryAfterSeconds?: number; status: AdministratorRecoveryFailure };

export type AdministratorRecoveryOidcStartOutcome =
  | { authorization: OidcAdministratorReplacementStartResponse; status: "started" }
  | { retryAfterSeconds?: number; status: AdministratorRecoveryFailure };

export type AdministratorRecoverySessionState =
  "administrator" | "recovery" | "signed_out" | "unavailable";

export type AdministratorRecoveryBrowserSession =
  | { csrfToken: string; status: "administrator" | "recovery" }
  | { status: "signed_out" | "unavailable" };

interface RuntimeSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  return import("@omnifin/contracts/auth");
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

async function safeJson(response: Response): Promise<unknown | undefined> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d{1,6}$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400 ? seconds : undefined;
}

function failureFromResponse(response: Response): {
  retryAfterSeconds?: number;
  status: Exclude<AdministratorRecoveryFailure, "uncertain">;
} {
  if (response.status === 401) return { status: "session_required" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 409) return { status: "stale_target" };
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return {
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      status: "rate_limited",
    };
  }
  return { status: "unavailable" };
}

function sameOriginRequest(path: string, csrfToken?: string, body?: string): Promise<Response> {
  return fetch(path, {
    ...(body === undefined ? {} : { body }),
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(csrfToken === undefined ? {} : { [CSRF_HEADER]: csrfToken }),
    },
    method: body === undefined ? "GET" : "POST",
  });
}

async function parsedBody<T>(response: Response, schema: RuntimeSchema<T>): Promise<T | undefined> {
  const body = await safeJson(response);
  if (body === undefined) return undefined;
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export async function parseAdministratorRecoveryBrowserSession(
  value: unknown,
): Promise<AdministratorRecoveryBrowserSession> {
  const { sessionResponseSchema } = await contractSchemas();
  const parsed = sessionResponseSchema.safeParse(value);
  if (!parsed.success) return { status: "unavailable" };
  const result = parsed.data;
  if (result.principal === null || result.csrfToken === null) return { status: "signed_out" };
  if (
    result.principal.accountState === "recovery" &&
    result.principal.authenticationMethod.kind === "recovery"
  ) {
    return { csrfToken: result.csrfToken, status: "recovery" };
  }
  if (
    result.principal.accountState === "active" &&
    result.principal.role === "admin" &&
    result.principal.userId !== null &&
    result.principal.authenticationMethod.kind !== "recovery"
  ) {
    return { csrfToken: result.csrfToken, status: "administrator" };
  }
  return { status: "unavailable" };
}

export async function loadAdministratorRecoveryPreview(
  csrfToken: string,
): Promise<AdministratorRecoveryPreviewOutcome> {
  try {
    const response = await sameOriginRequest(
      "/api/auth/recovery/administrator-replacement/preview",
      csrfToken,
      "{}",
    );
    if (!response.ok) return failureFromResponse(response);
    const { administratorRecoveryPreviewResponseSchema } = await contractSchemas();
    const result = await parsedBody(response, administratorRecoveryPreviewResponseSchema);
    if (!result) return { status: "unavailable" };
    if (result.status === "available") return result;
    return result.status === "unavailable"
      ? { status: "target_unavailable" }
      : { status: "denied" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadAdministratorRecoveryProviders(): Promise<AdministratorRecoveryProviderOutcome> {
  try {
    const response = await sameOriginRequest("/api/auth/providers");
    if (!response.ok) return { status: "unavailable" };
    const { authProvidersResponseSchema } = await contractSchemas();
    const result = await parsedBody(response, authProvidersResponseSchema);
    return result ? { providers: result.providers, status: "ready" } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function replaceAdministratorWithJellyfinPassword(
  input: AdministratorRecoveryPasswordInput,
  csrfToken: string,
): Promise<AdministratorRecoveryReplacementOutcome> {
  let response: Response;
  try {
    response = await sameOriginRequest(
      "/api/auth/recovery/administrator-replacement/jellyfin/password",
      csrfToken,
      JSON.stringify(input),
    );
  } catch {
    return { status: "uncertain" };
  }

  const { administratorRecoveryReplacementResponseSchema } = await contractSchemas();
  const result = await parsedBody(response, administratorRecoveryReplacementResponseSchema);
  if (result?.status === "replaced") return { status: "replaced" };
  if (result?.status === "denied") return { status: "denied" };
  if (result?.status === "unavailable") {
    return response.status === 409 ? { status: "stale_target" } : { status: "unavailable" };
  }
  return failureFromResponse(response);
}

export async function startAdministratorRecoveryQuickConnect(
  input: AdministratorRecoveryTargetInput,
  csrfToken: string,
): Promise<AdministratorRecoveryQuickConnectStartOutcome> {
  let response: Response;
  try {
    response = await sameOriginRequest(
      "/api/auth/recovery/administrator-replacement/jellyfin/quick-connect",
      csrfToken,
      JSON.stringify(input),
    );
  } catch {
    return { status: "uncertain" };
  }
  if (!response.ok) return failureFromResponse(response);
  const { jellyfinQuickConnectInitiationResponseSchema } = await contractSchemas();
  const transaction = await parsedBody(response, jellyfinQuickConnectInitiationResponseSchema);
  return transaction ? { status: "started", transaction } : { status: "unavailable" };
}

export async function pollAdministratorRecoveryQuickConnect(
  transactionId: string,
  csrfToken: string,
): Promise<AdministratorRecoveryQuickConnectPollOutcome> {
  let response: Response;
  try {
    response = await sameOriginRequest(
      `/api/auth/recovery/administrator-replacement/jellyfin/quick-connect/${encodeURIComponent(transactionId)}/poll`,
      csrfToken,
      "{}",
    );
  } catch {
    return { status: "uncertain" };
  }
  const { administratorRecoveryQuickConnectPollResponseSchema } = await contractSchemas();
  const result = await parsedBody(response, administratorRecoveryQuickConnectPollResponseSchema);
  if (result?.status === "replaced") return { status: "replaced" };
  if (result?.status === "pending") return result;
  if (result?.status === "expired") return { status: "expired" };
  if (result?.status === "denied") return { status: "denied" };
  if (result?.status === "unavailable") {
    return response.status === 409 ? { status: "stale_target" } : { status: "unavailable" };
  }
  if (response.status === 400) return { status: "expired" };
  return failureFromResponse(response);
}

export async function startAdministratorRecoveryOidc(
  providerId: string,
  input: AdministratorRecoveryTargetInput,
  csrfToken: string,
): Promise<AdministratorRecoveryOidcStartOutcome> {
  let response: Response;
  try {
    response = await sameOriginRequest(
      `/api/auth/recovery/administrator-replacement/oidc/${encodeURIComponent(providerId)}/start`,
      csrfToken,
      JSON.stringify(input),
    );
  } catch {
    return { status: "uncertain" };
  }
  if (!response.ok) return failureFromResponse(response);
  const { oidcAdministratorReplacementStartResponseSchema } = await contractSchemas();
  const authorization = await parsedBody(response, oidcAdministratorReplacementStartResponseSchema);
  return authorization ? { authorization, status: "started" } : { status: "unavailable" };
}

export async function verifyAdministratorRecoverySession(): Promise<AdministratorRecoverySessionState> {
  try {
    const response = await sameOriginRequest("/api/auth/session");
    if (response.status === 401) return "signed_out";
    if (!response.ok) return "unavailable";
    const body = await safeJson(response);
    if (body === undefined) return "unavailable";
    const result = await parseAdministratorRecoveryBrowserSession(body);
    return result.status;
  } catch {
    return "unavailable";
  }
}

export interface AdministratorRecoveryClient {
  loadPreview(csrfToken: string): Promise<AdministratorRecoveryPreviewOutcome>;
  loadProviders(): Promise<AdministratorRecoveryProviderOutcome>;
  pollQuickConnect(
    transactionId: string,
    csrfToken: string,
  ): Promise<AdministratorRecoveryQuickConnectPollOutcome>;
  replaceWithPassword(
    input: AdministratorRecoveryPasswordInput,
    csrfToken: string,
  ): Promise<AdministratorRecoveryReplacementOutcome>;
  startOidc(
    providerId: string,
    input: AdministratorRecoveryTargetInput,
    csrfToken: string,
  ): Promise<AdministratorRecoveryOidcStartOutcome>;
  startQuickConnect(
    input: AdministratorRecoveryTargetInput,
    csrfToken: string,
  ): Promise<AdministratorRecoveryQuickConnectStartOutcome>;
  verifySession(): Promise<AdministratorRecoverySessionState>;
}

export const administratorRecoveryClient: AdministratorRecoveryClient = Object.freeze({
  loadPreview: loadAdministratorRecoveryPreview,
  loadProviders: loadAdministratorRecoveryProviders,
  pollQuickConnect: pollAdministratorRecoveryQuickConnect,
  replaceWithPassword: replaceAdministratorWithJellyfinPassword,
  startOidc: startAdministratorRecoveryOidc,
  startQuickConnect: startAdministratorRecoveryQuickConnect,
  verifySession: verifyAdministratorRecoverySession,
});
