import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultAttempts = 3;
const defaultBackoffMs = [5_000, 15_000];

export function ociImageReference(imageName, imageDigest) {
  if (
    typeof imageName !== "string" ||
    !imageName.startsWith("ghcr.io/") ||
    imageName !== imageName.toLowerCase() ||
    imageName.includes("//") ||
    /\s|@/u.test(imageName)
  ) {
    throw new Error("IMAGE_NAME must be a lowercase GHCR repository name.");
  }

  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest ?? "")) {
    throw new Error("IMAGE_DIGEST must be an immutable sha256 digest.");
  }

  return `${imageName}@${imageDigest}`;
}

function runCosign(reference) {
  return new Promise((resolve, reject) => {
    const child = spawn("cosign", ["sign", "--yes", reference], {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Cosign terminated with signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function signOciImage(
  reference,
  {
    attempts = defaultAttempts,
    backoffMs = defaultBackoffMs,
    run = runCosign,
    sleep = wait,
    write = console.error,
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("Signing attempts must be an integer between 1 and 5.");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let exitCode = 1;
    try {
      exitCode = await run(reference);
    } catch (error) {
      write(
        `[oci-sign] attempt=${attempt}/${attempts} result=error reason=${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }

    if (exitCode === 0) {
      write(`[oci-sign] attempt=${attempt}/${attempts} result=success`);
      return;
    }

    if (attempt === attempts) break;
    const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 15_000;
    write(`[oci-sign] attempt=${attempt}/${attempts} result=failed retry_in_ms=${delay}`);
    await sleep(delay);
  }

  throw new Error(`OCI signing failed after ${attempts} bounded attempts.`);
}

async function main() {
  const reference = ociImageReference(process.env.IMAGE_NAME, process.env.IMAGE_DIGEST);
  await signOciImage(reference);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
