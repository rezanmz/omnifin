import type { SessionPrincipal } from "@omnifin/contracts/auth";
import type {
  DownloadQueueActionInput,
  DownloadQueueActionResponse,
  DownloadQueueBulkActionInput,
  DownloadQueueBulkActionResponse,
  DownloadQueuePromotionInput,
  DownloadQueuePromotionResponse,
  DownloadQueueRemovalInput,
  DownloadQueueRemovalResponse,
  DownloadQueueResponse,
  DownloadQueueSnapshotEvent,
} from "@omnifin/contracts/downloads";

const CSRF_HEADER = "x-omnifin-csrf";
const MAX_DOWNLOAD_QUEUE_EVENT_CHARACTERS = 512_000;

interface ResponseSchema<T> {
  safeParse(input: unknown): { data: T; success: true } | { success: false };
}

async function loadContractSchemas() {
  await import("./zod-browser");
  const [auth, downloads, errors] = await Promise.all([
    import("@omnifin/contracts/auth"),
    import("@omnifin/contracts/downloads"),
    import("@omnifin/contracts/errors"),
  ]);
  return { auth, downloads, errors };
}

let contractSchemasPromise: ReturnType<typeof loadContractSchemas> | undefined;

function contractSchemas() {
  contractSchemasPromise ??= loadContractSchemas();
  return contractSchemasPromise;
}

export type DownloadQueueClientErrorKind =
  | "configuration"
  | "forbidden"
  | "invalid_response"
  | "rate_limited"
  | "signed_out"
  | "stale"
  | "unavailable";

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

export interface DownloadQueueEligibilitySnapshot {
  csrfToken: string;
  principal: SessionPrincipal;
}

export type DownloadQueueEligibility =
  | { snapshot: DownloadQueueEligibilitySnapshot; status: "ready" }
  | { status: "forbidden" | "signed_out" | "unavailable" };

export interface DownloadQueueActionOptions {
  csrfToken: string;
  signal?: AbortSignal;
}

export interface DownloadQueueRemovalOptions extends DownloadQueueActionOptions {
  idempotencyKey: string;
}

export type DownloadQueueLiveStatus = "connecting" | "fallback" | "live";

export interface DownloadQueueWatchCallbacks {
  onSnapshot(event: DownloadQueueSnapshotEvent): void;
  onStatus(status: DownloadQueueLiveStatus): void;
}

interface DownloadQueueEventSource {
  close(): void;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onopen: ((event: Event) => void) | null;
}

type DownloadQueueEventSourceFactory = (url: string) => DownloadQueueEventSource;

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

async function actionResponseError(response: Response): Promise<DownloadQueueClientError> {
  const { errors } = await contractSchemas();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = errors.apiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : "request_failed";
  const message = parsed.success
    ? parsed.data.error.message
    : "The download action could not be completed.";
  if (response.status === 401) {
    return new DownloadQueueClientError("signed_out", code, "Your session ended.");
  }
  if (response.status === 403) return new DownloadQueueClientError("forbidden", code, message);
  if (response.status === 409) return new DownloadQueueClientError("stale", code, message);
  if (response.status === 429) return new DownloadQueueClientError("rate_limited", code, message);
  if (code === "download_queue_configuration_unavailable") {
    return new DownloadQueueClientError("configuration", code, message);
  }
  if (response.status === 502) {
    return new DownloadQueueClientError("invalid_response", code, message);
  }
  return new DownloadQueueClientError(
    response.status >= 500 ? "unavailable" : "invalid_response",
    code,
    message,
  );
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
    throw new DownloadQueueClientError(
      "unavailable",
      "service_unavailable",
      "The gateway could not be reached.",
    );
  }
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
  act?(
    input: DownloadQueueActionInput,
    options: DownloadQueueActionOptions,
  ): Promise<DownloadQueueActionResponse>;
  bulkAct?(
    input: DownloadQueueBulkActionInput,
    options: DownloadQueueRemovalOptions,
  ): Promise<DownloadQueueBulkActionResponse>;
  load(signal?: AbortSignal): Promise<DownloadQueueResponse>;
  loadEligibility?(signal?: AbortSignal): Promise<DownloadQueueEligibility>;
  promote?(
    input: DownloadQueuePromotionInput,
    options: DownloadQueueActionOptions,
  ): Promise<DownloadQueuePromotionResponse>;
  remove?(
    input: DownloadQueueRemovalInput,
    options: DownloadQueueRemovalOptions,
  ): Promise<DownloadQueueRemovalResponse>;
  watch?(callbacks: DownloadQueueWatchCallbacks): () => void;
}

export function watchDownloadQueueEvents(
  callbacks: DownloadQueueWatchCallbacks,
  createEventSource: DownloadQueueEventSourceFactory = (url) => new EventSource(url),
) {
  let active = true;
  let failedClosed = false;
  let source: DownloadQueueEventSource;
  callbacks.onStatus("connecting");
  try {
    source = createEventSource("/api/downloads/queue/events");
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
    if (active && !failedClosed) callbacks.onStatus("connecting");
  };
  source.onmessage = (message) => {
    void (async () => {
      let body: unknown;
      if (message.data.length > MAX_DOWNLOAD_QUEUE_EVENT_CHARACTERS) {
        failClosed();
        return;
      }
      try {
        body = JSON.parse(message.data);
      } catch {
        failClosed();
        return;
      }
      const { downloads } = await contractSchemas();
      if (!active || failedClosed) return;
      const parsed = downloads.downloadQueueSnapshotEventSchema.safeParse(body);
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

  async loadEligibility(signal) {
    try {
      const response = await fetchSameOrigin("/api/auth/session", {
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        return response.status === 401 ? { status: "signed_out" } : { status: "unavailable" };
      }
      const { auth } = await contractSchemas();
      const parsed = auth.sessionResponseSchema.safeParse(await safeJson(response));
      if (!parsed.success) return { status: "unavailable" };
      const { csrfToken, principal } = parsed.data;
      if (principal === null || csrfToken === null) return { status: "signed_out" };
      if (
        principal.accountState !== "active" ||
        !principal.userId ||
        !principal.permissions.includes("downloads.manage")
      ) {
        return { status: "forbidden" };
      }
      return { snapshot: { csrfToken, principal }, status: "ready" };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return { status: "unavailable" };
    }
  },

  async act(input, options) {
    const { downloads } = await contractSchemas();
    const body = downloads.downloadQueueActionInputSchema.parse(input);
    const response = await fetchSameOrigin("/api/downloads/queue/actions", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: options.csrfToken,
      },
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await actionResponseError(response);
    const parsed = downloads.downloadQueueActionResponseSchema.safeParse(await safeJson(response));
    if (
      !parsed.success ||
      parsed.data.action !== body.action ||
      parsed.data.item.id !== body.itemId ||
      parsed.data.item.connectorId !== body.connectorId ||
      (!parsed.data.replayed && parsed.data.previousState !== body.expectedState)
    ) {
      throw new DownloadQueueClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned an action response outside the public contract.",
      );
    }
    return parsed.data;
  },

  async bulkAct(input, options) {
    const { downloads } = await contractSchemas();
    const body = downloads.downloadQueueBulkActionInputSchema.parse(input);
    const response = await fetchSameOrigin("/api/downloads/queue/bulk-actions", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey,
        [CSRF_HEADER]: options.csrfToken,
      },
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await actionResponseError(response);
    const parsed = downloads.downloadQueueBulkActionResponseSchema.safeParse(
      await safeJson(response),
    );
    if (
      !parsed.success ||
      parsed.data.action !== body.action ||
      parsed.data.results.length !== body.targets.length ||
      parsed.data.results.some((result, index) => {
        const target = body.targets[index];
        return (
          !target ||
          result.target.connectorId !== target.connectorId ||
          result.target.itemId !== target.itemId ||
          result.target.expectedState !== target.expectedState
        );
      })
    ) {
      throw new DownloadQueueClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned a bulk action response outside the public contract.",
      );
    }
    return parsed.data;
  },

  async remove(input, options) {
    const { downloads } = await contractSchemas();
    const body = downloads.downloadQueueRemovalInputSchema.parse(input);
    const response = await fetchSameOrigin("/api/downloads/queue/removals", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey,
        [CSRF_HEADER]: options.csrfToken,
      },
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await actionResponseError(response);
    const parsed = downloads.downloadQueueRemovalResponseSchema.safeParse(await safeJson(response));
    if (
      !parsed.success ||
      parsed.data.item.id !== body.itemId ||
      parsed.data.item.connectorId !== body.connectorId ||
      parsed.data.item.state !== body.expectedState
    ) {
      throw new DownloadQueueClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned a removal response outside the public contract.",
      );
    }
    return parsed.data;
  },

  async promote(input, options) {
    const { downloads } = await contractSchemas();
    const body = downloads.downloadQueuePromotionInputSchema.parse(input);
    const response = await fetchSameOrigin("/api/downloads/queue/promotions", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: options.csrfToken,
      },
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await actionResponseError(response);
    const parsed = downloads.downloadQueuePromotionResponseSchema.safeParse(
      await safeJson(response),
    );
    if (
      !parsed.success ||
      parsed.data.item.id !== body.itemId ||
      parsed.data.item.connectorId !== body.connectorId
    ) {
      throw new DownloadQueueClientError(
        "invalid_response",
        "invalid_response",
        "The gateway returned a promotion response outside the public contract.",
      );
    }
    return parsed.data;
  },

  watch(callbacks) {
    return watchDownloadQueueEvents(callbacks);
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
