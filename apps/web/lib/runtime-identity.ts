import {
  RUNTIME_IDENTITY_RESPONSE_MAX_BYTES,
  runtimeIdentitySchema,
  type RuntimeIdentity,
} from "@omnifin/contracts/runtime";

const RUNTIME_IDENTITY_TIMEOUT_MS = 3_000;

export type RuntimeIdentityLoadOutcome =
  | { readonly identity: RuntimeIdentity; readonly status: "ready" }
  | { readonly status: "unavailable" };

interface LoadRuntimeIdentityOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly gatewayUrl: string;
}

function canonicalGatewayUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("The gateway URL is invalid.");
  }
  return url;
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > RUNTIME_IDENTITY_RESPONSE_MAX_BYTES)
  ) {
    await cancelBody(response);
    return undefined;
  }

  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > RUNTIME_IDENTITY_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Preserve the fixed unavailable result if stream cleanup also fails.
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

export async function loadRuntimeIdentity({
  fetchImplementation = fetch,
  gatewayUrl,
}: LoadRuntimeIdentityOptions): Promise<RuntimeIdentityLoadOutcome> {
  try {
    const endpoint = new URL("/v1/runtime", canonicalGatewayUrl(gatewayUrl));
    const response = await fetchImplementation(endpoint.href, {
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(RUNTIME_IDENTITY_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !contentType.includes("application/json")) {
      await cancelBody(response);
      return { status: "unavailable" };
    }
    const body = await readBoundedBody(response);
    if (body === undefined) return { status: "unavailable" };
    const parsed = runtimeIdentitySchema.safeParse(JSON.parse(body) as unknown);
    return parsed.success
      ? { identity: Object.freeze(parsed.data), status: "ready" }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
