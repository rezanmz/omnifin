import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  IndexerApplicationListResponse,
  IndexerFailureListResponse,
  IndexerIntelligenceResponse,
  IndexerTestResponse,
} from "@omnifin/contracts/indexers";

const CSRF_HEADER = "x-omnifin-csrf";
const PAGE_LIMIT = 25;

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors, indexers] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/indexers"),
  ]);
  return { auth, errors, indexers };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type IndexerIntelligenceClientErrorKind =
  | "forbidden"
  | "invalid_response"
  | "not_configured"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class IndexerIntelligenceClientError extends Error {
  public readonly code: string;
  public readonly kind: IndexerIntelligenceClientErrorKind;

  public constructor(kind: IndexerIntelligenceClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "IndexerIntelligenceClientError";
    this.kind = kind;
    this.code = code;
  }
}

export type IndexerIntelligenceSection<T> =
  { data: T; status: "ready" } | { status: "unavailable" };

export interface IndexerIntelligenceSnapshot {
  applications: IndexerIntelligenceSection<IndexerApplicationListResponse>;
  csrfToken: string;
  failures: IndexerIntelligenceSection<IndexerFailureListResponse>;
  indexers: IndexerIntelligenceResponse;
  principal: SessionPrincipal;
}

export type IndexerIntelligenceLoadOutcome =
  | { snapshot: IndexerIntelligenceSnapshot; status: "ready" }
  | {
      status: "forbidden" | "not_configured" | "signed_out" | "unavailable";
    };

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new IndexerIntelligenceClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<IndexerIntelligenceClientError> {
  if (response.status === 401) {
    return new IndexerIntelligenceClientError(
      "signed_out",
      "authentication_required",
      "Sign in to inspect indexer intelligence.",
    );
  }
  if (response.status === 403) {
    return new IndexerIntelligenceClientError(
      "forbidden",
      "permission_denied",
      "Operator access is required for indexer intelligence.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    const code = parsed.data.error.code;
    const kind: IndexerIntelligenceClientErrorKind =
      code === "indexer_intelligence_not_configured"
        ? "not_configured"
        : response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "unavailable"
            : "invalid_response";
    return new IndexerIntelligenceClientError(kind, code, parsed.data.error.message);
  }
  return new IndexerIntelligenceClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    "request_failed",
    "Indexer intelligence could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new IndexerIntelligenceClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned indexer data that did not match the public contract.",
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
    throw new IndexerIntelligenceClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached.",
    );
  }
}

function pagePath(path: string, cursor?: string | null) {
  const parameters = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) parameters.set("cursor", cursor);
  return `${path}?${parameters.toString()}`;
}

async function loadIndexers(cursor?: string | null) {
  const schemas = (await contractSchemas()).indexers;
  return parsedResponse(
    await fetchSameOrigin(pagePath("/api/indexers/intelligence", cursor)),
    schemas.indexerIntelligenceResponseSchema,
  );
}

async function loadApplications(cursor?: string | null) {
  const schemas = (await contractSchemas()).indexers;
  return parsedResponse(
    await fetchSameOrigin(pagePath("/api/indexer-applications", cursor)),
    schemas.indexerApplicationListResponseSchema,
  );
}

async function loadFailures(cursor?: string | null) {
  const schemas = (await contractSchemas()).indexers;
  return parsedResponse(
    await fetchSameOrigin(pagePath("/api/indexer-failures", cursor)),
    schemas.indexerFailureListResponseSchema,
  );
}

async function optionalSection<T>(operation: Promise<T>): Promise<IndexerIntelligenceSection<T>> {
  try {
    return { data: await operation, status: "ready" };
  } catch (error) {
    if (
      error instanceof IndexerIntelligenceClientError &&
      (error.kind === "forbidden" || error.kind === "signed_out")
    ) {
      throw error;
    }
    return { status: "unavailable" };
  }
}

export async function loadIndexerIntelligence(): Promise<IndexerIntelligenceLoadOutcome> {
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
    if (!session.data.principal.permissions.includes("acquisition.manage")) {
      return { status: "forbidden" };
    }

    const indexers = await loadIndexers();
    const [applications, failures] = await Promise.all([
      optionalSection(loadApplications()),
      optionalSection(loadFailures()),
    ]);
    return {
      snapshot: {
        applications,
        csrfToken: session.data.csrfToken,
        failures,
        indexers,
        principal: session.data.principal,
      },
      status: "ready",
    };
  } catch (error) {
    if (error instanceof IndexerIntelligenceClientError) {
      if (
        error.kind === "signed_out" ||
        error.kind === "forbidden" ||
        error.kind === "not_configured"
      ) {
        return { status: error.kind };
      }
    }
    return { status: "unavailable" };
  }
}

export interface IndexerIntelligenceClient {
  load(): Promise<IndexerIntelligenceLoadOutcome>;
  loadApplications(cursor: string): Promise<IndexerApplicationListResponse>;
  loadFailures(cursor: string): Promise<IndexerFailureListResponse>;
  loadIndexers(cursor: string): Promise<IndexerIntelligenceResponse>;
  test(indexerId: number, csrfToken: string): Promise<IndexerTestResponse>;
}

export const indexerIntelligenceClient: IndexerIntelligenceClient = {
  load: loadIndexerIntelligence,
  loadApplications,
  loadFailures,
  loadIndexers,
  async test(indexerId, csrfToken) {
    const schemas = (await contractSchemas()).indexers;
    const response = await fetchSameOrigin(
      `/api/indexers/${encodeURIComponent(String(indexerId))}/tests`,
      {
        headers: { [CSRF_HEADER]: csrfToken },
        method: "POST",
      },
    );
    return parsedResponse(response, schemas.indexerTestResponseSchema);
  },
};
