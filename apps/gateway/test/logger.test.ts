import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import type { AppConfig } from "../src/config.js";
import { createLoggerOptions } from "../src/logger.js";

function config(environment: AppConfig["environment"]): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32),
    environment,
    host: "127.0.0.1",
    jellyfinInsecureHttpApproved: false,
    logLevel: "info",
    port: 4000,
    secureCookies: true,
    session: { absoluteTtlMs: 1, inactivityTtlMs: 1, rotationIntervalMs: 1 },
    trustProxyHops: 0,
  };
}

describe("gateway logger", () => {
  it("drops query strings from request serialization", () => {
    const options = createLoggerOptions(config("production"));
    const serialize = options.serializers?.req;
    expect(serialize).toBeTypeOf("function");
    expect(serialize?.({ id: "request", method: "GET", url: "/callback?code=secret" })).toEqual({
      id: "request",
      method: "GET",
      path: "/callback",
    });
    expect(serialize?.({ url: undefined })).toEqual({
      id: undefined,
      method: undefined,
      path: undefined,
    });
  });

  it("omits exception messages, stacks, paths, and credentials from captured logs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(createLoggerOptions(config("production")), destination);
    const error = Object.assign(
      new Error(
        "OIDC assertion ey.fake.jwt for /private/media?token=secret-value and password=hunter2",
      ),
      { code: "UPSTREAM_FAILURE", statusCode: 502 },
    );

    logger.error({ err: error }, "Request failed");
    await new Promise<void>((resolve) => destination.end(resolve));

    expect(output).toContain('"statusCode":502');
    expect(output).toContain('"type":"Error"');
    expect(output).toContain("Request failed");
    expect(output).not.toMatch(/ey\.fake\.jwt|private\/media|secret-value|hunter2|assertion/i);
    expect(output).not.toContain(error.stack ?? "unreachable-stack");
  });
});
