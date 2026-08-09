#!/usr/bin/env node

import { createServer } from "node:http";

const port = Number(process.env.OMNIFIN_FIXTURE_JELLYFIN_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) process.exit(1);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/System/Info/Public") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        Id: "fixture-jellyfin-server",
        ServerName: "Omnifin isolated Jellyfin fixture",
        Version: "10.10.7",
      }),
    );
    return;
  }

  if (request.method === "POST" && request.url === "/Users/AuthenticateByName") {
    // Drain the bounded bootstrap credential shape without logging it.
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        AccessToken: "fixture-jellyfin-access-token",
        ServerId: "fixture-jellyfin-server",
        User: {
          Id: "fixture-jellyfin-admin",
          Name: "fixture-admin",
          Policy: { IsAdministrator: true },
        },
      }),
    );
    return;
  }

  response.writeHead(404);
  response.end();
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write("fixture_jellyfin_ready\n");
});

function stop() {
  server.close(() => process.exit(0));
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
