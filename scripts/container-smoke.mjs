#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIAGNOSTIC_LOG_LINES = 60;
const DIAGNOSTIC_LOG_CHARACTERS = 12_000;
const DIAGNOSTIC_ERROR_CHARACTERS = 4_000;
const DIAGNOSTIC_DOCKER_TIMEOUT = 5_000;
const DIAGNOSTIC_DOCKER_MAX_BUFFER = 512 * 1_024;
const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

const secretAssignmentPattern =
  /((?:["'])?[\w-]*(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)[\w-]*(?:["'])?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|Bearer\s+[^\s,;}\]]+|[^\s,;}\]]+)/giu;
const bearerPattern = /\bBearer\s+[a-z0-9._~+/-]+=*/giu;
const ansiEscapePattern = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

function usage() {
  return [
    "Usage: node scripts/container-smoke.mjs (--image <reference> | --build)",
    "",
    "  --image <reference>  Test an existing tag or immutable digest",
    "  --build              Build and test the repository Dockerfile locally",
  ].join("\n");
}

function parseArguments(arguments_) {
  const options = { build: false, image: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--build") options.build = true;
    else if (argument === "--image") options.image = arguments_[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.build === Boolean(options.image)) {
    throw new Error("Select exactly one of --build or --image.");
  }
  return options;
}

class SmokeFailure extends Error {
  constructor(operation, commandFailure) {
    super(operation);
    this.name = "SmokeFailure";
    this.operation = operation;
    this.commandFailure = commandFailure;
  }
}

function replaceAllLiteral(value, search, replacement) {
  return search ? value.split(search).join(replacement) : value;
}

export function redactDiagnosticText(value, context = {}) {
  let redacted = String(value ?? "")
    .replace(ansiEscapePattern, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");

  const secrets = [...new Set(context.secretValues ?? [])]
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  const paths = [...new Set(context.sensitivePaths ?? [])]
    .filter((path) => typeof path === "string" && path.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const secret of secrets) {
    redacted = replaceAllLiteral(redacted, secret, "[REDACTED]");
  }
  for (const path of paths) {
    redacted = replaceAllLiteral(redacted, path, "[REDACTED_PATH]");
  }

  return redacted
    .replace(secretAssignmentPattern, '$1"[REDACTED]"')
    .replace(bearerPattern, "Bearer [REDACTED]");
}

export function boundDiagnosticTail(value, options = {}) {
  const maxLines = options.maxLines ?? DIAGNOSTIC_LOG_LINES;
  const maxCharacters = options.maxCharacters ?? DIAGNOSTIC_LOG_CHARACTERS;
  if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new TypeError("maxLines must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) {
    throw new TypeError("maxCharacters must be a safe integer of at least 32.");
  }

  const tailed = String(value ?? "")
    .trimEnd()
    .split("\n")
    .slice(-maxLines)
    .join("\n");
  if (tailed.length <= maxCharacters) return tailed;

  const marker = "[diagnostic truncated]\n";
  return `${marker}${tailed.slice(-(maxCharacters - marker.length))}`;
}

function captureCommandFailure(error) {
  return {
    code:
      typeof error?.code === "string" || typeof error?.code === "number"
        ? String(error.code)
        : null,
    exitCode: Number.isSafeInteger(error?.status) ? error.status : null,
    signal: typeof error?.signal === "string" ? error.signal : null,
    stderr:
      typeof error?.stderr === "string" || Buffer.isBuffer(error?.stderr)
        ? String(error.stderr)
        : "",
  };
}

function sanitizeCommandFailure(failure, context) {
  if (!failure) return null;
  return {
    code: failure.code,
    exitCode: failure.exitCode,
    signal: failure.signal,
    stderr: boundDiagnosticTail(redactDiagnosticText(failure.stderr, context), {
      maxLines: DIAGNOSTIC_LOG_LINES,
      maxCharacters: DIAGNOSTIC_ERROR_CHARACTERS,
    }),
  };
}

function docker(arguments_, operation, options = {}) {
  try {
    return execFileSync("docker", arguments_, {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1_024 * 1_024,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 120_000,
    })?.trim();
  } catch (error) {
    throw new SmokeFailure(operation, captureCommandFailure(error));
  }
}

function diagnosticDocker(arguments_) {
  try {
    return {
      ok: true,
      stdout: execFileSync("docker", arguments_, {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        maxBuffer: DIAGNOSTIC_DOCKER_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DIAGNOSTIC_DOCKER_TIMEOUT,
      }).trim(),
    };
  } catch (error) {
    return { ok: false, failure: captureCommandFailure(error) };
  }
}

function selectedContainerState(rawState, context) {
  const state = JSON.parse(rawState);
  const selected = {
    status: typeof state.Status === "string" ? state.Status : "unknown",
    running: state.Running === true,
    exitCode: Number.isSafeInteger(state.ExitCode) ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    health:
      state.Health && typeof state.Health === "object"
        ? {
            status: typeof state.Health.Status === "string" ? state.Health.Status : "unknown",
            failingStreak: Number.isSafeInteger(state.Health.FailingStreak)
              ? state.Health.FailingStreak
              : null,
          }
        : null,
  };
  const stateError = boundDiagnosticTail(redactDiagnosticText(state.Error, context), {
    maxLines: 10,
    maxCharacters: 1_000,
  });
  if (stateError) selected.error = stateError;
  return selected;
}

export function collectContainerDiagnostics(containers, context = {}, execute = diagnosticDocker) {
  return containers.map(({ component, name }) => {
    const stateResult = execute(["container", "inspect", "--format", "{{json .State}}", name]);
    const logsResult = execute(["container", "logs", "--tail", String(DIAGNOSTIC_LOG_LINES), name]);
    const diagnostic = { component };

    if (stateResult.ok) {
      try {
        diagnostic.state = selectedContainerState(stateResult.stdout, context);
      } catch {
        diagnostic.state = { status: "diagnostic_unavailable" };
      }
    } else {
      diagnostic.state = { status: "diagnostic_unavailable" };
      diagnostic.stateError = sanitizeCommandFailure(stateResult.failure, context);
    }

    if (logsResult.ok) {
      diagnostic.logs = boundDiagnosticTail(redactDiagnosticText(logsResult.stdout, context), {
        maxLines: DIAGNOSTIC_LOG_LINES,
        maxCharacters: DIAGNOSTIC_LOG_CHARACTERS,
      });
    } else {
      diagnostic.logs = "";
      diagnostic.logsError = sanitizeCommandFailure(logsResult.failure, context);
    }

    return diagnostic;
  });
}

export function createFailureReport(error, containers, context = {}, execute = diagnosticDocker) {
  return {
    status: "failed",
    errorCategory: error?.operation ?? "smoke_runner_error",
    command: sanitizeCommandFailure(error?.commandFailure, context),
    containers: collectContainerDiagnostics(containers, context, execute),
  };
}

async function waitForHealthy(container, operation) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = docker(
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        container,
      ],
      operation,
    );
    if (state === "healthy") return;
    if (state === "unhealthy" || state === "none") throw new SmokeFailure(operation);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new SmokeFailure(operation);
}

function inContainerRequest(container, url, operation) {
  const source = [
    `const response = await fetch(${JSON.stringify(url)}, { redirect: "error" });`,
    "if (!response.ok) process.exit(1);",
    "const body = await response.json();",
    "if (!body || typeof body !== 'object') process.exit(1);",
  ].join("");
  docker(["exec", container, "node", "--input-type=module", "--eval", source], operation);
}

function inContainerProvidersRequest(container, url, operation) {
  const source = [
    `const response = await fetch(${JSON.stringify(url)}, { redirect: "error" });`,
    "if (!response.ok) process.exit(1);",
    "const body = await response.json();",
    "if (!body || !Array.isArray(body.providers)) process.exit(1);",
  ].join("");
  docker(["exec", container, "node", "--input-type=module", "--eval", source], operation);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 64;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const network = `omnifin-smoke-network-${suffix}`;
  const volume = `omnifin-smoke-data-${suffix}`;
  const gateway = `omnifin-smoke-gateway-${suffix}`;
  const web = `omnifin-smoke-web-${suffix}`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omnifin-smoke-"));
  const encryptionFile = join(temporaryDirectory, "encryption-key");
  const recoveryFile = join(temporaryDirectory, "recovery-secret");
  const image = options.build ? `omnifin:smoke-${suffix}` : options.image;
  const containers = [];
  let encryptionSecret = "";
  let recoverySecret = "";
  let networkCreated = false;
  let volumeCreated = false;

  try {
    if (options.build) {
      docker(["build", "--tag", image, "."], "image_build", { inherit: true, timeout: 900_000 });
    }
    docker(["image", "inspect", image], "image_inspection");
    const runtimeUser = docker(
      ["image", "inspect", "--format", "{{.Config.User}}", image],
      "image_user_inspection",
    );
    if (runtimeUser !== "65532:65532") throw new SmokeFailure("image_user");
    const runtimeEntrypoint = docker(
      ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", image],
      "image_entrypoint_inspection",
    );
    if (runtimeEntrypoint !== '["/nodejs/bin/node","/opt/omnifin/bin/entrypoint.mjs"]') {
      throw new SmokeFailure("image_entrypoint");
    }

    // Bind-mounted smoke secrets are read-only and world-readable only inside a
    // private 0700 temporary directory so the rootless container UID can read them.
    encryptionSecret = randomBytes(32).toString("base64");
    recoverySecret = randomBytes(48).toString("base64");
    await writeFile(encryptionFile, encryptionSecret, { mode: 0o444 });
    await writeFile(recoveryFile, recoverySecret, { mode: 0o444 });

    docker(["network", "create", network], "network_create");
    networkCreated = true;
    docker(["volume", "create", volume], "volume_create");
    volumeCreated = true;

    docker(
      [
        "run",
        "--detach",
        "--name",
        gateway,
        "--network",
        network,
        "--network-alias",
        "gateway",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
        "--volume",
        `${volume}:/data`,
        "--volume",
        `${encryptionFile}:/run/secrets/omnifin_encryption_key:ro`,
        "--volume",
        `${recoveryFile}:/run/secrets/omnifin_recovery_secret:ro`,
        "--env",
        "NODE_ENV=production",
        "--env",
        "OMNIFIN_BASE_URL=https://omnifin.example",
        "--env",
        "OMNIFIN_DATABASE_URL=/data/omnifin.db",
        "--env",
        "OMNIFIN_ENCRYPTION_KEY_FILE=/run/secrets/omnifin_encryption_key",
        "--env",
        "OMNIFIN_RECOVERY_SECRET_FILE=/run/secrets/omnifin_recovery_secret",
        "--env",
        "OMNIFIN_SECURE_COOKIES=true",
        image,
        "gateway",
      ],
      "gateway_start",
    );
    containers.push({ component: "gateway", name: gateway });
    await waitForHealthy(gateway, "gateway_health");
    inContainerRequest(gateway, "http://127.0.0.1:4000/readyz", "gateway_readiness");
    inContainerProvidersRequest(gateway, "http://127.0.0.1:4000/v1/auth/providers", "gateway_api");

    docker(
      [
        "run",
        "--detach",
        "--name",
        web,
        "--network",
        network,
        "--network-alias",
        "web",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
        "--tmpfs",
        "/opt/omnifin/web/.next/cache:rw,noexec,nosuid,size=256m,uid=65532,gid=65532,mode=0700",
        "--tmpfs",
        "/opt/omnifin/web/apps/web/.next/cache:rw,noexec,nosuid,size=256m,uid=65532,gid=65532,mode=0700",
        "--health-interval",
        "5s",
        "--health-timeout",
        "5s",
        "--health-start-period",
        "10s",
        "--health-retries",
        "10",
        "--env",
        "OMNIFIN_GATEWAY_URL=http://gateway:4000",
        image,
        "web",
      ],
      "web_start",
    );
    containers.push({ component: "web", name: web });
    await waitForHealthy(web, "web_health");
    inContainerRequest(web, "http://127.0.0.1:3000/healthz", "web_api");
    inContainerProvidersRequest(
      web,
      "http://127.0.0.1:3000/api/auth/providers",
      "web_gateway_proxy",
    );

    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        checks: [
          "rootless_runtime",
          "shell_free_entrypoint",
          "gateway_health",
          "gateway_readiness",
          "gateway_api",
          "web_health",
          "web_gateway_proxy",
        ],
      })}\n`,
    );
    return 0;
  } catch (error) {
    const context = {
      secretValues: [encryptionSecret, recoverySecret],
      sensitivePaths: [temporaryDirectory, REPOSITORY_ROOT],
    };
    process.stderr.write(`${JSON.stringify(createFailureReport(error, containers, context))}\n`);
    return 1;
  } finally {
    for (const container of containers.reverse()) {
      try {
        docker(["container", "rm", "--force", container.name], "cleanup_container");
      } catch {
        // Cleanup is best effort and targets only names allocated by this process.
      }
    }
    if (networkCreated) {
      try {
        docker(["network", "rm", network], "cleanup_network");
      } catch {
        // The unique network can be removed manually if Docker is interrupted.
      }
    }
    if (volumeCreated) {
      try {
        docker(["volume", "rm", volume], "cleanup_volume");
      } catch {
        // The unique smoke-test volume contains no user data.
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) process.exitCode = await main();
