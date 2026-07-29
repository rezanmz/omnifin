import type {
  AcquisitionMonitoringState,
  AcquisitionMonitoringTargetInput,
  AcquisitionMonitoringUpdateInput,
} from "@omnifin/contracts/acquisition";

const CSRF_HEADER = "x-omnifin-csrf";

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

export type AcquisitionMonitoringClientErrorKind =
  | "configuration"
  | "forbidden"
  | "invalid_response"
  | "rate_limited"
  | "signed_out"
  | "unavailable";

export class AcquisitionMonitoringClientError extends Error {
  public readonly code: string;
  public readonly kind: AcquisitionMonitoringClientErrorKind;

  public constructor(kind: AcquisitionMonitoringClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "AcquisitionMonitoringClientError";
    this.kind = kind;
    this.code = code;
  }
}

export interface UpdateAcquisitionMonitoringOptions {
  csrfToken: string;
  signal?: AbortSignal;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AcquisitionMonitoringClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned an unreadable monitoring response.",
    );
  }
}

async function fetchSameOrigin(path: string, init?: RequestInit) {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AcquisitionMonitoringClientError(
      "unavailable",
      "service_unavailable",
      "Monitoring controls could not reach the gateway.",
    );
  }
}

function errorKind(status: number, code: string): AcquisitionMonitoringClientErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (code === "acquisition_monitoring_response_invalid") return "invalid_response";
  if (code === "acquisition_monitoring_configuration_unavailable") return "configuration";
  return status >= 500 ? "unavailable" : "invalid_response";
}

async function responseError(response: Response) {
  const schemas = await contractSchemas();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = schemas.errors.apiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : "request_failed";
  return new AcquisitionMonitoringClientError(
    errorKind(response.status, code),
    code,
    parsed.success ? parsed.data.error.message : "Monitoring controls are temporarily unavailable.",
  );
}

async function monitoringResponse(response: Response, expected: AcquisitionMonitoringTargetInput) {
  if (!response.ok) throw await responseError(response);
  const schemas = await contractSchemas();
  const parsed = schemas.acquisition.acquisitionMonitoringStateSchema.safeParse(
    await safeJson(response),
  );
  if (!parsed.success) {
    throw new AcquisitionMonitoringClientError(
      "invalid_response",
      "invalid_response",
      "Monitoring state did not match the public contract.",
    );
  }
  if (
    parsed.data.target.mediaId !== expected.mediaId ||
    parsed.data.target.service !== expected.service
  ) {
    throw new AcquisitionMonitoringClientError(
      "invalid_response",
      "invalid_response",
      "Monitoring state did not match the requested target.",
    );
  }
  return parsed.data;
}

export interface AcquisitionMonitoringClient {
  read(
    input: AcquisitionMonitoringTargetInput,
    signal?: AbortSignal,
  ): Promise<AcquisitionMonitoringState>;
  update(
    input: AcquisitionMonitoringUpdateInput,
    options: UpdateAcquisitionMonitoringOptions,
  ): Promise<AcquisitionMonitoringState>;
}

export const acquisitionMonitoringClient: AcquisitionMonitoringClient = {
  async read(input, signal) {
    const schemas = await contractSchemas();
    const target = schemas.acquisition.acquisitionMonitoringTargetInputSchema.parse(input);
    const parameters = new URLSearchParams({
      mediaId: String(target.mediaId),
      service: target.service,
    });
    return monitoringResponse(
      await fetchSameOrigin(`/api/acquisitions/monitoring?${parameters.toString()}`, {
        ...(signal ? { signal } : {}),
      }),
      target,
    );
  },

  async update(input, options) {
    const schemas = await contractSchemas();
    const body = schemas.acquisition.acquisitionMonitoringUpdateInputSchema.parse(input);
    return monitoringResponse(
      await fetchSameOrigin("/api/acquisitions/monitoring", {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: options.csrfToken,
        },
        method: "PUT",
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      body,
    );
  },
};
