#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("proxy_configuration_invalid");
  return value;
}

function port(name) {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("proxy_configuration_invalid");
  }
  return value;
}

function filteredHeaders(headers) {
  const filtered = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      filtered[name] = value;
    }
  }
  return filtered;
}

function forward(targetPort) {
  return (request, response) => {
    const host = request.headers.host ?? "";
    const remote = (request.socket.remoteAddress ?? "").replace(/^::ffff:/u, "");
    const upstream = httpRequest({
      headers: {
        ...filteredHeaders(request.headers),
        host,
        "x-forwarded-for": remote,
        "x-forwarded-host": host,
        "x-forwarded-port": host.split(":").at(-1) ?? "443",
        "x-forwarded-proto": "https",
      },
      host: "127.0.0.1",
      method: request.method,
      path: request.url,
      port: targetPort,
      timeout: 30_000,
    });

    upstream.once("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        filteredHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
    });
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
      }
      response.end("Upstream unavailable.");
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  };
}

const tls = {
  cert: readFileSync(required("OMNIFIN_FIXTURE_TLS_CERT")),
  key: readFileSync(required("OMNIFIN_FIXTURE_TLS_KEY")),
};
const servers = [
  createServer(tls, forward(port("OMNIFIN_FIXTURE_WEB_UPSTREAM_PORT"))),
  createServer(tls, forward(port("OMNIFIN_FIXTURE_PROVIDER_UPSTREAM_PORT"))),
];
for (const server of servers) {
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => socket.destroy());
}

await Promise.all([
  new Promise((resolve, reject) => {
    servers[0].once("error", reject);
    servers[0].listen(port("OMNIFIN_FIXTURE_WEB_TLS_PORT"), "0.0.0.0", resolve);
  }),
  new Promise((resolve, reject) => {
    servers[1].once("error", reject);
    servers[1].listen(port("OMNIFIN_FIXTURE_PROVIDER_TLS_PORT"), "0.0.0.0", resolve);
  }),
]);

process.stdout.write('{"event":"fixture_tls_ready"}\n');

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
