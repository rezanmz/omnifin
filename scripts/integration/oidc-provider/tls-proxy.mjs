#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";

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

function forwardedRequestHeaders(headers, host, remote) {
  const forwarded = {
    host,
    "x-forwarded-for": remote,
    "x-forwarded-host": host,
    "x-forwarded-port": host.split(":").at(-1) ?? "443",
    "x-forwarded-proto": "https",
  };
  if (headers.accept !== undefined) forwarded.accept = headers.accept;
  if (headers["accept-encoding"] !== undefined) {
    forwarded["accept-encoding"] = headers["accept-encoding"];
  }
  if (headers["accept-language"] !== undefined) {
    forwarded["accept-language"] = headers["accept-language"];
  }
  if (headers.authorization !== undefined) forwarded.authorization = headers.authorization;
  if (headers["cache-control"] !== undefined) {
    forwarded["cache-control"] = headers["cache-control"];
  }
  if (headers["content-length"] !== undefined) {
    forwarded["content-length"] = headers["content-length"];
  }
  if (headers["content-type"] !== undefined) {
    forwarded["content-type"] = headers["content-type"];
  }
  if (headers.cookie !== undefined) forwarded.cookie = headers.cookie;
  if (headers.origin !== undefined) forwarded.origin = headers.origin;
  if (headers.pragma !== undefined) forwarded.pragma = headers.pragma;
  if (headers.referer !== undefined) forwarded.referer = headers.referer;
  if (headers["sec-fetch-dest"] !== undefined) {
    forwarded["sec-fetch-dest"] = headers["sec-fetch-dest"];
  }
  if (headers["sec-fetch-mode"] !== undefined) {
    forwarded["sec-fetch-mode"] = headers["sec-fetch-mode"];
  }
  if (headers["sec-fetch-site"] !== undefined) {
    forwarded["sec-fetch-site"] = headers["sec-fetch-site"];
  }
  if (headers["user-agent"] !== undefined) forwarded["user-agent"] = headers["user-agent"];
  if (headers["x-omnifin-csrf"] !== undefined) {
    forwarded["x-omnifin-csrf"] = headers["x-omnifin-csrf"];
  }
  return forwarded;
}

function forwardedResponseHeaders(headers) {
  const forwarded = {};
  if (headers["accept-ranges"] !== undefined) {
    forwarded["accept-ranges"] = headers["accept-ranges"];
  }
  if (headers["cache-control"] !== undefined) {
    forwarded["cache-control"] = headers["cache-control"];
  }
  if (headers["content-disposition"] !== undefined) {
    forwarded["content-disposition"] = headers["content-disposition"];
  }
  if (headers["content-encoding"] !== undefined) {
    forwarded["content-encoding"] = headers["content-encoding"];
  }
  if (headers["content-language"] !== undefined) {
    forwarded["content-language"] = headers["content-language"];
  }
  if (headers["content-length"] !== undefined) {
    forwarded["content-length"] = headers["content-length"];
  }
  if (headers["content-range"] !== undefined) {
    forwarded["content-range"] = headers["content-range"];
  }
  if (headers["content-security-policy"] !== undefined) {
    forwarded["content-security-policy"] = headers["content-security-policy"];
  }
  if (headers["content-type"] !== undefined) {
    forwarded["content-type"] = headers["content-type"];
  }
  if (headers.date !== undefined) forwarded.date = headers.date;
  if (headers.etag !== undefined) forwarded.etag = headers.etag;
  if (headers.expires !== undefined) forwarded.expires = headers.expires;
  if (headers["last-modified"] !== undefined) {
    forwarded["last-modified"] = headers["last-modified"];
  }
  if (headers.link !== undefined) forwarded.link = headers.link;
  if (headers.location !== undefined) forwarded.location = headers.location;
  if (headers["permissions-policy"] !== undefined) {
    forwarded["permissions-policy"] = headers["permissions-policy"];
  }
  if (headers.pragma !== undefined) forwarded.pragma = headers.pragma;
  if (headers["referrer-policy"] !== undefined) {
    forwarded["referrer-policy"] = headers["referrer-policy"];
  }
  if (headers["retry-after"] !== undefined) {
    forwarded["retry-after"] = headers["retry-after"];
  }
  if (headers["set-cookie"] !== undefined) forwarded["set-cookie"] = headers["set-cookie"];
  if (headers["strict-transport-security"] !== undefined) {
    forwarded["strict-transport-security"] = headers["strict-transport-security"];
  }
  if (headers.vary !== undefined) forwarded.vary = headers.vary;
  if (headers["www-authenticate"] !== undefined) {
    forwarded["www-authenticate"] = headers["www-authenticate"];
  }
  if (headers["x-content-type-options"] !== undefined) {
    forwarded["x-content-type-options"] = headers["x-content-type-options"];
  }
  if (headers["x-frame-options"] !== undefined) {
    forwarded["x-frame-options"] = headers["x-frame-options"];
  }
  if (headers["x-request-id"] !== undefined) {
    forwarded["x-request-id"] = headers["x-request-id"];
  }
  return forwarded;
}

function forward(targetPort) {
  return (request, response) => {
    const host = request.headers.host ?? "";
    const remote = (request.socket.remoteAddress ?? "").replace(/^::ffff:/u, "");
    const upstream = httpRequest({
      headers: forwardedRequestHeaders(request.headers, host, remote),
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
        forwardedResponseHeaders(upstreamResponse.headers),
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
