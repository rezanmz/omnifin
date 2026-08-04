import type { ViewingHistoryQuery, ViewingHistoryResponse } from "@omnifin/contracts/library";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadSchemas() {
  await import("./zod-browser");
  const [errors, library] = await Promise.all([
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/library"),
  ]);
  return { errors, library };
}

let schemasPromise: ReturnType<typeof loadSchemas> | undefined;

function schemas() {
  schemasPromise ??= loadSchemas();
  return schemasPromise;
}

export type ViewingHistoryClientErrorKind =
  "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class ViewingHistoryClientError extends Error {
  public readonly code: string;
  public readonly kind: ViewingHistoryClientErrorKind;

  public constructor(kind: ViewingHistoryClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "ViewingHistoryClientError";
    this.kind = kind;
    this.code = code;
  }
}

export interface ViewingHistoryClient {
  load(input: ViewingHistoryQuery, signal?: AbortSignal): Promise<ViewingHistoryResponse>;
}

export type ViewingHistoryLoadOutcome =
  | { history: ViewingHistoryResponse; status: "ready" }
  | { status: "forbidden" | "loading" | "signed_out" | "unavailable" };

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new ViewingHistoryClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned unreadable viewing history.",
    );
  }
}

async function errorFromResponse(response: Response) {
  if (response.status === 401) {
    return new ViewingHistoryClientError(
      "signed_out",
      "authentication_required",
      "Sign in to open your viewing history.",
    );
  }
  if (response.status === 403) {
    return new ViewingHistoryClientError(
      "forbidden",
      "permission_denied",
      "Your account cannot view Jellyfin playback history.",
    );
  }
  const contracts = await schemas();
  const parsed = contracts.errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new ViewingHistoryClientError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new ViewingHistoryClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    "request_failed",
    "Viewing history could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>) {
  if (!response.ok) throw await errorFromResponse(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new ViewingHistoryClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned viewing history outside the public contract.",
    );
  }
  return parsed.data;
}

function queryParameters(input: ViewingHistoryQuery) {
  const parameters = new URLSearchParams({
    kind: input.kind,
    limit: String(input.limit),
    range: input.range,
    state: input.state,
  });
  if (input.cursor) parameters.set("cursor", input.cursor);
  return parameters;
}

export const viewingHistoryClient: ViewingHistoryClient = {
  async load(rawInput, signal) {
    const contracts = await schemas();
    const input = contracts.library.viewingHistoryQuerySchema.parse(rawInput);
    let response: Response;
    try {
      response = await fetch(`/api/media/history?${queryParameters(input).toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ViewingHistoryClientError(
        "unavailable",
        "service_unavailable",
        "The gateway could not be reached.",
      );
    }
    return parsedResponse(response, contracts.library.viewingHistoryResponseSchema);
  },
};

export function viewingHistoryOutcomeFromError(
  error: unknown,
): Exclude<ViewingHistoryLoadOutcome["status"], "loading" | "ready"> {
  if (error instanceof ViewingHistoryClientError) {
    if (error.kind === "forbidden" || error.kind === "signed_out") return error.kind;
  }
  return "unavailable";
}
