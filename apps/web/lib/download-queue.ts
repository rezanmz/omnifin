import type { DownloadQueueResponse } from "@omnifin/contracts/downloads";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [downloads, errors] = await Promise.all([
    import("@omnifin/contracts/downloads"),
    import("@omnifin/contracts/errors"),
  ]);
  return { downloads, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type DownloadQueueClientErrorKind =
  "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class DownloadQueueClientError extends Error {
  public readonly code: string;
  public readonly kind: DownloadQueueClientErrorKind;

  public constructor(kind: DownloadQueueClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "DownloadQueueClientError";
    this.kind = kind;
    this.code = code;
  }
}

export type DownloadQueueLoadOutcome =
  | { queue: DownloadQueueResponse; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DownloadQueueClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<DownloadQueueClientError> {
  if (response.status === 401) {
    return new DownloadQueueClientError(
      "signed_out",
      "authentication_required",
      "Sign in to inspect download activity.",
    );
  }
  if (response.status === 403) {
    return new DownloadQueueClientError(
      "forbidden",
      "permission_denied",
      "Operator access is required to inspect download clients.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new DownloadQueueClientError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new DownloadQueueClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    "request_failed",
    "Download activity could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new DownloadQueueClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned download data that did not match the public contract.",
    );
  }
  return parsed.data;
}

export interface DownloadQueueClient {
  load(signal?: AbortSignal): Promise<DownloadQueueResponse>;
}

export const downloadQueueClient: DownloadQueueClient = {
  async load(signal) {
    let response: Response;
    try {
      response = await fetch("/api/downloads/queue", {
        cache: "no-store",
        credentials: "same-origin",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new DownloadQueueClientError(
        "unavailable",
        "service_unavailable",
        "The gateway could not be reached.",
      );
    }
    const schemas = (await contractSchemas()).downloads;
    return parsedResponse(response, schemas.downloadQueueResponseSchema);
  },
};

export function outcomeFromError(
  error: unknown,
): Exclude<DownloadQueueLoadOutcome["status"], "ready"> {
  if (error instanceof DownloadQueueClientError) {
    if (error.kind === "forbidden" || error.kind === "signed_out") return error.kind;
  }
  return "unavailable";
}
