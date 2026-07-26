import {
  oidcProviderAdminSchema,
  oidcProviderCreateRequestSchema,
  oidcProviderDeleteResponseSchema,
  oidcProviderMutationResponseSchema,
  oidcProviderUpdateRequestSchema,
  oidcProviderValidationResponseSchema,
  oidcProvidersAdminResponseSchema,
  oidcRoleMappingCreateRequestSchema,
  oidcRoleMappingDeleteResponseSchema,
  oidcRoleMappingMutationResponseSchema,
  oidcRoleMappingsAdminResponseSchema,
  sessionResponseSchema,
  type OidcProviderAdmin,
  type OidcProviderCreateRequest,
  type OidcProviderDeleteResponse,
  type OidcProviderMutationResponse,
  type OidcProviderUpdateRequest,
  type OidcProviderValidationResponse,
  type OidcRoleMappingCreateRequest,
  type OidcRoleMappingDeleteResponse,
  type OidcRoleMappingMutationResponse,
  type RoleMapping,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import { apiErrorSchema } from "@omnifin/contracts/errors";

const CSRF_HEADER = "x-omnifin-csrf";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

export interface IdentityProviderAdminSnapshot {
  csrfToken: string;
  principal: SessionPrincipal;
  providers: readonly OidcProviderAdmin[];
}

export type IdentityProviderAdminLoadOutcome =
  | { snapshot: IdentityProviderAdminSnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export type IdentityProviderAdminClientErrorKind =
  "invalid_response" | "rejected" | "session_changed" | "unavailable";

export class IdentityProviderAdminClientError extends Error {
  public readonly code: string;
  public readonly kind: IdentityProviderAdminClientErrorKind;

  public constructor(kind: IdentityProviderAdminClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "IdentityProviderAdminClientError";
    this.kind = kind;
    this.code = code;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new IdentityProviderAdminClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<IdentityProviderAdminClientError> {
  if (response.status === 401 || response.status === 403) {
    return new IdentityProviderAdminClientError(
      "session_changed",
      "session_changed",
      "Your administrative session changed. Sign in again before continuing.",
    );
  }
  const parsed = apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new IdentityProviderAdminClientError(
      "rejected",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new IdentityProviderAdminClientError(
    response.status >= 500 ? "unavailable" : "rejected",
    "request_failed",
    response.status >= 500
      ? "The gateway is temporarily unavailable. No settings were changed."
      : "The request could not be completed.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new IdentityProviderAdminClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned a response that did not match the public contract.",
    );
  }
  return parsed.data;
}

async function mutationRequest<T>(
  path: string,
  csrfToken: string,
  method: "DELETE" | "POST" | "PUT",
  schema: ResponseSchema<T>,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        [CSRF_HEADER]: csrfToken,
      },
      method,
    });
  } catch {
    throw new IdentityProviderAdminClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached. No settings were changed.",
    );
  }
  return parsedResponse(response, schema);
}

export async function loadIdentityProviderAdministration(): Promise<IdentityProviderAdminLoadOutcome> {
  try {
    const sessionResponse = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!sessionResponse.ok) {
      return sessionResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const session = sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success) return { status: "unavailable" };
    if (session.data.principal === null || session.data.csrfToken === null) {
      return { status: "signed_out" };
    }
    if (!session.data.principal.permissions.includes("recovery.oidc.manage")) {
      return { status: "forbidden" };
    }

    const providersResponse = await fetch("/api/admin/auth/oidc/providers", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (providersResponse.status === 401) return { status: "signed_out" };
    if (providersResponse.status === 403) return { status: "forbidden" };
    const providers = await parsedResponse(providersResponse, oidcProvidersAdminResponseSchema);
    return {
      snapshot: {
        csrfToken: session.data.csrfToken,
        principal: session.data.principal,
        providers: providers.providers,
      },
      status: "ready",
    };
  } catch {
    return { status: "unavailable" };
  }
}

export interface IdentityProviderAdminClient {
  createProvider(input: OidcProviderCreateRequest, csrfToken: string): Promise<OidcProviderAdmin>;
  createRoleMapping(
    providerId: string,
    input: OidcRoleMappingCreateRequest,
    csrfToken: string,
  ): Promise<OidcRoleMappingMutationResponse>;
  deleteProvider(providerId: string, csrfToken: string): Promise<OidcProviderDeleteResponse>;
  deleteRoleMapping(
    providerId: string,
    mappingId: string,
    csrfToken: string,
  ): Promise<OidcRoleMappingDeleteResponse>;
  listRoleMappings(providerId: string): Promise<readonly RoleMapping[]>;
  load(): Promise<IdentityProviderAdminLoadOutcome>;
  updateProvider(
    providerId: string,
    input: OidcProviderUpdateRequest,
    csrfToken: string,
  ): Promise<OidcProviderMutationResponse>;
  validateProvider(providerId: string, csrfToken: string): Promise<OidcProviderValidationResponse>;
}

export const identityProviderAdminClient: IdentityProviderAdminClient = {
  async createProvider(input, csrfToken) {
    const body = oidcProviderCreateRequestSchema.parse(input);
    return mutationRequest(
      "/api/admin/auth/oidc/providers",
      csrfToken,
      "POST",
      oidcProviderAdminSchema,
      body,
    );
  },

  async createRoleMapping(providerId, input, csrfToken) {
    const body = oidcRoleMappingCreateRequestSchema.parse(input);
    return mutationRequest(
      `/api/admin/auth/oidc/providers/${encodeURIComponent(providerId)}/role-mappings`,
      csrfToken,
      "POST",
      oidcRoleMappingMutationResponseSchema,
      body,
    );
  },

  deleteProvider(providerId, csrfToken) {
    return mutationRequest(
      `/api/admin/auth/oidc/providers/${encodeURIComponent(providerId)}`,
      csrfToken,
      "DELETE",
      oidcProviderDeleteResponseSchema,
    );
  },

  deleteRoleMapping(providerId, mappingId, csrfToken) {
    return mutationRequest(
      `/api/admin/auth/oidc/providers/${encodeURIComponent(providerId)}/role-mappings/${encodeURIComponent(mappingId)}`,
      csrfToken,
      "DELETE",
      oidcRoleMappingDeleteResponseSchema,
    );
  },

  async listRoleMappings(providerId) {
    let response: Response;
    try {
      response = await fetch(
        `/api/admin/auth/oidc/providers/${encodeURIComponent(providerId)}/role-mappings`,
        { cache: "no-store", credentials: "same-origin" },
      );
    } catch {
      throw new IdentityProviderAdminClientError(
        "unavailable",
        "service_unavailable",
        "Role mappings could not be loaded.",
      );
    }
    return (await parsedResponse(response, oidcRoleMappingsAdminResponseSchema)).mappings;
  },

  load: loadIdentityProviderAdministration,

  updateProvider(providerId, input, csrfToken) {
    const body = oidcProviderUpdateRequestSchema.parse(input);
    return mutationRequest(
      `/api/admin/auth/oidc/providers/${encodeURIComponent(providerId)}`,
      csrfToken,
      "PUT",
      oidcProviderMutationResponseSchema,
      body,
    );
  },

  validateProvider(providerId, csrfToken) {
    return mutationRequest(
      `/api/admin/auth/oidc/providers/${encodeURIComponent(providerId)}/validate`,
      csrfToken,
      "POST",
      oidcProviderValidationResponseSchema,
    );
  },
};
