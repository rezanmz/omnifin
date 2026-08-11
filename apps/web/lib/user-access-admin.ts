import type {
  SessionPrincipal,
  OidcRoleAssignmentRequest,
  OidcRoleAssignmentResponse,
  UserAccessMutationRequest,
  UserAccessMutationResponse,
  UserAccessSummary,
} from "@omnifin/contracts/auth";

const CSRF_HEADER = "x-omnifin-csrf";
const MAX_USER_PAGES = 20;

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
  ]);
  return { auth, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export interface UserAccessAdminSnapshot {
  csrfToken: string;
  principal: SessionPrincipal;
  users: readonly UserAccessSummary[];
}

export type UserAccessAdminLoadOutcome =
  | { snapshot: UserAccessAdminSnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export type UserAccessAdminClientErrorKind =
  "invalid_response" | "rejected" | "session_changed" | "unavailable";

export class UserAccessAdminClientError extends Error {
  public readonly code: string;
  public readonly kind: UserAccessAdminClientErrorKind;

  public constructor(kind: UserAccessAdminClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "UserAccessAdminClientError";
    this.kind = kind;
    this.code = code;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new UserAccessAdminClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<UserAccessAdminClientError> {
  if (response.status === 401 || response.status === 403) {
    return new UserAccessAdminClientError(
      "session_changed",
      response.status === 401 ? "session_signed_out" : "permission_changed",
      "Your administrative session changed. Sign in again before continuing.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new UserAccessAdminClientError(
      "rejected",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new UserAccessAdminClientError(
    response.status >= 500 ? "unavailable" : "rejected",
    "request_failed",
    response.status >= 500
      ? "The gateway is temporarily unavailable. No access was changed."
      : "The account change could not be completed.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new UserAccessAdminClientError(
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
    throw new UserAccessAdminClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached. No access was changed.",
    );
  }
}

async function listEveryUser(): Promise<readonly UserAccessSummary[]> {
  const users: UserAccessSummary[] = [];
  const { auth } = await contractSchemas();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_USER_PAGES; page += 1) {
    const parameters = new URLSearchParams();
    if (cursor !== null) parameters.set("cursor", cursor);
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
    const response = await fetchSameOrigin(`/api/admin/users${suffix}`);
    const result = await parsedResponse(response, auth.userAccessListResponseSchema);
    users.push(...result.users);
    if (result.nextCursor === null) return users;
    cursor = result.nextCursor;
  }

  throw new UserAccessAdminClientError(
    "invalid_response",
    "pagination_limit_exceeded",
    "The gateway returned too many user pages to safely display.",
  );
}

export async function loadUserAccessAdministration(): Promise<UserAccessAdminLoadOutcome> {
  try {
    const { auth } = await contractSchemas();
    const sessionResponse = await fetchSameOrigin("/api/auth/session");
    if (!sessionResponse.ok) {
      return sessionResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const session = auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success) return { status: "unavailable" };
    if (session.data.principal === null || session.data.csrfToken === null) {
      return { status: "signed_out" };
    }
    if (
      session.data.principal.authenticationMethod.kind === "recovery" ||
      !session.data.principal.permissions.includes("roles.manage")
    ) {
      return { status: "forbidden" };
    }

    try {
      return {
        snapshot: {
          csrfToken: session.data.csrfToken,
          principal: session.data.principal,
          users: await listEveryUser(),
        },
        status: "ready",
      };
    } catch (error) {
      if (error instanceof UserAccessAdminClientError && error.kind === "session_changed") {
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

export interface UserAccessAdminClient {
  load(): Promise<UserAccessAdminLoadOutcome>;
  update(
    userId: string,
    input: UserAccessMutationRequest,
    csrfToken: string,
  ): Promise<UserAccessMutationResponse>;
  assignOidcRole(
    userId: string,
    input: OidcRoleAssignmentRequest,
    csrfToken: string,
  ): Promise<OidcRoleAssignmentResponse>;
}

export const userAccessAdminClient: UserAccessAdminClient = {
  load: loadUserAccessAdministration,

  async update(userId, input, csrfToken) {
    const { auth } = await contractSchemas();
    const body = auth.userAccessMutationRequestSchema.parse(input);
    const response = await fetchSameOrigin(`/api/admin/users/${encodeURIComponent(userId)}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
      method: "PATCH",
    });
    return parsedResponse(response, auth.userAccessMutationResponseSchema);
  },

  async assignOidcRole(userId, input, csrfToken) {
    const { auth } = await contractSchemas();
    const body = auth.oidcRoleAssignmentRequestSchema.parse(input);
    const response = await fetchSameOrigin(
      `/api/admin/users/${encodeURIComponent(userId)}/oidc-role-assignment`,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
        method: "POST",
      },
    );
    return parsedResponse(response, auth.oidcRoleAssignmentResponseSchema);
  },
};
