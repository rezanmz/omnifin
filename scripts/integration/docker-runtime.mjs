import { spawnSync } from "node:child_process";

export const DOCKER_IMAGE_PULL_ATTEMPTS = 3;
export const DOCKER_IMAGE_PULL_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);
export const DOCKER_LOCAL_IMAGE_ARGUMENTS = Object.freeze(["--pull", "never"]);

const PINNED_IMAGE_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/u;
const PERMANENT_PULL_PATTERNS = Object.freeze([
  /(?:access forbidden|authentication required|insufficient_scope|unauthorized)/iu,
  /(?:denied|requested access to the resource is denied)/iu,
  /(?:manifest unknown|manifest_unknown|name unknown|name_unknown)/iu,
  /(?:no matching manifest|unsupported media type)/iu,
  /(?:not found|repository does not exist)/iu,
]);
const TRANSIENT_PULL_PATTERNS = Object.freeze([
  /(?:context deadline exceeded|request canceled while waiting for connection)/iu,
  /(?:connection refused|connection reset by peer|connection timed out)/iu,
  /(?:i\/o timeout|tls handshake timeout|temporary failure in name resolution)/iu,
  /(?:no such host|network is unreachable|unexpected eof)/iu,
  /(?:status(?: code)?[^0-9]{0,8}(?:429|500|502|503|504))\b/iu,
  /(?:too many requests|toomanyrequests|service unavailable)/iu,
]);
const TRANSIENT_EXECUTION_ERROR_CODES = new Set(["EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"]);

export class DockerImagePullError extends Error {
  constructor(code) {
    super(code);
    this.name = "DockerImagePullError";
    this.code = code;
  }
}

function boundedDiagnostic(execution) {
  return `${execution?.stdout ?? ""}\n${execution?.stderr ?? ""}`.slice(-65_536);
}

export function classifyDockerImagePullFailure(execution) {
  const errorCode = execution?.error?.code;
  if (typeof errorCode === "string" && TRANSIENT_EXECUTION_ERROR_CODES.has(errorCode)) {
    return "transient";
  }

  const diagnostic = boundedDiagnostic(execution);
  if (PERMANENT_PULL_PATTERNS.some((pattern) => pattern.test(diagnostic))) return "permanent";
  if (TRANSIENT_PULL_PATTERNS.some((pattern) => pattern.test(diagnostic))) return "transient";
  return "permanent";
}

function defaultExecute(arguments_, timeout) {
  return spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 2 * 1_024 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function defaultWait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function acquirePinnedDockerImage(
  image,
  {
    attempts = DOCKER_IMAGE_PULL_ATTEMPTS,
    execute = defaultExecute,
    retryDelaysMs = DOCKER_IMAGE_PULL_RETRY_DELAYS_MS,
    timeout = 120_000,
    wait = defaultWait,
  } = {},
) {
  if (!PINNED_IMAGE_PATTERN.test(image)) {
    throw new DockerImagePullError("image_reference_invalid");
  }
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > DOCKER_IMAGE_PULL_ATTEMPTS ||
    !Array.isArray(retryDelaysMs) ||
    retryDelaysMs.length < attempts - 1 ||
    retryDelaysMs
      .slice(0, attempts - 1)
      .some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 30_000) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 180_000 ||
    typeof execute !== "function" ||
    typeof wait !== "function"
  ) {
    throw new DockerImagePullError("image_pull_policy_invalid");
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const execution = execute(["pull", "--quiet", image], timeout);
    if (execution?.status === 0 && !execution.error) return { attempts: attempt + 1 };

    const classification = classifyDockerImagePullFailure(execution);
    if (classification !== "transient") {
      throw new DockerImagePullError("image_pull_failed");
    }
    if (attempt === attempts - 1) {
      throw new DockerImagePullError("image_pull_transient_exhausted");
    }

    const retryDelayMs = retryDelaysMs[attempt];
    await wait(retryDelayMs);
  }

  throw new DockerImagePullError("image_pull_transient_exhausted");
}
