import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import type { AppConfig } from "../src/config.js";
import { createLoggerOptions, safeFailureDiagnostics } from "../src/logger.js";

function config(environment: AppConfig["environment"]): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32),
    environment,
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "info",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 1,
      inactivityTtlMs: 1,
      recoveryAbsoluteTtlMs: 1,
      rotationIntervalMs: 1,
    },
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

    logger.error({ err: error, operation: "http.request" }, `Request failed: ${error.message}`);
    await new Promise<void>((resolve) => destination.end(resolve));

    expect(output).toContain('"statusCode":502');
    expect(output).toContain('"type":"Error"');
    expect(output).toContain('"message":"Request failed"');
    expect(output).not.toMatch(/ey\.fake\.jwt|private\/media|secret-value|hunter2|assertion/i);
    expect(output).not.toContain(error.stack ?? "unreachable-stack");
  });

  it("retains only allowlisted failure classifications from nested causes", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(createLoggerOptions(config("production")), destination);
    const databaseError = Object.assign(new Error("private database path and row value"), {
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
    });
    const administrationError = Object.assign(
      new Error("private administration context", { cause: databaseError }),
      { reason: "integrity_failure" },
    );
    const publicError = Object.assign(
      new Error("public-safe failure", { cause: administrationError }),
      {
        code: "oidc_provider_configuration_unavailable",
        name: "SafeHttpError",
        statusCode: 503,
      },
    );

    logger.error(
      {
        err: publicError,
        ...safeFailureDiagnostics(publicError),
        operation: "http.request",
      },
      "Request failed",
    );
    await new Promise<void>((resolve) => destination.end(resolve));

    const record = JSON.parse(output) as Record<string, unknown> & {
      err: Record<string, unknown>;
    };
    expect(record.err).toEqual({
      errorCode: "oidc_provider_configuration_unavailable",
      statusCode: 503,
      type: "SafeHttpError",
    });
    expect(record.failureReason).toBe("integrity_failure");
    expect(record.infrastructureCode).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(output).not.toMatch(/private database path|row value|private administration context/iu);
  });

  it("redacts sensitive key variants at arbitrary request-body depths without hiding metadata", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(createLoggerOptions(config("production")), destination);
    const fields = {
      body: {
        Authorization: "Bearer upper-case-secret",
        authorization_header: "Bearer alternate-secret",
        harmless: {
          assertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          authorizationEndpoint: "https://identity.example/authorize",
          passwordPolicy: "long-and-random",
          secretRotationInterval: 86_400,
          statusCode: "UPSTREAM_OK",
          tokenType: "Bearer",
        },
        nested: [
          {
            requestBody: {
              access_token: "access-token-value",
              code: "authorization-code-value",
              client_assertion: "signed-assertion-value",
              encryptedCodeVerifier: "encrypted-verifier-value",
              encryptedCredentials: "v2.encrypted-connector-credentials-value",
              encryptedIdTokenHint: "encrypted-id-token-hint-value",
              encryptedNonce: "encrypted-nonce-value",
              encryptedPayload: "encrypted-media-reference-payload-value",
              mediaPath: "/private/media/library/movie.mkv",
              oidcSessionIdHash: "oidc-session-id-hash-value",
              password: "password-value",
              pw: "short-password-value",
              recoverySecretDigest: "recovery-secret-digest-value",
              quickConnect: { secret: "quick-connect-secret-value" },
              quickConnectSecret: "quick-connect-flat-secret-value",
              requestCookies: "omnifin_session=request-cookie-value",
              sessionTokenHash: "session-token-hash-value",
              setCookies: ["omnifin_session=set-cookie-value"],
              state: "oidc-state-value",
              upstreamSessionId: "upstream-session-id-value",
            },
          },
        ],
        "proxy-authorization": "Basic proxy-secret",
      },
    };

    logger.info(fields, "Payload accepted");
    await new Promise<void>((resolve) => destination.end(resolve));

    const record = JSON.parse(output) as {
      body: typeof fields.body;
      message: string;
    };
    expect(record.body.Authorization).toBe("[REDACTED]");
    expect(record.body.authorization_header).toBe("[REDACTED]");
    expect(record.body["proxy-authorization"]).toBe("[REDACTED]");
    expect(record.body.nested[0]?.requestBody).toEqual({
      access_token: "[REDACTED]",
      code: "[REDACTED]",
      client_assertion: "[REDACTED]",
      encryptedCodeVerifier: "[REDACTED]",
      encryptedCredentials: "[REDACTED]",
      encryptedIdTokenHint: "[REDACTED]",
      encryptedNonce: "[REDACTED]",
      encryptedPayload: "[REDACTED]",
      mediaPath: "[REDACTED]",
      oidcSessionIdHash: "[REDACTED]",
      password: "[REDACTED]",
      pw: "[REDACTED]",
      recoverySecretDigest: "[REDACTED]",
      quickConnect: { secret: "[REDACTED]" },
      quickConnectSecret: "[REDACTED]",
      requestCookies: "[REDACTED]",
      sessionTokenHash: "[REDACTED]",
      setCookies: "[REDACTED]",
      state: "[REDACTED]",
      upstreamSessionId: "[REDACTED]",
    });
    expect(record.body.harmless).toEqual(fields.body.harmless);
    expect(record.message).toBe("Payload accepted");
    expect(fields.body.nested[0]?.requestBody.password).toBe("password-value");
    expect(output).not.toMatch(
      /upper-case-secret|alternate-secret|access-token-value|authorization-code-value|encrypted-(?:connector-credentials|media-reference-payload|verifier|id-token-hint|nonce)-value|signed-assertion-value|oidc-(?:session-id-hash|state)-value|password-value|private\/media|proxy-secret|quick-connect-(?:flat-)?secret-value|recovery-secret-digest-value|request-cookie-value|session-token-hash-value|set-cookie-value|upstream-session-id-value/,
    );
  });

  it("sanitizes bare and deeply nested errors without serializing messages or stacks", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(createLoggerOptions(config("production")), destination);
    const bareError = Object.assign(new Error("bare-message-sensitive-value"), {
      code: "UPSTREAM_FAILURE",
      statusCode: 502,
    });
    const nestedError = Object.assign(new TypeError("nested-message-sensitive-value"), {
      authorization: "Bearer nested-authorization-sensitive-value",
      code: "INVALID_ASSERTION",
    });
    const conventionalError = new Error("conventional-message-sensitive-value");

    logger.error(bareError);
    logger.error({ err: conventionalError });
    logger.error(bareError, `Request failed: ${bareError.message}`);
    logger.error({ err: conventionalError }, "Request failed: %s", conventionalError.message);
    logger.error("Unsafe interpolation: %s", conventionalError);
    logger.warn(
      { operation: { failure: nestedError } },
      "Nested operation failed: %s",
      nestedError.message,
    );
    await new Promise<void>((resolve) => destination.end(resolve));

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(6);
    expect(records[0]?.err).toEqual({
      errorCode: "UPSTREAM_FAILURE",
      statusCode: 502,
      type: "Error",
    });
    expect(records[1]?.err).toEqual({ type: "Error" });
    expect(records[2]?.err).toEqual(records[0]?.err);
    expect(records[3]?.err).toEqual({ type: "Error" });
    expect(records[3]?.message).toBe("Error logged");
    expect(records[4]?.err).toEqual({ type: "Error" });
    expect(records[4]?.message).toBe("Error logged");
    expect(records[5]?.operation).toEqual({
      failure: { errorCode: "INVALID_ASSERTION", type: "TypeError" },
    });
    expect(output).not.toMatch(
      /bare-message-sensitive-value|conventional-message-sensitive-value|nested-message-sensitive-value|nested-authorization-sensitive-value|\"stack\"/,
    );
    expect(output).not.toContain(bareError.stack ?? "unreachable-bare-stack");
    expect(output).not.toContain(nestedError.stack ?? "unreachable-nested-stack");
    expect(output).not.toContain(conventionalError.stack ?? "unreachable-conventional-stack");
  });

  it("fails closed for custom-prototype and hostile log values", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(createLoggerOptions(config("production")), destination);
    class CredentialCarrier {
      public readonly token = "custom-prototype-token-value";
    }
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy-own-keys-sensitive-value");
        },
      },
    );

    logger.info({ custom: new CredentialCarrier(), hostile }, "Opaque values received");
    await new Promise<void>((resolve) => destination.end(resolve));

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record.custom).toBe("[OPAQUE_OBJECT]");
    expect(record.hostile).toBe("[TRUNCATED]");
    expect(output).not.toMatch(/custom-prototype-token-value|proxy-own-keys-sensitive-value/);
  });
});
