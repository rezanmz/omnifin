import { Agent as HttpAgent, request as requestHttp } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import type { RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import type { ResolvedHostAddress } from "../security/destination.js";
import type { ConnectorTransport, ConnectorTransportInit } from "../types.js";

function requestedFamily(value: number | string | undefined): 4 | 6 | undefined {
  if (value === 4 || value === "IPv4") return 4;
  if (value === 6 || value === "IPv6") return 6;
  return undefined;
}

export function createPinnedLookup(
  expectedHostname: string,
  addresses: readonly ResolvedHostAddress[],
): LookupFunction {
  return (hostname, options, callback) => {
    if (
      hostname.toLowerCase().replace(/\.$/, "") !==
      expectedHostname.toLowerCase().replace(/\.$/, "")
    ) {
      const error = Object.assign(
        new Error("Pinned connector lookup rejected an unexpected host."),
        {
          code: "ENOTFOUND",
        },
      );
      callback(error, "", 0);
      return;
    }

    const family = requestedFamily(options.family);
    const matches = family ? addresses.filter((address) => address.family === family) : addresses;
    if (matches.length === 0) {
      const error = Object.assign(
        new Error("Pinned connector lookup has no address for this family."),
        {
          code: "ENOTFOUND",
        },
      );
      callback(error, "", 0);
      return;
    }

    if (options.all) {
      callback(
        null,
        matches.map(({ address, family: addressFamily }) => ({
          address,
          family: addressFamily,
        })),
      );
      return;
    }

    const selected = matches[0];
    if (!selected) {
      callback(
        Object.assign(new Error("Pinned connector lookup failed."), { code: "ENOTFOUND" }),
        "",
        0,
      );
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function responseHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

export function createPinnedRequestOptions(
  url: URL,
  init: ConnectorTransportInit,
  pinnedAddresses: readonly ResolvedHostAddress[],
  agent: HttpAgent | HttpsAgent | false = false,
): RequestOptions {
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return {
    protocol: url.protocol,
    hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: init.method,
    headers: Object.fromEntries(init.headers.entries()),
    lookup: createPinnedLookup(hostname, pinnedAddresses),
    agent,
    ...(url.protocol === "https:"
      ? {
          // Node otherwise derives SNI from hostname, which is invalid for literal IP targets.
          servername: isIP(hostname) === 0 ? hostname : "",
          rejectUnauthorized: true,
          ...(init.tlsPolicy === "allow_self_signed" ? { ca: init.tlsCaCertificatePem } : {}),
        }
      : {}),
    signal: init.signal,
  };
}

export interface PinnedTransportPoolOptions {
  maxSockets: number;
  maxTotalSockets: number;
  maxFreeSockets: number;
  maxAgents: number;
}

export interface PinnedTransportPool {
  readonly transport: ConnectorTransport;
  close(): void;
}

interface AgentEntry {
  readonly key: string;
  readonly agent: HttpAgent | HttpsAgent;
}

function canonicalPinSetIdentity(addresses: readonly ResolvedHostAddress[]): string {
  return [
    ...new Set(
      addresses.map(({ address, family }) => `${family}:${canonicalAddress(address, family)}`),
    ),
  ]
    .sort()
    .join(",");
}

function canonicalAddress(address: string, family: 4 | 6): string {
  if (family === 4) return address.toLowerCase();
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

export function pinnedTransportPoolKey(
  url: URL,
  pinnedAddresses: readonly ResolvedHostAddress[],
): string {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}|${hostname}|${port}|${canonicalPinSetIdentity(pinnedAddresses)}`;
}

/**
 * Creates agents that are isolated by the complete validated destination pin set.
 * Keeping this ownership behind an explicit factory prevents arbitrary injected
 * transports from being pooled accidentally.
 */
export function createPinnedTransportPool(
  options: PinnedTransportPoolOptions,
): PinnedTransportPool {
  if (!Number.isSafeInteger(options.maxAgents) || options.maxAgents < 1) {
    throw new RangeError("The pinned transport agent cache bound must be a positive safe integer.");
  }
  const agents = new Map<string, AgentEntry>();
  const retired = new Set<AgentEntry>();
  let closed = false;

  const isBusy = (agent: HttpAgent | HttpsAgent): boolean =>
    Object.values(agent.sockets).some((sockets) => (sockets ?? []).length > 0) ||
    Object.values(agent.requests).some((requests) => (requests ?? []).length > 0);
  const destroy = (entry: AgentEntry) => {
    entry.agent.destroy();
    retired.delete(entry);
    if (agents.get(entry.key) === entry) agents.delete(entry.key);
  };
  const reap = () => {
    for (const entry of retired) {
      if (!isBusy(entry.agent)) destroy(entry);
    }
  };
  const retire = (entry: AgentEntry) => {
    agents.delete(entry.key);
    if (isBusy(entry.agent)) retired.add(entry);
    else entry.agent.destroy();
  };
  const evictForNewAgent = () => {
    const oldest = agents.values().next().value as AgentEntry | undefined;
    if (oldest) retire(oldest);
    if (agents.size + retired.size >= options.maxAgents) {
      const oldestRetired = retired.values().next().value as AgentEntry | undefined;
      if (oldestRetired) destroy(oldestRetired);
    }
  };
  const makeAgent = (key: string, url: URL): AgentEntry => {
    const agentOptions = {
      keepAlive: true,
      maxSockets: options.maxSockets,
      maxTotalSockets: options.maxTotalSockets,
      maxFreeSockets: options.maxFreeSockets,
    };
    const agent =
      url.protocol === "https:" ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions);
    const entry = { key, agent };
    agent.on("free", reap);
    agent.on("close", reap);
    return entry;
  };

  const transport: ConnectorTransport = (url, init, pinnedAddresses) => {
    if (closed) return Promise.reject(new Error("The connector HTTP transport is closed."));

    const key = `${pinnedTransportPoolKey(url, pinnedAddresses)}|${init.tlsPolicy}|${init.tlsCaCertificatePem ?? ""}`;
    reap();
    let entry = agents.get(key);
    if (!entry) {
      while (agents.size + retired.size >= options.maxAgents) evictForNewAgent();
      entry = makeAgent(key, url);
      agents.set(key, entry);
    } else {
      agents.delete(key);
      agents.set(key, entry);
    }

    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
        createPinnedRequestOptions(url, init, pinnedAddresses, entry.agent),
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          const cannotHaveBody = [204, 205, 304].includes(status);
          const body = cannotHaveBody
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
          try {
            resolve(
              new Response(body, {
                status,
                ...(incoming.statusMessage === undefined
                  ? {}
                  : { statusText: incoming.statusMessage }),
                headers: responseHeaders(incoming.rawHeaders),
              }),
            );
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
          reap();
        },
      );

      request.once("error", (error) => {
        reap();
        reject(error);
      });
      if (init.body) request.write(init.body);
      request.end();
    });
  };

  return {
    transport,
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of agents.values()) entry.agent.destroy();
      for (const entry of retired) entry.agent.destroy();
      agents.clear();
      retired.clear();
    },
  };
}

export const pinnedNodeTransport: ConnectorTransport = (url, init, pinnedAddresses) =>
  new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
      createPinnedRequestOptions(url, init, pinnedAddresses),
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const cannotHaveBody = [204, 205, 304].includes(status);
        const body = cannotHaveBody
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        try {
          resolve(
            new Response(body, {
              status,
              ...(incoming.statusMessage === undefined
                ? {}
                : { statusText: incoming.statusMessage }),
              headers: responseHeaders(incoming.rawHeaders),
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );

    request.once("error", reject);
    if (init.body) request.write(init.body);
    request.end();
  });
