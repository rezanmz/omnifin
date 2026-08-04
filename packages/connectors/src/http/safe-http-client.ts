import type {
  ConnectorFailureCode,
  ConnectorService,
  ConnectorTlsPolicy,
  PartialFailure,
} from "@omnifin/contracts/connectors";
import { MAX_RETRY_AFTER_SECONDS } from "@omnifin/contracts/connectors";
import type { ZodType } from "zod";

import type { ConnectorTransport } from "../types.js";
import {
  DestinationPolicyError,
  resolveDestinationUrl,
  type HostResolver,
  type ResolvedDestination,
} from "../security/destination.js";
import { pinnedNodeTransport } from "./pinned-transport.js";

export interface SafeHttpClientOptions {
  service: ConnectorService;
  baseUrl: string;
  allowInsecureHttp?: boolean;
  tlsPolicy?: ConnectorTlsPolicy;
  tlsCaCertificatePem?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  headers?: Readonly<Record<string, string>>;
  transport?: ConnectorTransport;
  resolveHost?: HostResolver;
}

export interface SafeRequestOptions {
  operation: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  query?: URLSearchParams | Readonly<Record<string, string>>;
  body?: string | URLSearchParams | Uint8Array;
  signal?: AbortSignal;
  acceptedStatuses?: readonly number[];
}

export interface SafeTextResponse {
  status: number;
  body: string;
  headers: Headers;
}

export interface SafeBytesResponse {
  status: number;
  body: Uint8Array;
  headers: Headers;
}

export interface SafeStreamResponse {
  status: number;
  body: ReadableStream<Uint8Array>;
  headers: Headers;
}

const MAX_STREAM_RESPONSE_BYTES = 128 * 1_024 * 1_024 * 1_024 * 1_024;

interface RequestLifecycle {
  controller: AbortController;
  armTimeout: () => void;
  clearTimeout: () => void;
  cleanup: () => void;
  didTimeout: () => boolean;
}

export class SafeConnectorError extends Error {
  readonly service: ConnectorService;
  readonly operation: string;
  readonly code: ConnectorFailureCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: {
    service: ConnectorService;
    operation: string;
    code: ConnectorFailureCode;
    message: string;
    retryable: boolean;
    status?: number;
    retryAfterSeconds?: number;
  }) {
    super(options.message);
    this.name = "SafeConnectorError";
    this.service = options.service;
    this.operation = options.operation;
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toPartialFailure(occurredAt: Date): PartialFailure {
    return {
      service: this.service,
      operation: this.operation,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      occurredAt: occurredAt.toISOString(),
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds)
      ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
      : MAX_RETRY_AFTER_SECONDS;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil((date - Date.now()) / 1_000)));
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
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

function encodeBody(body: SafeRequestOptions["body"]): Uint8Array | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  return body;
}

function hasTraversalSegment(path: string): boolean {
  return path.split("/").some((rawSegment) => {
    let segment = rawSegment;
    try {
      for (let pass = 0; pass < 2; pass += 1) segment = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\");
  });
}

const UNSAFE_REQUEST_PATH_CHARACTER = /[\p{Cc}\p{Cf}\p{White_Space}]/u;

function unsafeRequestPath(service: ConnectorService, operation: string): SafeConnectorError {
  return new SafeConnectorError({
    service,
    operation,
    code: "destination_blocked",
    message: "The connector request path is not a safe relative path.",
    retryable: false,
  });
}

const BLOCKED_REQUEST_HEADERS = [
  "connection",
  "host",
  "proxy-connection",
  "te",
  "transfer-encoding",
  "upgrade",
] as const;

function safeStatusError(
  service: ConnectorService,
  operation: string,
  response: Response,
): SafeConnectorError {
  const retryAfterSeconds =
    response.status === 429 || response.status === 503
      ? parseRetryAfter(response.headers.get("retry-after"))
      : undefined;
  if (response.status === 401 || response.status === 403) {
    return new SafeConnectorError({
      service,
      operation,
      code: "invalid_credentials",
      message: `${service} rejected the configured credentials.`,
      retryable: false,
      status: response.status,
    });
  }
  if (response.status === 429) {
    return new SafeConnectorError({
      service,
      operation,
      code: "rate_limited",
      message: `${service} is rate limiting connector requests.`,
      retryable: true,
      status: response.status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  return new SafeConnectorError({
    service,
    operation,
    code: "upstream_error",
    message: `${service} returned an unsuccessful response.`,
    retryable: isRetryableStatus(response.status),
    status: response.status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

function requestLifecycle(timeoutMs: number, signal: AbortSignal | undefined): RequestLifecycle {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanedUp = false;
  const clearRequestTimeout = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
  const armTimeout = () => {
    clearRequestTimeout();
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signal?.aborted) abortFromCaller();
  return {
    armTimeout,
    clearTimeout: clearRequestTimeout,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearRequestTimeout();
      signal?.removeEventListener("abort", abortFromCaller);
    },
    controller,
    didTimeout: () => timedOut,
  };
}

export class SafeHttpClient {
  readonly service: ConnectorService;
  readonly origin: string;

  readonly #baseUrl: URL;
  readonly #allowInsecureHttp: boolean;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #tlsPolicy: ConnectorTlsPolicy;
  readonly #tlsCaCertificatePem: string | undefined;
  readonly #transport: ConnectorTransport;
  readonly #resolveHost: HostResolver | undefined;

  constructor(options: SafeHttpClientOptions) {
    const timeoutMs = options.timeoutMs ?? 8_000;
    const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new SafeConnectorError({
        service: options.service,
        operation: "configuration",
        code: "configuration_invalid",
        message: "The connector timeout must be between 1 ms and 120 seconds.",
        retryable: false,
      });
    }
    if (
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 10_485_760
    ) {
      throw new SafeConnectorError({
        service: options.service,
        operation: "configuration",
        code: "configuration_invalid",
        message: "The connector response limit must be between 1 byte and 10 MiB.",
        retryable: false,
      });
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new SafeConnectorError({
        service: options.service,
        operation: "configuration",
        code: "destination_blocked",
        message: "The connector destination is not a valid URL.",
        retryable: false,
      });
    }
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
    baseUrl.search = "";
    baseUrl.hash = "";
    const tlsPolicy = options.tlsPolicy ?? "strict";
    if (tlsPolicy === "allow_self_signed" && baseUrl.protocol !== "https:") {
      throw new SafeConnectorError({
        service: options.service,
        operation: "configuration",
        code: "configuration_invalid",
        message: "A relaxed TLS policy requires an HTTPS connector destination.",
        retryable: false,
      });
    }
    if (tlsPolicy === "allow_self_signed" && options.tlsCaCertificatePem === undefined) {
      throw new SafeConnectorError({
        service: options.service,
        operation: "configuration",
        code: "configuration_invalid",
        message: "Self-signed TLS requires a connector-specific CA certificate.",
        retryable: false,
      });
    }
    if (tlsPolicy === "strict" && options.tlsCaCertificatePem !== undefined) {
      throw new SafeConnectorError({
        service: options.service,
        operation: "configuration",
        code: "configuration_invalid",
        message: "A connector-specific CA is valid only with self-signed TLS approval.",
        retryable: false,
      });
    }

    this.service = options.service;
    this.origin = baseUrl.origin;
    this.#baseUrl = baseUrl;
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#headers = options.headers ?? {};
    this.#tlsPolicy = tlsPolicy;
    this.#tlsCaCertificatePem = options.tlsCaCertificatePem;
    this.#transport = options.transport ?? pinnedNodeTransport;
    this.#resolveHost = options.resolveHost;
  }

  async requestJson<T>(path: string, schema: ZodType<T>, options: SafeRequestOptions): Promise<T> {
    const response = await this.requestText(path, options);
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw this.invalidResponse(options.operation);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw this.invalidResponse(options.operation);
    return parsed.data;
  }

  async requestText(path: string, options: SafeRequestOptions): Promise<SafeTextResponse> {
    const response = await this.requestBytes(path, options);
    return {
      body: Buffer.from(response.body).toString("utf8"),
      headers: response.headers,
      status: response.status,
    };
  }

  async requestBytes(path: string, options: SafeRequestOptions): Promise<SafeBytesResponse> {
    const lifecycle = requestLifecycle(this.#timeoutMs, options.signal);
    lifecycle.armTimeout();
    try {
      const response = await this.#requestResponse(path, options, lifecycle.controller.signal);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.#maxResponseBytes) {
        await response.body?.cancel();
        throw this.invalidResponse(options.operation);
      }
      const responseBody = await this.readBoundedBody(response, options.operation);

      return { status: response.status, body: responseBody, headers: response.headers };
    } catch (error) {
      throw this.#requestError(error, lifecycle.didTimeout(), options.operation);
    } finally {
      lifecycle.cleanup();
    }
  }

  async requestStream(
    path: string,
    options: SafeRequestOptions,
    maxResponseBytes: number,
  ): Promise<SafeStreamResponse> {
    if (
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_STREAM_RESPONSE_BYTES
    ) {
      throw new SafeConnectorError({
        service: this.service,
        operation: options.operation,
        code: "configuration_invalid",
        message: "The connector stream limit must be between 1 byte and 128 TiB.",
        retryable: false,
      });
    }

    const lifecycle = requestLifecycle(this.#timeoutMs, options.signal);
    lifecycle.armTimeout();
    try {
      const response = await this.#requestResponse(path, options, lifecycle.controller.signal);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        await response.body?.cancel();
        throw this.invalidResponse(options.operation);
      }
      lifecycle.clearTimeout();
      if (!response.body) {
        lifecycle.cleanup();
        return {
          body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
          headers: response.headers,
          status: response.status,
        };
      }
      return {
        body: this.#boundedStream(response.body, options.operation, maxResponseBytes, lifecycle),
        headers: response.headers,
        status: response.status,
      };
    } catch (error) {
      lifecycle.cleanup();
      throw this.#requestError(error, lifecycle.didTimeout(), options.operation);
    }
  }

  async #requestResponse(path: string, options: SafeRequestOptions, signal: AbortSignal) {
    if (
      !path ||
      UNSAFE_REQUEST_PATH_CHARACTER.test(path) ||
      path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("?") ||
      path.includes("#") ||
      hasTraversalSegment(path) ||
      /^[a-z][a-z\d+.-]*:/i.test(path)
    ) {
      throw unsafeRequestPath(this.service, options.operation);
    }

    let url: URL;
    try {
      url = new URL(path, this.#baseUrl);
    } catch {
      throw unsafeRequestPath(this.service, options.operation);
    }
    if (url.origin !== this.#baseUrl.origin || !url.pathname.startsWith(this.#baseUrl.pathname)) {
      throw unsafeRequestPath(this.service, options.operation);
    }
    if (options.query) {
      const query =
        options.query instanceof URLSearchParams
          ? options.query
          : new URLSearchParams(options.query);
      url.search = query.toString().replaceAll("+", "%20");
    }

    let destination: ResolvedDestination;
    try {
      destination = await abortable(
        resolveDestinationUrl(url, {
          allowInsecureHttp: this.#allowInsecureHttp,
          allowedHosts: [this.#baseUrl.hostname],
          ...(this.#resolveHost ? { resolveHost: this.#resolveHost } : {}),
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof DestinationPolicyError) {
        throw new SafeConnectorError({
          service: this.service,
          operation: options.operation,
          code: "destination_blocked",
          message: error.message,
          retryable: false,
        });
      }
      throw error;
    }

    const headers = new Headers({ ...this.#headers, ...options.headers });
    const blockedHeader = BLOCKED_REQUEST_HEADERS.find((header) => headers.has(header));
    if (blockedHeader) {
      throw new SafeConnectorError({
        service: this.service,
        operation: options.operation,
        code: "configuration_invalid",
        message: `Connector requests cannot override the ${blockedHeader} header.`,
        retryable: false,
      });
    }
    const body = encodeBody(options.body);
    headers.delete("content-length");
    if (body) headers.set("content-length", String(body.byteLength));
    const response = await this.#transport(
      destination.url,
      {
        method: options.method ?? "GET",
        headers,
        tlsPolicy: this.#tlsPolicy,
        ...(this.#tlsCaCertificatePem === undefined
          ? {}
          : { tlsCaCertificatePem: this.#tlsCaCertificatePem }),
        ...(body === undefined ? {} : { body }),
        signal,
      },
      destination.addresses,
    );

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SafeConnectorError({
        service: this.service,
        operation: options.operation,
        code: "destination_blocked",
        message: `${this.service} attempted a redirect, which connector policy blocks.`,
        retryable: false,
        status: response.status,
      });
    }

    const acceptedStatuses = options.acceptedStatuses ?? [];
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      await response.body?.cancel();
      throw safeStatusError(this.service, options.operation, response);
    }
    return response;
  }

  #boundedStream(
    body: ReadableStream<Uint8Array>,
    operation: string,
    maxResponseBytes: number,
    lifecycle: RequestLifecycle,
  ) {
    const reader = body.getReader();
    let totalBytes = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      lifecycle.cleanup();
      reader.releaseLock();
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        lifecycle.armTimeout();
        try {
          const result = await reader.read();
          lifecycle.clearTimeout();
          if (result.done) {
            finish();
            controller.close();
            return;
          }
          totalBytes += result.value.byteLength;
          if (totalBytes > maxResponseBytes) {
            lifecycle.controller.abort();
            try {
              await reader.cancel();
            } catch {
              // The byte-limit failure below is the stable, redaction-safe error for callers.
            } finally {
              finish();
            }
            controller.error(this.invalidResponse(operation));
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          finish();
          controller.error(this.#requestError(error, lifecycle.didTimeout(), operation));
        }
      },
      cancel: async (reason) => {
        lifecycle.controller.abort(reason);
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
  }

  #requestError(error: unknown, timedOut: boolean, operation: string) {
    if (error instanceof SafeConnectorError) return error;
    return new SafeConnectorError({
      service: this.service,
      operation,
      code: timedOut ? "timeout" : "unreachable",
      message: timedOut
        ? `${this.service} did not respond before the deadline.`
        : `${this.service} could not be reached.`,
      retryable: true,
    });
  }

  private async readBoundedBody(response: Response, operation: string): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        totalBytes += result.value.byteLength;
        if (totalBytes > this.#maxResponseBytes) {
          await reader.cancel();
          throw this.invalidResponse(operation);
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }

    return new Uint8Array(Buffer.concat(chunks, totalBytes));
  }

  invalidResponse(operation: string): SafeConnectorError {
    return new SafeConnectorError({
      service: this.service,
      operation,
      code: "response_invalid",
      message: `${this.service} returned a response Omnifin could not safely interpret.`,
      retryable: false,
    });
  }
}
