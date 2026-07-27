import { pinnedNodeTransport } from "@omnifin/connectors/http/pinned-transport";
import {
  DestinationPolicyError,
  resolveDestinationUrl,
  validateDestinationUrlLiteral,
  type HostResolver,
} from "@omnifin/connectors/security/destination";
import type { ConnectorTransport } from "@omnifin/connectors/types";
import type { CustomFetch, CustomFetchOptions, FetchBody } from "openid-client";

export const OIDC_REQUEST_TIMEOUT_MS = 8_000;
export const OIDC_MAX_REQUEST_BYTES = 65_536;
export const OIDC_MAX_RESPONSE_BYTES = 1_048_576;
export const OIDC_MAX_APPROVED_ORIGINS = 16;
export const OIDC_MAX_URL_LENGTH = 4_096;

const OIDC_MAX_HEADER_BYTES = 16_384;

const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "dpop",
  "user-agent",
]);

export type OidcSafeFetchErrorCode =
  | "oidc_destination_blocked"
  | "oidc_request_aborted"
  | "oidc_request_rejected"
  | "oidc_request_too_large"
  | "oidc_response_too_large"
  | "oidc_timeout"
  | "oidc_unreachable";

const ERROR_MESSAGES: Readonly<Record<OidcSafeFetchErrorCode, string>> = {
  oidc_destination_blocked: "The identity provider destination is not permitted.",
  oidc_request_aborted: "The identity provider request was cancelled.",
  oidc_request_rejected: "The identity provider request was rejected.",
  oidc_request_too_large: "The identity provider request exceeded the permitted size.",
  oidc_response_too_large: "The identity provider response exceeded the permitted size.",
  oidc_timeout: "The identity provider did not respond before the deadline.",
  oidc_unreachable: "The identity provider could not be reached.",
};

/**
 * An intentionally context-free error. It never retains the failed URL, headers,
 * request body, response body, caller abort reason, or the underlying error.
 */
export class OidcSafeFetchError extends Error {
  readonly code: OidcSafeFetchErrorCode;
  readonly retryable: boolean;

  constructor(code: OidcSafeFetchErrorCode, retryable = false) {
    super(ERROR_MESSAGES[code]);
    this.name = "OidcSafeFetchError";
    this.code = code;
    this.retryable = retryable;
    Object.freeze(this);
  }
}

export interface OidcSafeFetchOptions {
  /**
   * Exact HTTPS origins approved by an administrator. Every discovery, token,
   * and JWKS origin must be listed separately, including any non-default port.
   */
  approvedOrigins: readonly string[];
  /** Deterministic test seam; production uses the DNS-pinned Node transport. */
  transport?: ConnectorTransport;
  /** Deterministic test seam; production uses the system DNS resolver. */
  resolveHost?: HostResolver;
}

function safeFetchError(code: OidcSafeFetchErrorCode, retryable = false): OidcSafeFetchError {
  return new OidcSafeFetchError(code, retryable);
}

function parseApprovedOrigins(values: readonly string[]): {
  origins: ReadonlySet<string>;
  hosts: readonly string[];
} {
  if (!Array.isArray(values) || values.length === 0 || values.length > OIDC_MAX_APPROVED_ORIGINS) {
    throw safeFetchError("oidc_destination_blocked");
  }

  const origins = new Set<string>();
  const hosts = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > OIDC_MAX_URL_LENGTH) {
      throw safeFetchError("oidc_destination_blocked");
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw safeFetchError("oidc_destination_blocked");
    }

    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw safeFetchError("oidc_destination_blocked");
    }

    try {
      validateDestinationUrlLiteral(url, { allowedHosts: [url.hostname] });
    } catch {
      throw safeFetchError("oidc_destination_blocked");
    }

    origins.add(url.origin);
    hosts.add(url.hostname);
  }

  return { origins, hosts: [...hosts] };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(safeFetchError("oidc_request_aborted"));

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(safeFetchError("oidc_request_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function enforceRequestSize(size: number): void {
  if (size > OIDC_MAX_REQUEST_BYTES) throw safeFetchError("oidc_request_too_large");
}

function cancelReader(reader: ReadableStreamDefaultReader<unknown>): void {
  void reader.cancel().catch(() => {
    // Cancellation is best-effort and its error may contain private transport context.
  });
}

async function encodeStreamBody(body: ReadableStream, signal: AbortSignal): Promise<Uint8Array> {
  const reader = body.getReader() as ReadableStreamDefaultReader<unknown>;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw safeFetchError("oidc_request_rejected");
      }
      totalBytes += result.value.byteLength;
      enforceRequestSize(totalBytes);
      chunks.push(result.value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

async function encodeRequestBody(
  body: FetchBody,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;

  if (typeof body === "string") {
    enforceRequestSize(byteLength(body));
    return Buffer.from(body, "utf8");
  }

  if (body instanceof URLSearchParams) {
    const encoded = body.toString();
    enforceRequestSize(byteLength(encoded));
    return Buffer.from(encoded, "utf8");
  }

  if (body instanceof Uint8Array) {
    enforceRequestSize(body.byteLength);
    return body.slice();
  }

  if (body instanceof ArrayBuffer) {
    enforceRequestSize(body.byteLength);
    return new Uint8Array(body.slice(0));
  }

  if (body instanceof ReadableStream) return encodeStreamBody(body, signal);

  throw safeFetchError("oidc_request_rejected");
}

function createRequestHeaders(input: Record<string, string>): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input);
  } catch {
    throw safeFetchError("oidc_request_rejected");
  }

  let totalBytes = 0;
  for (const [name, value] of headers) {
    if (!ALLOWED_REQUEST_HEADERS.has(name)) {
      throw safeFetchError("oidc_request_rejected");
    }
    totalBytes += byteLength(name) + byteLength(value);
    if (totalBytes > OIDC_MAX_HEADER_BYTES) {
      throw safeFetchError("oidc_request_rejected");
    }
  }

  return headers;
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {
    // Cancellation is best-effort and its error may contain private transport context.
  });
}

async function readBoundedResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > OIDC_MAX_RESPONSE_BYTES) {
        cancelReader(reader);
        throw safeFetchError("oidc_response_too_large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

function contentLengthExceedsLimit(headers: Headers): boolean {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return false;
  const length = Number(value);
  return !Number.isSafeInteger(length) || length > OIDC_MAX_RESPONSE_BYTES;
}

function boundedResponse(response: Response, body: Uint8Array | null): Response {
  const cannotHaveBody = [204, 205, 304].includes(response.status);
  const responseBody = body === null ? null : Uint8Array.from(body).buffer;
  return new Response(cannotHaveBody ? null : responseBody, {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * Creates an openid-client customFetch implementation that performs fresh DNS
 * validation and then connects only to the validated addresses. It never calls
 * global fetch and never follows redirects.
 */
export function createOidcSafeFetch(options: OidcSafeFetchOptions): CustomFetch {
  const { origins, hosts } = parseApprovedOrigins(options.approvedOrigins);
  const transport = options.transport ?? pinnedNodeTransport;

  return async (input: string, requestOptions: CustomFetchOptions): Promise<Response> => {
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, OIDC_REQUEST_TIMEOUT_MS);
    timeout.unref();

    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort();
    };
    requestOptions.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (requestOptions.signal?.aborted) abortFromCaller();

    try {
      if (controller.signal.aborted) throw safeFetchError("oidc_request_aborted");
      if (requestOptions.method !== "GET" && requestOptions.method !== "POST") {
        throw safeFetchError("oidc_request_rejected");
      }
      if (requestOptions.redirect !== "manual") {
        throw safeFetchError("oidc_request_rejected");
      }

      let url: URL;
      if (typeof input !== "string" || input.length === 0 || input.length > OIDC_MAX_URL_LENGTH) {
        throw safeFetchError("oidc_destination_blocked");
      }
      try {
        url = new URL(input);
      } catch {
        throw safeFetchError("oidc_destination_blocked");
      }
      if (!origins.has(url.origin)) throw safeFetchError("oidc_destination_blocked");

      const headers = createRequestHeaders(requestOptions.headers);
      const body = await encodeRequestBody(requestOptions.body, controller.signal);
      if (requestOptions.method === "GET" && body !== undefined) {
        throw safeFetchError("oidc_request_rejected");
      }
      headers.delete("content-length");
      if (body !== undefined) headers.set("content-length", String(body.byteLength));

      let destination;
      try {
        destination = await abortable(
          resolveDestinationUrl(url, {
            allowedHosts: hosts,
            ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
          }),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof OidcSafeFetchError) throw error;
        if (error instanceof DestinationPolicyError) {
          throw error.code === "destination_unresolved"
            ? safeFetchError("oidc_unreachable", true)
            : safeFetchError("oidc_destination_blocked");
        }
        throw safeFetchError("oidc_destination_blocked");
      }

      const response = await abortable(
        transport(
          destination.url,
          {
            method: requestOptions.method,
            headers,
            ...(body === undefined ? {} : { body }),
            signal: controller.signal,
            tlsPolicy: "strict",
          },
          destination.addresses,
        ),
        controller.signal,
      );

      if (response.status >= 300 && response.status < 400) {
        cancelResponseBody(response);
        throw safeFetchError("oidc_destination_blocked");
      }
      if (contentLengthExceedsLimit(response.headers)) {
        cancelResponseBody(response);
        throw safeFetchError("oidc_response_too_large");
      }

      const responseBody = await readBoundedResponseBody(response, controller.signal);
      return boundedResponse(response, responseBody);
    } catch (error) {
      if (timedOut) throw safeFetchError("oidc_timeout", true);
      if (callerAborted) throw safeFetchError("oidc_request_aborted");
      if (error instanceof OidcSafeFetchError) throw error;
      throw safeFetchError("oidc_unreachable", true);
    } finally {
      clearTimeout(timeout);
      requestOptions.signal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
