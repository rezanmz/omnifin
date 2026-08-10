import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultAttempts = 3;
const retryFloorsMs = [60_000, 120_000];
const retryJitterMs = 30_000;

const notFoundDiagnostic =
  /not found|manifest[_ ]unknown|name[_ ]unknown|(?:HTTP|status(?: code)?|code)\s*[:=]?\s*404\b/iu;
const throttledDiagnostic =
  /secondary rate limit|too many requests|TOOMANYREQUESTS|(?:HTTP|status(?: code)?|code)\s*[:=]?\s*429\b/iu;
const authorizationDiagnostic =
  /\b403\b|permission_denied|forbidden|unauthorized|insufficient_scope/iu;

export function candidateReference(imageName, candidateTag) {
  if (
    typeof imageName !== "string" ||
    !imageName.startsWith("ghcr.io/") ||
    imageName !== imageName.toLowerCase() ||
    imageName.includes("//") ||
    /\s|@|:/u.test(imageName)
  ) {
    throw new Error("IMAGE_NAME must be a lowercase GHCR repository name.");
  }
  if (
    typeof candidateTag !== "string" ||
    !/^edge-candidate-[0-9a-f]{40}-[1-9][0-9]*$/u.test(candidateTag)
  ) {
    throw new Error("CANDIDATE_TAG must identify one immutable edge run.");
  }
  return `${imageName}:${candidateTag}`;
}

function immutableDigest(value, name) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value ?? "")) {
    throw new Error(`${name} must be an immutable sha256 digest.`);
  }
  return value;
}

function commandDiagnostic(result) {
  if (result instanceof Error) {
    return [result.message, result.stderr, result.stdout].filter(Boolean).join(" ");
  }
  return [result?.message, result?.stderr, result?.stdout, result?.status, result?.code]
    .filter((value) => value !== undefined && value !== null)
    .join(" ");
}

function statusOf(result) {
  if (typeof result === "number") return result;
  return result?.status ?? result?.exitCode ?? result?.code ?? 1;
}

function outputOf(result, stream) {
  const value = result?.[stream] ?? "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function commandFailed(result, operation) {
  const error = new Error(`ORAS ${operation} failed.`);
  error.diagnostic = commandDiagnostic(result);
  if (statusOf(result) === 429) error.diagnostic += " status=429";
  error.throttled = throttledDiagnostic.test(error.diagnostic);
  error.notFound = notFoundDiagnostic.test(error.diagnostic);
  error.authorization = authorizationDiagnostic.test(error.diagnostic);
  return error;
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function runOras(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("oras", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolvePromise({ status: status ?? 1, signal, stdout, stderr });
    });
  });
}

export function retryDelay(attempt, random = Math.random) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Retry attempt must be a positive integer.");
  }
  const floor = retryFloorsMs[Math.min(attempt - 1, retryFloorsMs.length - 1)];
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error("Retry randomness must be between zero and one.");
  }
  return floor + Math.floor(sample * retryJitterMs);
}

export function isExplicitThrottleDiagnostic(diagnostic) {
  return throttledDiagnostic.test(String(diagnostic ?? ""));
}

export async function publishOciCandidate(
  { imageName, candidateTag, archive, buildDigest, attempts = defaultAttempts },
  { run = runOras, sleep = wait, random = Math.random, write = () => {} } = {},
) {
  const destination = candidateReference(imageName, candidateTag);
  const expectedDigest = immutableDigest(buildDigest, "BUILD_DIGEST");
  if (typeof archive !== "string" || archive.length === 0 || /\s/u.test(archive)) {
    throw new Error("OCI_ARCHIVE must identify the fixed local OCI archive.");
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > defaultAttempts) {
    throw new Error("Publication attempts must be an integer between 1 and 3.");
  }

  const source = `${archive}:${candidateTag}`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const resolved = await run(["resolve", destination]);
      const status = statusOf(resolved);
      if (status === 0) {
        const remoteDigest = immutableDigest(outputOf(resolved, "stdout").trim(), "Remote digest");
        if (remoteDigest !== expectedDigest) {
          throw new Error("Existing edge candidate tag points to a different digest.");
        }
        write(`[oci-publish] attempt=${attempt}/${attempts} result=already-published`);
        return remoteDigest;
      }

      const failure = commandFailed(resolved, "resolve");
      if (!failure.notFound || failure.authorization || failure.throttled) throw failure;

      const copied = await run(["cp", "--from-oci-layout", source, destination]);
      if (statusOf(copied) !== 0) throw commandFailed(copied, "copy");

      const verified = await run(["resolve", destination]);
      if (statusOf(verified) !== 0) throw commandFailed(verified, "verification resolve");
      const remoteDigest = immutableDigest(outputOf(verified, "stdout").trim(), "Remote digest");
      if (remoteDigest !== expectedDigest) {
        throw new Error("Published edge candidate digest differs from the built OCI archive.");
      }
      write(`[oci-publish] attempt=${attempt}/${attempts} result=published`);
      return remoteDigest;
    } catch (error) {
      const diagnostic = error?.diagnostic ?? commandDiagnostic(error);
      if (!isExplicitThrottleDiagnostic(diagnostic)) throw error;
      if (attempt === attempts) break;

      const delay = retryDelay(attempt, random);
      write(`[oci-publish] attempt=${attempt}/${attempts} result=throttled retry_in_ms=${delay}`);
      await sleep(delay);
    }
  }

  throw new Error(
    `OCI candidate publication failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function main() {
  const digest = await publishOciCandidate(
    {
      archive: requiredEnvironment("OCI_ARCHIVE"),
      buildDigest: requiredEnvironment("BUILD_DIGEST"),
      candidateTag: requiredEnvironment("CANDIDATE_TAG"),
      imageName: requiredEnvironment("IMAGE_NAME"),
    },
    { write: (message) => console.error(message) },
  );
  appendFileSync(requiredEnvironment("GITHUB_OUTPUT"), `digest=${digest}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
