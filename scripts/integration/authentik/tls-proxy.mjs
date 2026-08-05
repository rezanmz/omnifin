#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";

import { forwardedRequestHeaders, forwardedResponseHeaders } from "./tls-proxy-headers.mjs";

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

function remoteAddress(request) {
  return (request.socket.remoteAddress ?? "").replace(/^::ffff:/u, "");
}

function isBackchannelRequest(request) {
  if (request.method !== "POST" || typeof request.url !== "string") return false;
  try {
    return (
      new URL(request.url, "https://fixture.invalid").pathname ===
      "/api/auth/oidc/backchannel/oidc-authentik"
    );
  } catch {
    return false;
  }
}

function forward(targetPort, publicHost, publicPort, observeBackchannel = false) {
  return (request, response) => {
    const backchannel = observeBackchannel && isBackchannelRequest(request);
    if (backchannel) process.stdout.write('{"event":"fixture_backchannel_received"}\n');
    const host = `${publicHost}:${publicPort}`;
    const upstream = httpRequest({
      host: "127.0.0.1",
      method: request.method,
      path: request.url,
      port: targetPort,
      timeout: 30_000,
    });
    upstream.setHeaders(
      forwardedRequestHeaders(request.headers, host, String(publicPort), remoteAddress(request)),
    );

    upstream.once("response", (upstreamResponse) => {
      if (backchannel) {
        process.stdout.write(
          `${JSON.stringify({ event: "fixture_backchannel_response", status: upstreamResponse.statusCode ?? 0 })}\n`,
        );
      }
      const status = upstreamResponse.statusCode;
      response.statusCode =
        Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502;
      response.setHeaders(forwardedResponseHeaders(upstreamResponse.headers));
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
const publicHost = required("OMNIFIN_FIXTURE_PUBLIC_HOST");
const webTlsPort = port("OMNIFIN_FIXTURE_WEB_TLS_PORT");
const authentikTlsPort = port("OMNIFIN_FIXTURE_AUTHENTIK_TLS_PORT");
const servers = [
  createServer(
    tls,
    forward(port("OMNIFIN_FIXTURE_WEB_UPSTREAM_PORT"), publicHost, webTlsPort, true),
  ),
  createServer(
    tls,
    forward(port("OMNIFIN_FIXTURE_AUTHENTIK_UPSTREAM_PORT"), publicHost, authentikTlsPort),
  ),
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
    servers[0].listen(webTlsPort, "0.0.0.0", resolve);
  }),
  new Promise((resolve, reject) => {
    servers[1].once("error", reject);
    servers[1].listen(authentikTlsPort, "0.0.0.0", resolve);
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
