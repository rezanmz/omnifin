import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type { SystemStatusResponse, SystemStatusSnapshotEvent } from "@omnifin/contracts/system";

const MAX_SYSTEM_STATUS_EVENT_CHARACTERS = 512_000;

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, errors, system] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/errors"),
    import("@omnifin/contracts/system"),
  ]);
  return { auth, errors, system };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type SystemStatusClientErrorKind =
  "forbidden" | "invalid_response" | "signed_out" | "unavailable";

export class SystemStatusClientError extends Error {
  public readonly code: string;
  public readonly kind: SystemStatusClientErrorKind;

  public constructor(kind: SystemStatusClientErrorKind, code: string, message: string) {
    super(message);
    this.name = "SystemStatusClientError";
    this.kind = kind;
    this.code = code;
  }
}

export interface SystemStatusSnapshot {
  principal: SessionPrincipal;
  status: SystemStatusResponse;
}

export type SystemStatusLoadOutcome =
  | { snapshot: SystemStatusSnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export type SystemStatusLiveStatus = "connecting" | "fallback" | "live";

export interface SystemStatusWatchCallbacks {
  onSnapshot(event: SystemStatusSnapshotEvent): void;
  onStatus(status: SystemStatusLiveStatus): void;
}

interface SystemStatusEventSource {
  close(): void;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onopen: ((event: Event) => void) | null;
}

type SystemStatusEventSourceFactory = (url: string) => SystemStatusEventSource;

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SystemStatusClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned unreadable system telemetry.",
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
    throw new SystemStatusClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached.",
    );
  }
}

async function responseError(response: Response) {
  if (response.status === 401) {
    return new SystemStatusClientError(
      "signed_out",
      "authentication_required",
      "Sign in to inspect system telemetry.",
    );
  }
  if (response.status === 403) {
    return new SystemStatusClientError(
      "forbidden",
      "permission_denied",
      "Operator access is required for system telemetry.",
    );
  }
  const { errors } = await contractSchemas();
  const parsed = errors.apiErrorSchema.safeParse(await safeJson(response));
  return new SystemStatusClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    parsed.success ? parsed.data.error.code : "request_failed",
    parsed.success ? parsed.data.error.message : "System telemetry could not be loaded.",
  );
}

async function parsedResponse<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const parsed = schema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new SystemStatusClientError(
      "invalid_response",
      "invalid_response",
      "The gateway returned system telemetry outside the public contract.",
    );
  }
  return parsed.data;
}

export async function loadSystemStatus(signal?: AbortSignal): Promise<SystemStatusLoadOutcome> {
  try {
    const sessionResponse = await fetchSameOrigin("/api/auth/session", {
      ...(signal ? { signal } : {}),
    });
    if (!sessionResponse.ok) {
      return sessionResponse.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
    }
    const schemas = await contractSchemas();
    const session = schemas.auth.sessionResponseSchema.safeParse(await safeJson(sessionResponse));
    if (!session.success || session.data.principal === null) return { status: "signed_out" };
    if (!session.data.principal.permissions.includes("acquisition.manage")) {
      return { status: "forbidden" };
    }
    const status = await parsedResponse(
      await fetchSameOrigin("/api/system/status", { ...(signal ? { signal } : {}) }),
      schemas.system.systemStatusResponseSchema,
    );
    return { snapshot: { principal: session.data.principal, status }, status: "ready" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof SystemStatusClientError) {
      if (error.kind === "forbidden" || error.kind === "signed_out") {
        return { status: error.kind };
      }
    }
    return { status: "unavailable" };
  }
}

export interface SystemStatusClient {
  load(signal?: AbortSignal): Promise<SystemStatusLoadOutcome>;
  watch?(callbacks: SystemStatusWatchCallbacks): () => void;
}

export function watchSystemStatusEvents(
  callbacks: SystemStatusWatchCallbacks,
  createEventSource: SystemStatusEventSourceFactory = (url) => new EventSource(url),
) {
  let active = true;
  let failedClosed = false;
  let source: SystemStatusEventSource;
  callbacks.onStatus("connecting");
  try {
    source = createEventSource("/api/system/status/events");
  } catch {
    callbacks.onStatus("fallback");
    return () => {
      active = false;
    };
  }

  const failClosed = () => {
    if (!active || failedClosed) return;
    failedClosed = true;
    source.close();
    callbacks.onStatus("fallback");
  };
  source.onopen = () => {
    if (active && !failedClosed) callbacks.onStatus("connecting");
  };
  source.onerror = () => {
    if (active && !failedClosed) callbacks.onStatus("fallback");
  };
  source.onmessage = (message) => {
    void (async () => {
      if (message.data.length > MAX_SYSTEM_STATUS_EVENT_CHARACTERS) {
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
      const { system } = await contractSchemas();
      if (!active || failedClosed) return;
      const parsed = system.systemStatusSnapshotEventSchema.safeParse(body);
      if (!parsed.success || message.lastEventId !== parsed.data.cursor) {
        failClosed();
        return;
      }
      callbacks.onSnapshot(parsed.data);
      callbacks.onStatus("live");
    })();
  };

  return () => {
    if (!active) return;
    active = false;
    source.close();
  };
}

export const systemStatusClient: SystemStatusClient = {
  load: loadSystemStatus,
  watch: watchSystemStatusEvents,
};
