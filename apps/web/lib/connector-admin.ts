import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  ConnectorAdmin,
  ConnectorCreateRequest,
  ConnectorDeleteResponse,
  ConnectorUpdateRequest,
} from "@omnifin/contracts/connectors";
import type {
  JellyfinProvisioningConfig,
  JellyfinProvisioningReplaceRequest,
  JellyfinProvisioningTemplatesResponse,
} from "@omnifin/contracts/connectors";

const CSRF_HEADER = "x-omnifin-csrf";
const PAGE_LIMIT = 50;
const MAX_CONNECTOR_PAGES = 20;

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, connectors, errors] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/connectors"),
    import("@omnifin/contracts/errors"),
  ]);
  return { auth, connectors, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export interface ConnectorAdminSnapshot {
  connectors: readonly ConnectorAdmin[];
  csrfToken: string;
  principal: SessionPrincipal;
  recoveryOnly: boolean;
}

export type ConnectorAdminLoadOutcome =
  | { snapshot: ConnectorAdminSnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export type ConnectorAdminClientErrorKind =
  "invalid_response" | "rejected" | "session_changed" | "unavailable";

export class ConnectorAdminClientError extends Error {
  public readonly code: string;
  public readonly kind: ConnectorAdminClientErrorKind;

  public constructor(kind: ConnectorAdminClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "ConnectorAdminClientError";
    this.kind = kind;
    this.code = code;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new ConnectorAdminClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<ConnectorAdminClientError> {
  if (response.status === 401 || response.status === 403) {
    return new ConnectorAdminClientError(
      "session_changed",
      response.status === 401 ? "session_signed_out" : "permission_changed",
      "Your administrative session changed. Sign in again before continuing.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new ConnectorAdminClientError(
      "rejected",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new ConnectorAdminClientError(
    response.status >= 500 ? "unavailable" : "rejected",
    "request_failed",
    response.status >= 500
      ? "The gateway is temporarily unavailable. No connector settings were changed."
      : "The request could not be completed.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new ConnectorAdminClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned a response that did not match the public contract.",
    );
  }
  return parsed.data;
}

async function fetchSameOrigin(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch {
    throw new ConnectorAdminClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached. No connector settings were changed.",
    );
  }
}

async function mutationRequest<T>(
  path: string,
  csrfToken: string,
  method: "DELETE" | "PATCH" | "POST",
  schema: ResponseSchema<T>,
  body?: unknown,
): Promise<T> {
  const response = await fetchSameOrigin(path, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      [CSRF_HEADER]: csrfToken,
    },
    method,
  });
  return parsedResponse(response, schema);
}

async function listEveryConnector(): Promise<readonly ConnectorAdmin[]> {
  const connectors: ConnectorAdmin[] = [];
  const schemas = (await contractSchemas()).connectors;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_CONNECTOR_PAGES; page += 1) {
    const parameters = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor !== null) parameters.set("cursor", cursor);
    const response = await fetchSameOrigin(`/api/admin/connectors?${parameters.toString()}`);
    const result = await parsedResponse(response, schemas.connectorListResponseSchema);
    connectors.push(...result.items);
    if (result.nextCursor === null) return connectors;
    cursor = result.nextCursor;
  }

  throw new ConnectorAdminClientError(
    "invalid_response",
    "pagination_limit_exceeded",
    "The gateway returned too many connector pages to safely display.",
  );
}

export async function loadConnectorAdministration(): Promise<ConnectorAdminLoadOutcome> {
  try {
    const sessionResponse = await fetchSameOrigin("/api/auth/session");
    if (!sessionResponse.ok) {
      return sessionResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const schemas = await contractSchemas();
    const session = schemas.auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success) return { status: "unavailable" };
    if (session.data.principal === null || session.data.csrfToken === null) {
      return { status: "signed_out" };
    }

    const canManageAll = session.data.principal.permissions.includes("connectors.manage");
    const canRepairJellyfin = session.data.principal.permissions.includes(
      "recovery.jellyfin.manage",
    );
    if (!canManageAll && !canRepairJellyfin) return { status: "forbidden" };

    try {
      const connectors = await listEveryConnector();
      return {
        snapshot: {
          connectors,
          csrfToken: session.data.csrfToken,
          principal: session.data.principal,
          recoveryOnly: !canManageAll,
        },
        status: "ready",
      };
    } catch (error) {
      if (error instanceof ConnectorAdminClientError && error.kind === "session_changed") {
        return error.code === "session_signed_out"
          ? { status: "signed_out" }
          : { status: "forbidden" };
      }
      throw error;
    }
  } catch {
    return { status: "unavailable" };
  }
}

export interface ConnectorAdminClient {
  create(input: ConnectorCreateRequest, csrfToken: string): Promise<ConnectorAdmin>;
  delete(
    connectorId: string,
    revision: string,
    csrfToken: string,
  ): Promise<ConnectorDeleteResponse>;
  get(connectorId: string): Promise<ConnectorAdmin>;
  load(): Promise<ConnectorAdminLoadOutcome>;
  probe(connectorId: string, csrfToken: string): Promise<ConnectorAdmin>;
  update(
    connectorId: string,
    input: ConnectorUpdateRequest,
    csrfToken: string,
  ): Promise<ConnectorAdmin>;
}

export interface JellyfinProvisioningClient {
  get(connectorId: string, signal?: AbortSignal): Promise<JellyfinProvisioningConfig>;
  templates(connectorId: string, signal?: AbortSignal): Promise<JellyfinProvisioningTemplatesResponse>;
  update(
    connectorId: string,
    input: JellyfinProvisioningReplaceRequest,
    csrfToken: string,
    signal?: AbortSignal,
  ): Promise<JellyfinProvisioningConfig>;
}

export const connectorAdminClient: ConnectorAdminClient = {
  async create(input, csrfToken) {
    const schemas = (await contractSchemas()).connectors;
    const body = schemas.connectorCreateRequestSchema.parse(input);
    const result = await mutationRequest(
      "/api/admin/connectors",
      csrfToken,
      "POST",
      schemas.connectorMutationResponseSchema,
      body,
    );
    return result.connector;
  },

  async delete(connectorId, revision, csrfToken) {
    const schemas = (await contractSchemas()).connectors;
    const parameters = new URLSearchParams({ revision });
    return mutationRequest(
      `/api/admin/connectors/${encodeURIComponent(connectorId)}?${parameters.toString()}`,
      csrfToken,
      "DELETE",
      schemas.connectorDeleteResponseSchema,
    );
  },

  async get(connectorId) {
    const schemas = (await contractSchemas()).connectors;
    const response = await fetchSameOrigin(
      `/api/admin/connectors/${encodeURIComponent(connectorId)}`,
    );
    return (await parsedResponse(response, schemas.connectorMutationResponseSchema)).connector;
  },

  load: loadConnectorAdministration,

  async probe(connectorId, csrfToken) {
    const schemas = (await contractSchemas()).connectors;
    const result = await mutationRequest(
      `/api/admin/connectors/${encodeURIComponent(connectorId)}/probe`,
      csrfToken,
      "POST",
      schemas.connectorMutationResponseSchema,
    );
    return result.connector;
  },

  async update(connectorId, input, csrfToken) {
    const schemas = (await contractSchemas()).connectors;
    const body = schemas.connectorUpdateRequestSchema.parse(input);
    const result = await mutationRequest(
      `/api/admin/connectors/${encodeURIComponent(connectorId)}`,
      csrfToken,
      "PATCH",
      schemas.connectorMutationResponseSchema,
      body,
    );
    return result.connector;
  },
};

export const jellyfinProvisioningClient: JellyfinProvisioningClient = {
  async get(connectorId, signal) {
    const schemas = (await contractSchemas()).connectors;
    const response = await fetchSameOrigin(
      `/api/admin/connectors/${encodeURIComponent(connectorId)}/jellyfin-provisioning`,
      signal ? { signal } : {},
    );
    return parsedResponse(response, schemas.jellyfinProvisioningConfigSchema);
  },
  async templates(connectorId, signal) {
    const schemas = (await contractSchemas()).connectors;
    const response = await fetchSameOrigin(
      `/api/admin/connectors/${encodeURIComponent(connectorId)}/jellyfin-provisioning/templates`,
      signal ? { signal } : {},
    );
    return parsedResponse(response, schemas.jellyfinProvisioningTemplatesResponseSchema);
  },
  async update(connectorId, input, csrfToken, signal) {
    const schemas = (await contractSchemas()).connectors;
    const body = schemas.jellyfinProvisioningReplaceRequestSchema.parse(input);
    const response = await fetchSameOrigin(
      `/api/admin/connectors/${encodeURIComponent(connectorId)}/jellyfin-provisioning`,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
        method: "PUT",
        ...(signal ? { signal } : {}),
      },
    );
    return parsedResponse(response, schemas.jellyfinProvisioningConfigSchema);
  },
};
