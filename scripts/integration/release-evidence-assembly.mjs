import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STABLE_ARCHITECTURES,
  V1_TIER_REQUIREMENTS,
  validateV1EvidenceIndex,
} from "./release-evidence.mjs";
import { validateHomeLabEvidence } from "./home-lab-evidence.mjs";

const REQUIRED_OPTIONS = Object.freeze([
  "--candidate-digest",
  "--input-directory",
  "--output-directory",
  "--release-tag",
  "--repository",
  "--run-id",
  "--source-sha",
  "--verified-at",
]);

const sourceShaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const runIdPattern = /^[1-9]\d{0,18}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

export const V1_EVIDENCE_INPUTS = Object.freeze({
  1: Object.freeze(["fixture.json"]),
  2: Object.freeze(["live.json"]),
  3: Object.freeze(["scan-linux-amd64.sarif", "scan-linux-arm64.sarif"]),
  4: Object.freeze(["install.json", "upgrade.json", "home-lab.json"]),
});

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireExact(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function evidenceUrl(repository, releaseTag, name) {
  return `https://github.com/${repository}/releases/download/${releaseTag}/${name}`;
}

function validateInputFiles(inputFiles) {
  if (!inputFiles || typeof inputFiles !== "object" || Array.isArray(inputFiles)) {
    throw new Error("Evidence inputs must be a record.");
  }
  const expected = Object.values(V1_EVIDENCE_INPUTS).flat();
  if (Object.keys(inputFiles).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error("Evidence inputs must contain every required candidate-gate artifact.");
  }
  for (const [name, value] of Object.entries(inputFiles)) {
    if (typeof value !== "string" || basename(value) !== name) {
      throw new Error("Evidence input paths must retain their approved basename.");
    }
  }
  return inputFiles;
}

export async function assembleV1Evidence(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Evidence assembly options are invalid.");
  }
  const sourceSha = requireExact(options.sourceSha, sourceShaPattern, "sourceSha");
  const candidateDigest = requireExact(options.candidateDigest, digestPattern, "candidateDigest");
  const repository = requireExact(options.repository, repositoryPattern, "repository");
  const releaseTag = requireExact(options.releaseTag, tagPattern, "releaseTag");
  const runId = requireExact(options.runId, runIdPattern, "runId");
  const verifiedAt = requireExact(options.verifiedAt, datePattern, "verifiedAt");
  const inputFiles = validateInputFiles(options.inputFiles);
  const outputDirectory = resolve(options.outputDirectory);

  const inputs = {};
  let homeLabEvidence;
  for (const [name, path] of Object.entries(inputFiles)) {
    const data = await readFile(resolve(path));
    if (data.length === 0) throw new Error(`Evidence input ${name} is empty.`);
    if (name === "home-lab.json") {
      let decoded;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new Error("Home-lab evidence must be valid UTF-8.");
      }
      let report;
      try {
        report = JSON.parse(decoded);
      } catch {
        throw new Error("Home-lab evidence must be valid JSON.");
      }
      homeLabEvidence = validateHomeLabEvidence(report, {
        candidateDigest,
        sourceSha,
        today: verifiedAt,
      });
    }
    inputs[name] = checksum(data);
  }

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const records = [];
  for (const tier of [1, 2, 3, 4]) {
    const artifactName = `v1-evidence-tier-${tier}-${runId}.json`;
    const artifact = {
      candidateDigest,
      inputs: V1_EVIDENCE_INPUTS[tier].map((name) => ({ name, sha256: inputs[name] })),
      schemaVersion: 1,
      sourceSha,
      tier,
    };
    const artifactData = `${JSON.stringify(artifact, null, 2)}\n`;
    await writeFile(resolve(outputDirectory, artifactName), artifactData, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    const tierFour = tier === 4;
    records.push({
      architectures:
        tier === 3
          ? [...STABLE_ARCHITECTURES]
          : tierFour
            ? [homeLabEvidence.architecture]
            : ["linux/amd64"],
      artifact: {
        sha256: checksum(artifactData),
        url: evidenceUrl(repository, releaseTag, artifactName),
      },
      candidateDigest,
      claim: V1_TIER_REQUIREMENTS[tier].claim,
      coverage: [...V1_TIER_REQUIREMENTS[tier].coverage],
      expiresAt: tierFour ? homeLabEvidence.expiresAt : verifiedAt,
      limitations: "Sanitized diagnostics exclude secrets and host paths.",
      owner: tierFour ? homeLabEvidence.owner : "release-maintainer",
      result: "passed",
      sourceSha,
      tier,
      upstream: tierFour ? homeLabEvidence.upstream : { fixtureRevision: sourceSha },
      verifiedAt: tierFour ? homeLabEvidence.verifiedAt : verifiedAt,
    });
  }
  const index = validateV1EvidenceIndex(
    { candidateDigest, records, schemaVersion: 1, sourceSha },
    { candidateDigest, sourceSha, today: verifiedAt },
  );
  await writeFile(resolve(outputDirectory, "index.json"), `${JSON.stringify(index, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  return index;
}

function commandOptions(arguments_) {
  if (arguments_.length !== REQUIRED_OPTIONS.length * 2) {
    throw new Error("Candidate evidence assembly requires every named option exactly once.");
  }
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!REQUIRED_OPTIONS.includes(name) || !value || value.startsWith("--") || options.has(name)) {
      throw new Error("Candidate evidence assembly requires every named option exactly once.");
    }
    options.set(name, value);
  }
  if (options.size !== REQUIRED_OPTIONS.length) {
    throw new Error("Candidate evidence assembly requires every named option exactly once.");
  }
  const inputDirectory = resolve(options.get("--input-directory"));
  return {
    candidateDigest: options.get("--candidate-digest"),
    inputFiles: Object.fromEntries(
      Object.values(V1_EVIDENCE_INPUTS)
        .flat()
        .map((name) => [name, join(inputDirectory, name)]),
    ),
    outputDirectory: options.get("--output-directory"),
    releaseTag: options.get("--release-tag"),
    repository: options.get("--repository"),
    runId: options.get("--run-id"),
    sourceSha: options.get("--source-sha"),
    verifiedAt: options.get("--verified-at"),
  };
}

async function main() {
  const index = await assembleV1Evidence(commandOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(index)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "candidate_evidence_assembly_invalid"}\n`,
    );
    process.exitCode = 1;
  }
}
