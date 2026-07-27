import type { ResolvedHostAddress } from "@omnifin/connectors/security/destination";
import type { ConnectorTransport, ConnectorTransportInit } from "@omnifin/connectors/types";
import type { CustomFetch, CustomFetchOptions, FetchBody } from "openid-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOidcSafeFetch,
  OIDC_MAX_APPROVED_ORIGINS,
  OIDC_MAX_REQUEST_BYTES,
  OIDC_MAX_RESPONSE_BYTES,
  OIDC_MAX_URL_LENGTH,
  OIDC_REQUEST_TIMEOUT_MS,
  OidcSafeFetchError,
  type OidcSafeFetchOptions,
} from "../src/auth/oidc/safe-fetch.js";

interface CapturedRequest {
  url: URL;
  init: ConnectorTransportInit;
  pinnedAddresses: readonly ResolvedHostAddress[];
}

const PUBLIC_ADDRESSES = [
  { address: "1.1.1.1", family: 4 as const },
  { address: "2606:4700:4700::1111", family: 6 as const },
];

function requestOptions(overrides: Partial<CustomFetchOptions> = {}): CustomFetchOptions {
  return {
    body: undefined,
    headers: { accept: "application/json" },
    method: "GET",
    redirect: "manual",
    ...overrides,
  };
}

function queuedTransport(responses: readonly Response[]): {
  requests: CapturedRequest[];
  transport: ConnectorTransport;
} {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  const transport: ConnectorTransport = async (url, init, pinnedAddresses) => {
    requests.push({ url: new URL(url), init, pinnedAddresses });
    const response = queue.shift();
    if (!response) throw new Error("The test transport had no response.");
    return response;
  };
  return { requests, transport };
}

function publicResolver() {
  return vi.fn(async () => PUBLIC_ADDRESSES);
}

function configuredFetch(
  transport: ConnectorTransport,
  overrides: Partial<OidcSafeFetchOptions> = {},
): { fetch: CustomFetch; resolveHost: ReturnType<typeof publicResolver> } {
  const resolveHost = publicResolver();
  return {
    fetch: createOidcSafeFetch({
      approvedOrigins: ["https://identity.example.test"],
      resolveHost,
      transport,
      ...overrides,
    }),
    resolveHost,
  };
}

async function capturedFailure(promise: Promise<unknown>): Promise<OidcSafeFetchError> {
  try {
    await promise;
    throw new Error("Expected the request to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(OidcSafeFetchError);
    return error as OidcSafeFetchError;
  }
}

function expectNoPrivateContext(error: OidcSafeFetchError, values: readonly string[]): void {
  const visible = `${String(error)} ${JSON.stringify(error)} ${error.stack ?? ""}`;
  for (const value of values) expect(visible).not.toContain(value);
  expect(error.cause).toBeUndefined();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OIDC DNS-pinned custom fetch", () => {
  it.each([
    { approvedOrigins: [] },
    { approvedOrigins: ["http://identity.example.test"] },
    { approvedOrigins: ["https://identity.example.test/application/o/omnifin/"] },
    { approvedOrigins: ["https://identity.example.test/?tenant=private"] },
    { approvedOrigins: ["https://identity.example.test/#private"] },
    { approvedOrigins: ["https://client:private@identity.example.test"] },
    { approvedOrigins: ["https://localhost"] },
    { approvedOrigins: ["https://metadata.google.internal"] },
    { approvedOrigins: ["https://127.0.0.1"] },
  ])(
    "rejects a non-origin, insecure, or locally blocked approval: $approvedOrigins",
    ({ approvedOrigins }) => {
      let error: unknown;
      try {
        createOidcSafeFetch({ approvedOrigins });
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({ code: "oidc_destination_blocked", retryable: false });
      expectNoPrivateContext(error as OidcSafeFetchError, [
        "tenant=private",
        "client:private",
        "application/o/omnifin",
      ]);
    },
  );

  it("performs discovery through the freshly resolved and pinned addresses", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const mock = queuedTransport([
      new Response(JSON.stringify({ issuer: "https://identity.example.test" }), {
        headers: { "cache-control": "max-age=60", "content-type": "application/json" },
      }),
    ]);
    const { fetch, resolveHost } = configuredFetch(mock.transport);

    const response = await fetch(
      "https://identity.example.test/.well-known/openid-configuration",
      requestOptions({
        headers: {
          accept: "application/json",
          "user-agent": "openid-client/6",
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      issuer: "https://identity.example.test",
    });
    expect(response.headers.get("cache-control")).toBe("max-age=60");
    expect(resolveHost).toHaveBeenCalledExactlyOnceWith("identity.example.test");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({ pinnedAddresses: PUBLIC_ADDRESSES });
    expect(mock.requests[0]?.url.href).toBe(
      "https://identity.example.test/.well-known/openid-configuration",
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("bounds the approved-origin list and each configured or requested URL", async () => {
    const tooManyOrigins = Array.from(
      { length: OIDC_MAX_APPROVED_ORIGINS + 1 },
      (_, index) => `https://identity-${index}.example.test`,
    );
    expect(() => createOidcSafeFetch({ approvedOrigins: tooManyOrigins })).toThrowError(
      expect.objectContaining({ code: "oidc_destination_blocked" }),
    );
    expect(() =>
      createOidcSafeFetch({
        approvedOrigins: [`https://${"a".repeat(OIDC_MAX_URL_LENGTH)}.example.test`],
      }),
    ).toThrowError(expect.objectContaining({ code: "oidc_destination_blocked" }));

    const mock = queuedTransport([]);
    const { fetch, resolveHost } = configuredFetch(mock.transport);
    await expect(
      fetch(
        `https://identity.example.test/jwks?value=${"a".repeat(OIDC_MAX_URL_LENGTH)}`,
        requestOptions(),
      ),
    ).rejects.toMatchObject({ code: "oidc_destination_blocked" });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(0);
  });

  it("permits only the request headers needed for OIDC token and key operations", async () => {
    const mock = queuedTransport([new Response('{"access_token":"private"}')]);
    const { fetch } = configuredFetch(mock.transport);
    const body = new URLSearchParams({
      client_id: "omnifin",
      client_secret: "private-client-secret",
      code: "private-authorization-code",
    });

    const response = await fetch(
      "https://identity.example.test/application/o/token/",
      requestOptions({
        body,
        headers: {
          accept: "application/json",
          authorization: "Basic private-client-credentials",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          dpop: "private-proof",
          "user-agent": "openid-client/6",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(mock.requests[0]?.init.body?.toString()).toBe(body.toString());
    expect(mock.requests[0]?.init.headers.get("content-length")).toBe(
      String(Buffer.byteLength(body.toString())),
    );
    expect(mock.requests[0]?.init.headers.get("authorization")).toBe(
      "Basic private-client-credentials",
    );
  });

  it.each([
    "host",
    "cookie",
    "connection",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-forwarded-host",
    "x-unneeded-header",
  ])("rejects the %s request header before DNS or transport", async (header) => {
    const mock = queuedTransport([]);
    const { fetch, resolveHost } = configuredFetch(mock.transport);

    await expect(
      fetch(
        "https://identity.example.test/.well-known/openid-configuration",
        requestOptions({ headers: { [header]: "private-header-value" } }),
      ),
    ).rejects.toMatchObject({ code: "oidc_request_rejected" });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects malformed or oversized headers without echoing their values", async () => {
    const mock = queuedTransport([]);
    const { fetch } = configuredFetch(mock.transport);

    const malformed = await capturedFailure(
      fetch(
        "https://identity.example.test/.well-known/openid-configuration",
        requestOptions({ headers: { accept: "application/json\r\nprivate-value" } }),
      ),
    );
    const oversized = await capturedFailure(
      fetch(
        "https://identity.example.test/.well-known/openid-configuration",
        requestOptions({ headers: { authorization: `Basic ${"s".repeat(16_385)}` } }),
      ),
    );

    expect(malformed.code).toBe("oidc_request_rejected");
    expect(oversized.code).toBe("oidc_request_rejected");
    expectNoPrivateContext(malformed, ["private-value"]);
  });

  it("requires GET or POST, manual redirects, and bodyless GET requests", async () => {
    const mock = queuedTransport([]);
    const { fetch, resolveHost } = configuredFetch(mock.transport);
    const url = "https://identity.example.test/.well-known/openid-configuration";

    await expect(fetch(url, requestOptions({ method: "DELETE" }))).rejects.toMatchObject({
      code: "oidc_request_rejected",
    });
    await expect(
      fetch(url, requestOptions({ redirect: "follow" as "manual" })),
    ).rejects.toMatchObject({ code: "oidc_request_rejected" });
    await expect(fetch(url, requestOptions({ body: "private-body" }))).rejects.toMatchObject({
      code: "oidc_request_rejected",
    });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(0);
  });

  it("allows each cross-origin endpoint only after exact administrator approval", async () => {
    const mock = queuedTransport([new Response("{}"), new Response("{}")]);
    const fetch = createOidcSafeFetch({
      approvedOrigins: ["https://identity.example.test", "https://tokens.example.test:8443"],
      resolveHost: async () => PUBLIC_ADDRESSES,
      transport: mock.transport,
    });

    await fetch("https://identity.example.test/.well-known/openid-configuration", requestOptions());
    await fetch(
      "https://tokens.example.test:8443/oauth/token",
      requestOptions({ body: "grant_type=authorization_code", method: "POST" }),
    );

    for (const url of [
      "https://tokens.example.test/oauth/token",
      "https://identity.example.test:8443/oauth/token",
      "https://keys.identity.example.test/jwks",
      "http://identity.example.test/jwks",
    ]) {
      await expect(fetch(url, requestOptions())).rejects.toMatchObject({
        code: "oidc_destination_blocked",
      });
    }
    expect(mock.requests).toHaveLength(2);
  });

  it.each([
    "https://client:private@identity.example.test/token",
    "https://identity.example.test/token#private-fragment",
  ])("rejects URL credentials and fragments before DNS: %s", async (url) => {
    const mock = queuedTransport([]);
    const { fetch, resolveHost } = configuredFetch(mock.transport);

    const error = await capturedFailure(fetch(url, requestOptions()));

    expect(error.code).toBe("oidc_destination_blocked");
    expectNoPrivateContext(error, ["client:private", "private-fragment"]);
    expect(resolveHost).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(0);
  });

  it.each([
    ["string", "s".repeat(OIDC_MAX_REQUEST_BYTES + 1)],
    ["bytes", new Uint8Array(OIDC_MAX_REQUEST_BYTES + 1)],
    ["array-buffer", new ArrayBuffer(OIDC_MAX_REQUEST_BYTES + 1)],
    ["form", new URLSearchParams({ value: "s".repeat(OIDC_MAX_REQUEST_BYTES) })],
  ] satisfies readonly [string, FetchBody][])(
    "bounds a %s request body before DNS",
    async (_name, body) => {
      const mock = queuedTransport([]);
      const { fetch, resolveHost } = configuredFetch(mock.transport);

      await expect(
        fetch("https://identity.example.test/token", requestOptions({ body, method: "POST" })),
      ).rejects.toMatchObject({ code: "oidc_request_too_large" });
      expect(resolveHost).not.toHaveBeenCalled();
      expect(mock.requests).toHaveLength(0);
    },
  );

  it("accepts the exact request limit and copies mutable byte input", async () => {
    const mock = queuedTransport([new Response("{}")]);
    const { fetch } = configuredFetch(mock.transport);
    const body = new Uint8Array(OIDC_MAX_REQUEST_BYTES).fill(97);

    await fetch("https://identity.example.test/token", requestOptions({ body, method: "POST" }));
    body[0] = 98;

    expect(mock.requests[0]?.init.body?.byteLength).toBe(OIDC_MAX_REQUEST_BYTES);
    expect(mock.requests[0]?.init.body?.[0]).toBe(97);
  });

  it("bounds an accumulated request stream and cancels it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(30_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const mock = queuedTransport([]);
    const { fetch } = configuredFetch(mock.transport);

    await expect(
      fetch("https://identity.example.test/token", requestOptions({ body, method: "POST" })),
    ).rejects.toMatchObject({ code: "oidc_request_too_large" });
    expect(cancelled).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it("rejects non-byte request stream chunks", async () => {
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue("private-stream-value");
        controller.close();
      },
    });
    const mock = queuedTransport([]);
    const { fetch } = configuredFetch(mock.transport);

    const error = await capturedFailure(
      fetch("https://identity.example.test/token", requestOptions({ body, method: "POST" })),
    );

    expect(error.code).toBe("oidc_request_rejected");
    expectNoPrivateContext(error, ["private-stream-value"]);
  });

  it("rejects a declared oversized response and cancels it before reading", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const mock = queuedTransport([
      new Response(body, {
        headers: { "content-length": String(OIDC_MAX_RESPONSE_BYTES + 1) },
      }),
    ]);
    const { fetch } = configuredFetch(mock.transport);

    await expect(
      fetch("https://identity.example.test/jwks", requestOptions()),
    ).rejects.toMatchObject({ code: "oidc_response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("bounds a streamed response and accepts the exact response limit", async () => {
    let oversizedCancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        oversizedCancelled = true;
      },
    });
    const mock = queuedTransport([
      new Response(oversized),
      new Response(new Uint8Array(OIDC_MAX_RESPONSE_BYTES)),
    ]);
    const { fetch } = configuredFetch(mock.transport);

    await expect(
      fetch("https://identity.example.test/jwks", requestOptions()),
    ).rejects.toMatchObject({ code: "oidc_response_too_large" });
    const atLimit = await fetch("https://identity.example.test/jwks", requestOptions());

    expect(oversizedCancelled).toBe(true);
    expect((await atLimit.arrayBuffer()).byteLength).toBe(OIDC_MAX_RESPONSE_BYTES);
  });

  it("blocks and cancels redirects without inspecting or exposing Location", async () => {
    let cancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private-redirect-body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const mock = queuedTransport([
      new Response(redirectBody, {
        status: 302,
        headers: { location: "https://metadata.google.internal/?token=private-location" },
      }),
    ]);
    const { fetch } = configuredFetch(mock.transport);

    const error = await capturedFailure(
      fetch("https://identity.example.test/authorize", requestOptions()),
    );

    expect(error.code).toBe("oidc_destination_blocked");
    expect(cancelled).toBe(true);
    expectNoPrivateContext(error, ["metadata.google.internal", "private-location"]);
  });

  it("returns bounded non-redirect error responses for openid-client to process", async () => {
    const mock = queuedTransport([
      new Response('{"error":"invalid_grant"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const { fetch } = configuredFetch(mock.transport);

    const response = await fetch(
      "https://identity.example.test/token",
      requestOptions({ body: "grant_type=authorization_code", method: "POST" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_grant" });
  });

  it("drops upstream status text while preserving the status for protocol handling", async () => {
    const mock = queuedTransport([
      new Response('{"error":"invalid_grant"}', {
        status: 400,
        statusText: "private upstream diagnostic",
      }),
    ]);
    const { fetch } = configuredFetch(mock.transport);

    const response = await fetch(
      "https://identity.example.test/token",
      requestOptions({ body: "grant_type=authorization_code", method: "POST" }),
    );

    expect(response.status).toBe(400);
    expect(response.statusText).toBe("");
  });

  it("rejects blocked and mixed DNS answers and re-resolves every request", async () => {
    const resolveHost = vi
      .fn()
      .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 as const }])
      .mockResolvedValueOnce([
        { address: "1.1.1.1", family: 4 as const },
        { address: "169.254.169.254", family: 4 as const },
      ]);
    const mock = queuedTransport([new Response("{}")]);
    const fetch = createOidcSafeFetch({
      approvedOrigins: ["https://identity.example.test"],
      resolveHost,
      transport: mock.transport,
    });

    await fetch("https://identity.example.test/jwks", requestOptions());
    await expect(
      fetch("https://identity.example.test/jwks", requestOptions()),
    ).rejects.toMatchObject({ code: "oidc_destination_blocked" });

    expect(resolveHost).toHaveBeenCalledTimes(2);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.pinnedAddresses).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });

  it("reports DNS resolution failure without retaining resolver diagnostics", async () => {
    const privateResolverError = "private-resolver-diagnostic";
    const mock = queuedTransport([]);
    const fetch = createOidcSafeFetch({
      approvedOrigins: ["https://identity.example.test"],
      resolveHost: async () => {
        throw new Error(privateResolverError);
      },
      transport: mock.transport,
    });

    const error = await capturedFailure(
      fetch("https://identity.example.test/jwks", requestOptions()),
    );

    expect(error).toMatchObject({ code: "oidc_unreachable", retryable: true });
    expectNoPrivateContext(error, [privateResolverError]);
    expect(mock.requests).toHaveLength(0);
  });

  it("enforces the eight-second deadline while DNS is unresolved", async () => {
    vi.useFakeTimers();
    const resolveHost = vi.fn(() => new Promise<readonly ResolvedHostAddress[]>(() => undefined));
    const mock = queuedTransport([]);
    const fetch = createOidcSafeFetch({
      approvedOrigins: ["https://identity.example.test"],
      resolveHost,
      transport: mock.transport,
    });

    const pending = fetch("https://identity.example.test/jwks", requestOptions());
    const rejection = expect(pending).rejects.toMatchObject({
      code: "oidc_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(OIDC_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(mock.requests).toHaveLength(0);
  });

  it("keeps the deadline active while consuming a response body", async () => {
    vi.useFakeTimers();
    const responseBody = new ReadableStream<Uint8Array>({ start() {} });
    const mock = queuedTransport([new Response(responseBody)]);
    const { fetch } = configuredFetch(mock.transport);

    const pending = fetch("https://identity.example.test/jwks", requestOptions());
    const rejection = expect(pending).rejects.toMatchObject({
      code: "oidc_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(OIDC_REQUEST_TIMEOUT_MS);

    await rejection;
  });

  it("propagates caller aborts to transport without retaining the abort reason", async () => {
    const privateAbortReason = "private-caller-abort-reason";
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let enteredTransport!: () => void;
    const transportEntered = new Promise<void>((resolve) => {
      enteredTransport = resolve;
    });
    const transport: ConnectorTransport = (_url, init) => {
      transportSignal = init.signal;
      enteredTransport();
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error(`transport exposed ${privateAbortReason}`)),
          { once: true },
        );
      });
    };
    const { fetch } = configuredFetch(transport);
    const pending = fetch(
      "https://identity.example.test/jwks?token=private-query",
      requestOptions({ signal: caller.signal }),
    );
    await transportEntered;

    caller.abort(privateAbortReason);
    const error = await capturedFailure(pending);

    expect(transportSignal?.aborted).toBe(true);
    expect(error).toMatchObject({ code: "oidc_request_aborted", retryable: false });
    expectNoPrivateContext(error, [privateAbortReason, "private-query"]);
  });

  it("does no DNS or transport work for an already-aborted caller", async () => {
    const caller = new AbortController();
    caller.abort("private-pre-abort-reason");
    const mock = queuedTransport([]);
    const { fetch, resolveHost } = configuredFetch(mock.transport);

    await expect(
      fetch("https://identity.example.test/jwks", requestOptions({ signal: caller.signal })),
    ).rejects.toMatchObject({ code: "oidc_request_aborted" });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(0);
  });

  it("maps hostile transport failures to generic errors without request context", async () => {
    const privateValues = [
      "private-query-value",
      "private-client-secret",
      "private-request-body",
      "private-upstream-error",
    ];
    const transport: ConnectorTransport = async () => {
      throw new Error(`Failed for https://identity.example.test?token=${privateValues.join("|")}`);
    };
    const { fetch } = configuredFetch(transport);

    const error = await capturedFailure(
      fetch(
        `https://identity.example.test/token?code=${privateValues[0]}`,
        requestOptions({
          body: privateValues[2],
          headers: {
            authorization: `Basic ${privateValues[1]}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        }),
      ),
    );

    expect(error).toMatchObject({ code: "oidc_unreachable", retryable: true });
    expectNoPrivateContext(error, privateValues);
  });
});
