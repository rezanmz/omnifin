import type {
  InvitationCreateResponse,
  InvitationSummary,
  SessionPrincipal,
} from "@omnifin/contracts/auth";

const CSRF_HEADER = "x-omnifin-csrf";

export type InviteStatus = InvitationSummary["status"];
export type AdminInvite = InvitationSummary;
export type CreatedAdminInvite = InvitationCreateResponse;
export type InviteLifetime = 3_600 | 86_400 | 604_800 | 2_592_000;

export type InviteLoadOutcome =
  | {
      status: "ready";
      invites: readonly AdminInvite[];
      nextCursor: string | null;
      csrfToken: string;
    }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export class InviteAdminClientError extends Error {
  public constructor(
    public readonly kind: "session_changed" | "unavailable" | "rejected" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "InviteAdminClientError";
  }
}

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

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new InviteAdminClientError("invalid_response", "The gateway returned unreadable data.");
  }
}

async function responseError(response: Response): Promise<InviteAdminClientError> {
  if (response.status === 401 || response.status === 403) {
    return new InviteAdminClientError(
      "session_changed",
      response.status === 401
        ? "Your session ended. Sign in again."
        : "You no longer have permission to manage invitations.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  return new InviteAdminClientError(
    response.status >= 500 ? "unavailable" : "rejected",
    parsed.success ? parsed.data.error.message : "The invitation request could not be completed.",
  );
}

async function fetchSameOrigin(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    throw new InviteAdminClientError("unavailable", "The invitation service could not be reached.");
  }
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new InviteAdminClientError(
      "invalid_response",
      "The gateway returned a response that did not match the invitation contract.",
    );
  }
  return parsed.data;
}

async function session() {
  const { auth } = await contractSchemas();
  const response = await fetchSameOrigin("/api/auth/session");
  if (!response.ok) {
    throw new InviteAdminClientError(
      response.status === 401 ? "session_changed" : "unavailable",
      response.status === 401
        ? "Your session ended. Sign in again."
        : "The session could not be checked.",
    );
  }
  const parsed = auth.sessionResponseSchema.safeParse(await safeJson(response));
  if (!parsed.success || parsed.data.principal === null || parsed.data.csrfToken === null) {
    throw new InviteAdminClientError("session_changed", "Your session ended. Sign in again.");
  }
  const principal: SessionPrincipal = parsed.data.principal;
  if (
    principal.authenticationMethod.kind === "recovery" ||
    !principal.permissions.includes("identities.manage")
  ) {
    throw new InviteAdminClientError(
      "session_changed",
      "You no longer have permission to manage invitations.",
    );
  }
  return parsed.data.csrfToken;
}

export interface InviteAdminClient {
  load(cursor?: string | null): Promise<InviteLoadOutcome>;
  create(
    expiresInSeconds: InviteLifetime | undefined,
    csrfToken: string,
  ): Promise<CreatedAdminInvite>;
  revoke(id: string, csrfToken: string): Promise<InvitationSummary>;
}

export const inviteAdminClient: InviteAdminClient = {
  async load(cursor = null) {
    try {
      const csrfToken = await session();
      const { auth } = await contractSchemas();
      const parameters = new URLSearchParams();
      if (cursor) parameters.set("cursor", cursor);
      const result = await parsedResponse(
        await fetchSameOrigin(
          `/api/admin/invites${parameters.size ? `?${parameters.toString()}` : ""}`,
        ),
        auth.invitationListResponseSchema,
      );
      return {
        status: "ready",
        invites: result.invitations,
        nextCursor: result.nextCursor,
        csrfToken,
      } satisfies InviteLoadOutcome;
    } catch (error) {
      if (error instanceof InviteAdminClientError && error.kind === "session_changed") {
        return { status: error.message.includes("ended") ? "signed_out" : "forbidden" };
      }
      return { status: "unavailable" };
    }
  },
  async create(expiresInSeconds, csrfToken) {
    const { auth } = await contractSchemas();
    const body = expiresInSeconds === undefined ? {} : { expiresInSeconds };
    return parsedResponse(
      await fetchSameOrigin("/api/admin/invites", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
        method: "POST",
      }),
      auth.invitationCreateResponseSchema,
    );
  },
  async revoke(id, csrfToken) {
    const { auth } = await contractSchemas();
    const result = await parsedResponse(
      await fetchSameOrigin(`/api/admin/invites/${encodeURIComponent(id)}/revoke`, {
        headers: { [CSRF_HEADER]: csrfToken },
        method: "POST",
      }),
      auth.invitationRevokeResponseSchema,
    );
    return result.invitation;
  },
};
