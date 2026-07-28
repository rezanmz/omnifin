import type { AcquisitionCalendarResponse } from "@omnifin/contracts/calendar";

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [calendar, errors] = await Promise.all([
    import("@omnifin/contracts/calendar"),
    import("@omnifin/contracts/errors"),
  ]);
  return { calendar, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export interface AcquisitionCalendarRange {
  cursor?: string;
  endAt: string;
  limit?: number;
  startAt: string;
}

export type AcquisitionCalendarClientErrorKind =
  "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class AcquisitionCalendarClientError extends Error {
  public readonly code: string;
  public readonly kind: AcquisitionCalendarClientErrorKind;

  public constructor(kind: AcquisitionCalendarClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "AcquisitionCalendarClientError";
    this.kind = kind;
    this.code = code;
  }
}

export type AcquisitionCalendarLoadOutcome =
  | { calendar: AcquisitionCalendarResponse; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AcquisitionCalendarClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable response.",
    );
  }
}

async function responseError(response: Response): Promise<AcquisitionCalendarClientError> {
  if (response.status === 401) {
    return new AcquisitionCalendarClientError(
      "signed_out",
      "authentication_required",
      "Sign in to view the acquisition calendar.",
    );
  }
  if (response.status === 403) {
    return new AcquisitionCalendarClientError(
      "forbidden",
      "permission_denied",
      "Your account cannot view acquisition timing.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  if (parsed.success) {
    return new AcquisitionCalendarClientError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      parsed.data.error.code,
      parsed.data.error.message,
    );
  }
  return new AcquisitionCalendarClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    "request_failed",
    "The acquisition calendar could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new AcquisitionCalendarClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned calendar data that did not match the public contract.",
    );
  }
  return parsed.data;
}

export interface AcquisitionCalendarClient {
  load(range: AcquisitionCalendarRange, signal?: AbortSignal): Promise<AcquisitionCalendarResponse>;
}

export const acquisitionCalendarClient: AcquisitionCalendarClient = {
  async load(range, signal) {
    const parameters = new URLSearchParams({
      end: range.endAt,
      limit: String(range.limit ?? 100),
      start: range.startAt,
    });
    if (range.cursor) parameters.set("cursor", range.cursor);
    let response: Response;
    try {
      response = await fetch(`/api/acquisitions/calendar?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new AcquisitionCalendarClientError(
        "unavailable",
        "service_unavailable",
        "The gateway could not be reached.",
      );
    }
    const schemas = (await contractSchemas()).calendar;
    return parsedResponse(response, schemas.acquisitionCalendarResponseSchema);
  },
};

export function acquisitionCalendarOutcomeFromError(
  error: unknown,
): Exclude<AcquisitionCalendarLoadOutcome["status"], "ready"> {
  if (error instanceof AcquisitionCalendarClientError) {
    if (error.kind === "forbidden" || error.kind === "signed_out") return error.kind;
  }
  return "unavailable";
}
