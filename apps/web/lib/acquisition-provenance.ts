import type {
  AcquisitionProvenanceResponse,
  AcquisitionProvenanceSnapshotEvent,
  AcquisitionTargetInput,
} from "@omnifin/contracts/acquisition";

const MAX_ACQUISITION_PROVENANCE_EVENT_CHARACTERS = 384_000;

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

export type AcquisitionProvenanceStreamStatus = "connecting" | "fallback" | "live";

export interface AcquisitionProvenanceStreamCallbacks {
  onSnapshot(event: AcquisitionProvenanceSnapshotEvent): void;
  onStatus(status: AcquisitionProvenanceStreamStatus): void;
}

interface AcquisitionProvenanceEventSource {
  close(): void;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onopen: ((event: Event) => void) | null;
}

type AcquisitionProvenanceEventSourceFactory = (url: string) => AcquisitionProvenanceEventSource;

function targetMatches(provenance: AcquisitionProvenanceResponse, target: AcquisitionTargetInput) {
  return (
    provenance.target.service === target.service &&
    provenance.target.mediaId === target.mediaId &&
    provenance.target.seasonNumber === (target.seasonNumber ?? null)
  );
}

export function watchAcquisitionProvenanceEvents(
  input: AcquisitionTargetInput,
  callbacks: AcquisitionProvenanceStreamCallbacks,
  createEventSource: AcquisitionProvenanceEventSourceFactory = (url) => new EventSource(url),
) {
  let active = true;
  let failedClosed = false;
  let source: AcquisitionProvenanceEventSource | undefined;
  queueMicrotask(() => {
    if (active) callbacks.onStatus("connecting");
  });

  const failClosed = () => {
    if (!active || failedClosed) return;
    failedClosed = true;
    source?.close();
    callbacks.onStatus("fallback");
  };

  void (async () => {
    const schemas = await contractSchemas();
    if (!active) return;
    const parsedTarget = schemas.acquisition.acquisitionTargetInputSchema.safeParse(input);
    if (!parsedTarget.success) {
      failClosed();
      return;
    }
    const target = parsedTarget.data;
    const parameters = new URLSearchParams({
      mediaId: String(target.mediaId),
      service: target.service,
    });
    if (target.seasonNumber !== undefined) {
      parameters.set("seasonNumber", String(target.seasonNumber));
    }
    try {
      source = createEventSource(`/api/acquisitions/provenance/events?${parameters.toString()}`);
    } catch {
      failClosed();
      return;
    }
    source.onopen = () => {
      if (active && !failedClosed) callbacks.onStatus("connecting");
    };
    source.onerror = () => {
      if (active && !failedClosed) callbacks.onStatus("fallback");
    };
    source.onmessage = (message) => {
      void (async () => {
        if (message.data.length > MAX_ACQUISITION_PROVENANCE_EVENT_CHARACTERS) {
          failClosed();
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(message.data);
        } catch {
          failClosed();
          return;
        }
        const currentSchemas = await contractSchemas();
        if (!active || failedClosed) return;
        const parsed =
          currentSchemas.acquisition.acquisitionProvenanceSnapshotEventSchema.safeParse(body);
        if (
          !parsed.success ||
          message.lastEventId !== parsed.data.cursor ||
          !targetMatches(parsed.data.provenance, target)
        ) {
          failClosed();
          return;
        }
        callbacks.onSnapshot(parsed.data);
        callbacks.onStatus("live");
      })();
    };
  })().catch(failClosed);

  return () => {
    if (!active) return;
    active = false;
    source?.close();
  };
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
