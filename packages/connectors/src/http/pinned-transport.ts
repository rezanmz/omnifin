import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import type { RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
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
    agent: false,
    ...(url.protocol === "https:"
      ? {
          rejectUnauthorized: true,
          ...(init.tlsPolicy === "allow_self_signed" ? { ca: init.tlsCaCertificatePem } : {}),
        }
      : {}),
    signal: init.signal,
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
