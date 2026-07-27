import {
  AUTH_PROVIDERS_RESPONSE_MAX_BYTES,
  authProvidersResponseSchema,
  type AuthProvider,
} from "@omnifin/contracts/auth";

const PROVIDER_REQUEST_TIMEOUT_MS = 3_000;
const PROVIDER_RESULT_CACHE_TTL_MS = 5_000;
const PROVIDER_RESULT_CACHE_MAX_ENTRIES = 4;

export interface PublicAuthProviderLoadResult {
  readonly providers: readonly AuthProvider[];
  readonly status: "ready" | "unavailable";
}

interface LoadPublicAuthProvidersOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly gatewayUrl: string;
}

interface CachedPublicAuthProviderLoaderOptions {
  readonly clock?: () => number;
  readonly fetchImplementation?: typeof fetch;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}

interface ProviderResultCacheEntry {
  cachedAt?: number;
  expiresAt?: number;
  inFlight?: Promise<PublicAuthProviderLoadResult>;
  value?: PublicAuthProviderLoadResult;
}

function unavailableResult(): PublicAuthProviderLoadResult {
  return Object.freeze({ providers: [], status: "unavailable" });
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

function responseIsBounded(response: Response): boolean {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) return true;
  if (!/^\d+$/.test(contentLength)) return false;
  const bytes = Number(contentLength);
  return Number.isSafeInteger(bytes) && bytes <= AUTH_PROVIDERS_RESPONSE_MAX_BYTES;
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
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
      if (bytesRead > AUTH_PROVIDERS_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Preserve the fixed unavailable result when the stream also fails to cancel.
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

export async function loadPublicAuthProviders({
  fetchImplementation = fetch,
  gatewayUrl,
}: LoadPublicAuthProvidersOptions): Promise<PublicAuthProviderLoadResult> {
  try {
    const endpoint = new URL("/v1/auth/providers", canonicalGatewayUrl(gatewayUrl));
    const response = await fetchImplementation(endpoint.href, {
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !contentType.includes("application/json") || !responseIsBounded(response)) {
      await cancelBody(response);
      return unavailableResult();
    }
    const body = await readBoundedBody(response);
    if (body === undefined) return unavailableResult();
    const parsed = authProvidersResponseSchema.safeParse(JSON.parse(body) as unknown);
    if (!parsed.success) return unavailableResult();
    return Object.freeze({ providers: Object.freeze(parsed.data.providers), status: "ready" });
  } catch {
    return unavailableResult();
  }
}

export function createCachedPublicAuthProviderLoader(
  options: CachedPublicAuthProviderLoaderOptions = {},
) {
  const clock = options.clock ?? Date.now;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maxEntries = options.maxEntries ?? PROVIDER_RESULT_CACHE_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? PROVIDER_RESULT_CACHE_TTL_MS;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) {
    throw new TypeError("The provider cache entry limit is invalid.");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) {
    throw new TypeError("The provider cache TTL is invalid.");
  }

  const entries = new Map<string, ProviderResultCacheEntry>();
  const touch = (key: string, entry: ProviderResultCacheEntry) => {
    entries.delete(key);
    entries.set(key, entry);
  };
  const trim = () => {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  };

  return async ({ gatewayUrl }: Pick<LoadPublicAuthProvidersOptions, "gatewayUrl">) => {
    let key: string;
    try {
      key = canonicalGatewayUrl(gatewayUrl).href;
    } catch {
      return unavailableResult();
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) return unavailableResult();

    const existing = entries.get(key);
    if (existing?.inFlight) {
      touch(key, existing);
      return existing.inFlight;
    }
    if (
      existing?.value &&
      existing.cachedAt !== undefined &&
      existing.expiresAt !== undefined &&
      now >= existing.cachedAt &&
      now < existing.expiresAt
    ) {
      touch(key, existing);
      return existing.value;
    }
    if (existing) entries.delete(key);

    const entry: ProviderResultCacheEntry = {};
    const inFlight = loadPublicAuthProviders({ fetchImplementation, gatewayUrl: key }).then(
      (value) => {
        const completedAt = clock();
        if (entries.get(key) === entry && Number.isSafeInteger(completedAt) && completedAt >= now) {
          entry.cachedAt = completedAt;
          entry.expiresAt = completedAt + ttlMs;
          entry.value = value;
          touch(key, entry);
        }
        return value;
      },
    );
    entry.inFlight = inFlight;
    entries.set(key, entry);
    trim();

    try {
      return await inFlight;
    } finally {
      if (entries.get(key) === entry) {
        delete entry.inFlight;
        if (entry.value === undefined) entries.delete(key);
      }
    }
  };
}

export const loadCachedPublicAuthProviders = createCachedPublicAuthProviderLoader();
