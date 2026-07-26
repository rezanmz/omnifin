#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authentikFixture,
  dotenv,
  reportFor,
  secretLeakDetected,
  selectPrivateHost,
} from "./fixture.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const composeFile = join(root, "scripts/integration/authentik/compose.yaml");
const proxyScript = join(root, "scripts/integration/authentik/tls-proxy.mjs");
const browserScript = join(root, "scripts/integration/authentik/browser-check.mjs");
const MAX_CAPTURE_BYTES = 512 * 1_024;

class FixtureError extends Error {
  constructor(category) {
    super(category);
    this.name = "FixtureError";
    this.category = category;
  }
}

function parseArguments(arguments_) {
  const options = { output: null, skipBuild: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--output") options.output = arguments_[++index];
    else if (argument === "--skip-build") options.skipBuild = true;
    else throw new FixtureError("arguments_invalid");
  }
  if (!options.output) throw new FixtureError("arguments_invalid");
  return options;
}

function secureToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function appendBounded(current, chunk) {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_CAPTURE_BYTES);
}

function commandEnvironment(overrides = {}) {
  return {
    ...process.env,
    CI: "true",
    COMPOSE_ANSI: "never",
    FORCE_COLOR: "0",
    TURBO_TELEMETRY_DISABLED: "1",
    ...overrides,
  };
}

async function runCommand(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    cwd: options.cwd ?? root,
    env: commandEnvironment(options.env),
    stdio: options.visible ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  if (!options.visible) {
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
  }
  const [code] = await once(child, "close");
  if (spawnFailed || code !== 0) {
    throw new FixtureError(options.failureCategory ?? "command_failed");
  }
  return { stderr, stdout };
}

function spawnRuntime(command, arguments_, environment) {
  const child = spawn(command, arguments_, {
    cwd: root,
    env: commandEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtime = { child, spawnFailed: false, stderr: "", stdout: "" };
  child.once("error", () => {
    runtime.spawnFailed = true;
  });
  child.stdout.on("data", (chunk) => {
    runtime.stdout = appendBounded(runtime.stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    runtime.stderr = appendBounded(runtime.stderr, chunk);
  });
  return runtime;
}

async function stopRuntime(runtime) {
  if (!runtime || runtime.spawnFailed || runtime.child.exitCode !== null) return;
  runtime.child.kill("SIGTERM");
  await Promise.race([
    once(runtime.child, "exit"),
    new Promise((resolve) => {
      setTimeout(() => {
        if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    }),
  ]);
}

async function reservePort(host) {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new FixtureError("port_reservation_failed");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function writePrivateFile(path, contents, mode = 0o600) {
  writeFileSync(path, contents, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

async function generateCertificate(directory, host) {
  const caKey = join(directory, "ca.key");
  const caCertificate = join(directory, "ca.pem");
  const serverKey = join(directory, "server.key");
  const serverRequest = join(directory, "server.csr");
  const serverCertificate = join(directory, "server.pem");
  const extensions = join(directory, "server-extensions.cnf");
  writePrivateFile(
    extensions,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=IP:${host}`,
      "",
    ].join("\n"),
  );
  await runCommand(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      caKey,
      "-out",
      caCertificate,
      "-subj",
      "/CN=Omnifin isolated fixture CA",
    ],
    { failureCategory: "certificate_generation_failed" },
  );
  await runCommand(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      serverKey,
      "-out",
      serverRequest,
      "-subj",
      "/CN=Omnifin isolated fixture",
    ],
    { failureCategory: "certificate_generation_failed" },
  );
  await runCommand(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      serverRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensions,
      "-out",
      serverCertificate,
    ],
    { failureCategory: "certificate_generation_failed" },
  );
  chmodSync(caCertificate, 0o644);
  chmodSync(serverCertificate, 0o644);
  chmodSync(serverKey, 0o600);
  return { caCertificate, serverCertificate, serverKey };
}

function composeArguments(project, environmentFile, ...arguments_) {
  return [
    "compose",
    "--project-name",
    project,
    "--file",
    composeFile,
    "--env-file",
    environmentFile,
    ...arguments_,
  ];
}

function parsePasswordHash(output) {
  const match = output.match(/pbkdf2_sha256\$\d+\$[^\s$]+\$[A-Za-z0-9+/=]+/u);
  if (!match) throw new FixtureError("password_hash_generation_failed");
  return match[0];
}

function trustedJson(url, caCertificate) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        ca: readFileSync(caCertificate),
        headers: { accept: "application/json" },
        method: "GET",
        rejectUnauthorized: true,
        timeout: 10_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body = `${body}${chunk}`;
          if (Buffer.byteLength(body) > 1_048_576) request.destroy();
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new FixtureError("upstream_not_ready"));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new FixtureError("upstream_not_ready"));
          }
        });
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => reject(new FixtureError("upstream_not_ready")));
    request.end();
  });
}

async function waitFor(label, probe, runtime, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime?.spawnFailed || runtime?.child.exitCode !== null) {
      throw new FixtureError(`${label}_exited`);
    }
    try {
      if (await probe()) return;
    } catch {
      // The bounded fixture dependency is still converging.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new FixtureError(`${label}_timeout`);
}

async function waitForHttp(url, runtime) {
  await waitFor(
    "runtime",
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    },
    runtime,
    120_000,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.skipBuild) {
    await runCommand("pnpm", ["build"], {
      failureCategory: "application_build_failed",
      visible: true,
    });
  }

  const fixtureDirectory = mkdtempSync(join(tmpdir(), "omnifin-authentik-"));
  const environmentFile = join(fixtureDirectory, "fixture.env");
  const databaseFile = join(fixtureDirectory, "omnifin.db");
  const project = `omnifin-authentik-${process.pid}`;
  const runtimes = [];
  let composeStarted = false;

  try {
    const host = selectPrivateHost();
    const [webPort, gatewayPort, webTlsPort, authentikHttpPort, authentikTlsPort] =
      await Promise.all([
        reservePort("127.0.0.1"),
        reservePort("127.0.0.1"),
        reservePort("0.0.0.0"),
        reservePort("127.0.0.1"),
        reservePort("0.0.0.0"),
      ]);
    const webOrigin = `https://${host}:${webTlsPort}`;
    const authentikOrigin = `https://${host}:${authentikTlsPort}`;
    const issuer = `${authentikOrigin}/application/o/omnifin/`;
    const certificates = await generateCertificate(fixtureDirectory, host);
    const secrets = {
      authentikPassword: secureToken(36),
      authentikSecretKey: secureToken(60),
      authentikToken: secureToken(36),
      clientSecret: secureToken(36),
      encryptionKey: randomBytes(32).toString("base64"),
      postgresPassword: secureToken(36),
      recoverySecret: randomBytes(48).toString("base64"),
    };
    const clientId = `omnifin-${secureToken(12)}`;
    const environment = {
      OMNIFIN_AUTHENTIK_BACKCHANNEL_URL: `${webOrigin}/api/auth/oidc/backchannel/oidc-authentik`,
      OMNIFIN_AUTHENTIK_BOOTSTRAP_PASSWORD_HASH: "pending-password-hash",
      OMNIFIN_AUTHENTIK_BOOTSTRAP_TOKEN: secrets.authentikToken,
      OMNIFIN_AUTHENTIK_CALLBACK_URL: `${webOrigin}/api/auth/oidc/callback/oidc-authentik`,
      OMNIFIN_AUTHENTIK_CA_FILE: certificates.caCertificate,
      OMNIFIN_AUTHENTIK_CLIENT_ID: clientId,
      OMNIFIN_AUTHENTIK_CLIENT_SECRET: secrets.clientSecret,
      OMNIFIN_AUTHENTIK_HTTP_PORT: String(authentikHttpPort),
      OMNIFIN_AUTHENTIK_LOGOUT_REDIRECT_URL: `${webOrigin}/login?loggedOut=1`,
      OMNIFIN_AUTHENTIK_POSTGRES_PASSWORD: secrets.postgresPassword,
      OMNIFIN_AUTHENTIK_SECRET_KEY: secrets.authentikSecretKey,
    };
    writePrivateFile(environmentFile, dotenv(environment));

    const hashExecution = await runCommand(
      "docker",
      composeArguments(
        project,
        environmentFile,
        "run",
        "--rm",
        "--no-deps",
        "server",
        "hash_password",
        secrets.authentikPassword,
      ),
      { failureCategory: "password_hash_generation_failed" },
    );
    const passwordHash = parsePasswordHash(hashExecution.stdout);
    writePrivateFile(
      environmentFile,
      dotenv({ ...environment, OMNIFIN_AUTHENTIK_BOOTSTRAP_PASSWORD_HASH: passwordHash }),
    );

    const proxy = spawnRuntime("node", [proxyScript], {
      OMNIFIN_FIXTURE_AUTHENTIK_TLS_PORT: String(authentikTlsPort),
      OMNIFIN_FIXTURE_AUTHENTIK_UPSTREAM_PORT: String(authentikHttpPort),
      OMNIFIN_FIXTURE_TLS_CERT: certificates.serverCertificate,
      OMNIFIN_FIXTURE_TLS_KEY: certificates.serverKey,
      OMNIFIN_FIXTURE_WEB_TLS_PORT: String(webTlsPort),
      OMNIFIN_FIXTURE_WEB_UPSTREAM_PORT: String(webPort),
    });
    runtimes.push(proxy);
    await waitFor(
      "tls_proxy",
      async () => proxy.stdout.includes("fixture_tls_ready"),
      proxy,
      30_000,
    );

    composeStarted = true;
    await runCommand(
      "docker",
      composeArguments(project, environmentFile, "up", "--detach", "--remove-orphans"),
      { failureCategory: "authentik_start_failed" },
    );

    await waitFor(
      "authentik",
      async () => {
        const discovery = await trustedJson(
          `${issuer}.well-known/openid-configuration`,
          certificates.caCertificate,
        );
        return (
          discovery.issuer === issuer &&
          discovery.backchannel_logout_supported === true &&
          discovery.end_session_endpoint &&
          discovery.code_challenge_methods_supported?.includes("S256")
        );
      },
      proxy,
    );

    const gateway = spawnRuntime("node", ["apps/gateway/dist/main.js"], {
      NODE_ENV: "production",
      NODE_EXTRA_CA_CERTS: certificates.caCertificate,
      OMNIFIN_BASE_URL: webOrigin,
      OMNIFIN_DATABASE_URL: databaseFile,
      OMNIFIN_ENCRYPTION_KEY: secrets.encryptionKey,
      OMNIFIN_HOST: "127.0.0.1",
      OMNIFIN_LOG_LEVEL: "info",
      OMNIFIN_PORT: String(gatewayPort),
      OMNIFIN_RECOVERY_SECRET: secrets.recoverySecret,
      OMNIFIN_SECURE_COOKIES: "true",
      OMNIFIN_TRUST_PROXY_HOPS: "1",
    });
    runtimes.push(gateway);
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/readyz`, gateway);

    const web = spawnRuntime(
      "pnpm",
      [
        "--filter",
        "@omnifin/web",
        "exec",
        "next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        OMNIFIN_BASE_URL: webOrigin,
        OMNIFIN_DEMO_MODE: "false",
        OMNIFIN_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
        OMNIFIN_TEST_MODE: "false",
        OMNIFIN_WEB_TRUST_PROXY_HOPS: "1",
        PORT: String(webPort),
      },
    );
    runtimes.push(web);
    await waitFor(
      "web",
      async () => {
        const health = await trustedJson(`${webOrigin}/healthz`, certificates.caCertificate);
        return health.status === "ok";
      },
      web,
      120_000,
    );

    const browser = await runCommand("node", [browserScript], {
      env: {
        OMNIFIN_FIXTURE_AUTHENTIK_ISSUER: issuer,
        OMNIFIN_FIXTURE_AUTHENTIK_PASSWORD: secrets.authentikPassword,
        OMNIFIN_FIXTURE_AUTHENTIK_TOKEN: secrets.authentikToken,
        OMNIFIN_FIXTURE_CLIENT_ID: clientId,
        OMNIFIN_FIXTURE_CLIENT_SECRET: secrets.clientSecret,
        OMNIFIN_FIXTURE_RECOVERY_SECRET: secrets.recoverySecret,
        OMNIFIN_FIXTURE_WEB_ORIGIN: webOrigin,
      },
      failureCategory: "browser_flow_failed",
    });
    if (!browser.stdout.includes("authentik_browser_checks_passed")) {
      throw new FixtureError("browser_flow_failed");
    }

    const runtimeLogs = runtimes.flatMap((runtime) => [runtime.stdout, runtime.stderr]);
    if (secretLeakDetected(runtimeLogs, [...Object.values(secrets), passwordHash])) {
      throw new FixtureError("secret_leak_detected");
    }

    const report = reportFor(authentikFixture.checks);
    if (isAbsolute(options.output)) throw new FixtureError("output_path_invalid");
    const outputPath = resolve(root, options.output);
    if (relative(root, outputPath).startsWith("..")) {
      throw new FixtureError("output_path_invalid");
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writePrivateFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    for (const runtime of [...runtimes].reverse()) await stopRuntime(runtime);
    if (composeStarted) {
      await runCommand(
        "docker",
        composeArguments(project, environmentFile, "down", "--volumes", "--remove-orphans"),
        { failureCategory: "authentik_teardown_failed" },
      ).catch(() => undefined);
    }
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
}

try {
  await main();
} catch (error) {
  const category = error instanceof FixtureError ? error.category : "fixture_failed";
  process.stderr.write(`${JSON.stringify({ category, event: "authentik_fixture_failed" })}\n`);
  process.exitCode = 1;
}
