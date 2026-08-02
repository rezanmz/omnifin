import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  AuditEventCategory,
  AuditEventListResponse,
  AuditEventOutcome,
} from "@omnifin/contracts/audit";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [audit, auth, errors] = await Promise.all([
    import("@omnifin/contracts/audit"),
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
  ]);
  return { audit, auth, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export interface AuditTrailQuery {
  category?: AuditEventCategory;
  cursor?: string;
  limit?: number;
  outcome?: AuditEventOutcome;
}

export type AuditTrailLoadOutcome =
  | { page: AuditEventListResponse; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export type AuditTrailClientErrorKind =
  "invalid_response" | "rejected" | "session_changed" | "unavailable";

export class AuditTrailClientError extends Error {
  public readonly code: string;
  public readonly kind: AuditTrailClientErrorKind;

  public constructor(kind: AuditTrailClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "AuditTrailClientError";
    this.kind = kind;
    this.code = code;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AuditTrailClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<AuditTrailClientError> {
  if (response.status === 401 || response.status === 403) {
    return new AuditTrailClientError(
      "session_changed",
      response.status === 401 ? "session_signed_out" : "permission_changed",
      "Your administrative session changed. Sign in again before continuing.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new AuditTrailClientError(
      response.status >= 500 ? "unavailable" : "rejected",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new AuditTrailClientError(
    response.status >= 500 ? "unavailable" : "rejected",
    "request_failed",
    response.status >= 500
      ? "The audit trail is temporarily unavailable."
      : "The audit trail request was rejected.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new AuditTrailClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned data that did not match the public audit contract.",
    );
  }
  return parsed.data;
}

async function fetchSameOrigin(path: string): Promise<Response> {
  try {
    return await fetch(path, { cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new AuditTrailClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached.",
    );
  }
}

function queryPath(query: AuditTrailQuery) {
  const parameters = new URLSearchParams();
  if (query.category) parameters.set("category", query.category);
  if (query.cursor) parameters.set("cursor", query.cursor);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  if (query.outcome) parameters.set("outcome", query.outcome);
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return `/api/admin/audit-events${suffix}`;
}

async function readSession(): Promise<SessionPrincipal | null> {
  const { auth } = await contractSchemas();
  const response = await fetchSameOrigin("/api/auth/session");
  if (response.status === 401) return null;
  const session = await parsedResponse(response, auth.sessionResponseSchema);
  return session.principal;
}

export interface AuditTrailClient {
  load(query?: AuditTrailQuery): Promise<AuditTrailLoadOutcome>;
  page(query?: AuditTrailQuery): Promise<AuditEventListResponse>;
}

export async function loadAuditTrail(query: AuditTrailQuery = {}): Promise<AuditTrailLoadOutcome> {
  try {
    const principal = await readSession();
    if (principal === null) return { status: "signed_out" };
    if (
      principal.authenticationMethod.kind === "recovery" ||
      !principal.permissions.includes("audit.view")
    ) {
      return { status: "forbidden" };
    }
    return { page: await auditTrailClient.page(query), status: "ready" };
  } catch (error) {
    if (error instanceof AuditTrailClientError && error.kind === "session_changed") {
      return error.code === "session_signed_out"
        ? { status: "signed_out" }
        : { status: "forbidden" };
    }
    return { status: "unavailable" };
  }
}

export const auditTrailClient: AuditTrailClient = {
  load: loadAuditTrail,

  async page(query = {}) {
    const { audit } = await contractSchemas();
    return parsedResponse(
      await fetchSameOrigin(queryPath(query)),
      audit.auditEventListResponseSchema,
    );
  },
};
