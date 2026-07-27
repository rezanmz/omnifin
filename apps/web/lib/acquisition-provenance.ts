import type {
  AcquisitionProvenanceResponse,
  AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";

async function loadContractSchemas() {
  await import("./zod-browser");
  const [acquisition, errors] = await Promise.all([
    import("@omnifin/contracts/acquisition"),
    import("@omnifin/contracts/errors"),
  ]);
  return { acquisition, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type AcquisitionProvenanceClientErrorKind =
  | "forbidden"
  | "invalid_response"
  | "not_configured"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class AcquisitionProvenanceClientError extends Error {
  public readonly code: string;
  public readonly kind: AcquisitionProvenanceClientErrorKind;

  public constructor(kind: AcquisitionProvenanceClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "AcquisitionProvenanceClientError";
    this.kind = kind;
    this.code = code;
  }
}

function errorKind(status: number, code: string): AcquisitionProvenanceClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (code === "acquisition_not_configured") return "not_configured";
  if (status === 429 || code === "acquisition_rate_limited") return "rate_limited";
  if (code === "acquisition_response_invalid") return "invalid_response";
  return "unavailable";
}

async function responseError(response: Response) {
  const { errors } = await contractSchemas();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = errors.apiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : "request_failed";
  return new AcquisitionProvenanceClientError(
    errorKind(response.status, code),
    code,
    parsed.success ? parsed.data.error.message : "Acquisition history is temporarily unavailable.",
  );
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AcquisitionProvenanceClientError(
      "invalid_response",
      "invalid_response",
      "Acquisition history returned an unreadable response.",
    );
  }
}

export interface AcquisitionProvenanceClient {
  read(input: AcquisitionTargetInput, signal?: AbortSignal): Promise<AcquisitionProvenanceResponse>;
}

export const acquisitionProvenanceClient: AcquisitionProvenanceClient = {
  async read(input, signal) {
    const schemas = await contractSchemas();
    const target = schemas.acquisition.acquisitionTargetInputSchema.parse(input);
    const parameters = new URLSearchParams({
      mediaId: String(target.mediaId),
      service: target.service,
    });
    if (target.seasonNumber !== undefined) {
      parameters.set("seasonNumber", String(target.seasonNumber));
    }
    let response: Response;
    try {
      response = await fetch(`/api/acquisitions/provenance?${parameters.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new AcquisitionProvenanceClientError(
        "unavailable",
        "service_unavailable",
        "Acquisition history could not reach the gateway.",
      );
    }
    if (!response.ok) throw await responseError(response);
    const parsed = schemas.acquisition.acquisitionProvenanceResponseSchema.safeParse(
      await safeJson(response),
    );
    if (!parsed.success) {
      throw new AcquisitionProvenanceClientError(
        "invalid_response",
        "invalid_response",
        "Acquisition history did not match the public contract.",
      );
    }
    return parsed.data;
  },
};
