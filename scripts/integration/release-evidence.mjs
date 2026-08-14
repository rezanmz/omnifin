import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceShaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const checksumPattern = /^[0-9a-f]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const resultValues = new Set(["passed"]);
const tierValues = new Set([1, 2, 3, 4]);

export const STABLE_ARCHITECTURES = Object.freeze(["linux/amd64", "linux/arm64"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function requireString(value, label, maximum = 512) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value;
}

function requireDate(value, label) {
  if (!datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be an ISO calendar date.`);
  }
  return value;
}

function validateArtifact(value, label) {
  if (!isRecord(value) || !exactKeys(value, ["sha256", "url"])) {
    throw new Error(`${label}.artifact must contain only url and sha256.`);
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`${label}.artifact.url must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(
      `${label}.artifact.url must be a credential-free HTTPS URL without a fragment.`,
    );
  }
  if (!checksumPattern.test(value.sha256)) {
    throw new Error(`${label}.artifact.sha256 must be a lowercase SHA-256 checksum.`);
  }
  return { sha256: value.sha256, url: url.href };
}

function validateUpstream(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label}.upstream must identify fixture revision or upstream versions.`);
  }
  if (exactKeys(value, ["fixtureRevision"])) {
    return {
      fixtureRevision: requireString(
        value.fixtureRevision,
        `${label}.upstream.fixtureRevision`,
        128,
      ),
    };
  }
  if (
    !exactKeys(value, ["versions"]) ||
    !isRecord(value.versions) ||
    Object.keys(value.versions).length === 0
  ) {
    throw new Error(
      `${label}.upstream must contain exactly fixtureRevision or non-empty versions.`,
    );
  }
  const versions = {};
  for (const [service, version] of Object.entries(value.versions).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(service)) {
      throw new Error(`${label}.upstream.versions has an invalid service name.`);
    }
    versions[service] = requireString(version, `${label}.upstream.versions.${service}`, 128);
  }
  return { versions };
}

function validateArchitectures(value, label, expectedArchitectures) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    throw new Error(`${label}.architectures must be a non-empty unique list.`);
  }
  for (const architecture of value) {
    if (!expectedArchitectures.includes(architecture)) {
      throw new Error(`${label}.architectures contains an unsupported stable architecture.`);
    }
  }
  return [...value].sort();
}

function validateRecord(value, index, sourceSha, candidateDigest, expectedArchitectures, today) {
  const label = `Evidence record ${index + 1}`;
  const expectedKeys = [
    "architectures",
    "artifact",
    "candidateDigest",
    "claim",
    "expiresAt",
    "limitations",
    "owner",
    "result",
    "sourceSha",
    "tier",
    "upstream",
    "verifiedAt",
  ];
  if (!isRecord(value) || !exactKeys(value, expectedKeys)) {
    throw new Error(`${label} must use the exact evidence record schema.`);
  }
  if (!tierValues.has(value.tier))
    throw new Error(`${label}.tier must be an integer from 1 through 4.`);
  if (value.sourceSha !== sourceSha || !sourceShaPattern.test(value.sourceSha)) {
    throw new Error(`${label}.sourceSha must match the exact candidate source SHA.`);
  }
  if (value.candidateDigest !== candidateDigest || !digestPattern.test(value.candidateDigest)) {
    throw new Error(`${label}.candidateDigest must match the exact candidate digest.`);
  }
  if (!resultValues.has(value.result)) throw new Error(`${label}.result must be passed.`);

  const verifiedAt = requireDate(value.verifiedAt, `${label}.verifiedAt`);
  const expiresAt = requireDate(value.expiresAt, `${label}.expiresAt`);
  if (expiresAt < verifiedAt || expiresAt < today) {
    throw new Error(`${label} must have unexpired evidence after its verification date.`);
  }
  return {
    architectures: validateArchitectures(value.architectures, label, expectedArchitectures),
    artifact: validateArtifact(value.artifact, label),
    candidateDigest,
    claim: requireString(value.claim, `${label}.claim`),
    expiresAt,
    limitations: requireString(value.limitations, `${label}.limitations`),
    owner: requireString(value.owner, `${label}.owner`, 128),
    result: value.result,
    sourceSha,
    tier: value.tier,
    upstream: validateUpstream(value.upstream, label),
    verifiedAt,
  };
}

export function validateV1EvidenceIndex(value, options) {
  if (
    !isRecord(options) ||
    !sourceShaPattern.test(options.sourceSha) ||
    !digestPattern.test(options.candidateDigest)
  ) {
    throw new Error("Validation requires an exact source SHA and candidate digest.");
  }
  const expectedArchitectures = options.architectures ?? STABLE_ARCHITECTURES;
  if (
    !Array.isArray(expectedArchitectures) ||
    expectedArchitectures.length === 0 ||
    new Set(expectedArchitectures).size !== expectedArchitectures.length ||
    expectedArchitectures.some((architecture) => !STABLE_ARCHITECTURES.includes(architecture))
  ) {
    throw new Error("Validation requires a non-empty unique subset of stable architectures.");
  }
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  requireDate(today, "Validation date");

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !exactKeys(value, ["candidateDigest", "records", "schemaVersion", "sourceSha"]) ||
    value.sourceSha !== options.sourceSha ||
    value.candidateDigest !== options.candidateDigest ||
    !Array.isArray(value.records) ||
    value.records.length < 4
  ) {
    throw new Error(
      "The v1 evidence index must bind records to the exact source SHA and candidate digest.",
    );
  }

  const records = value.records.map((record, index) =>
    validateRecord(
      record,
      index,
      value.sourceSha,
      value.candidateDigest,
      expectedArchitectures,
      today,
    ),
  );
  for (const tier of tierValues) {
    if (!records.some((record) => record.tier === tier)) {
      throw new Error(`The v1 evidence index must include a passed Tier ${tier} record.`);
    }
  }
  const tierThreeArchitectures = new Set(
    records.filter((record) => record.tier === 3).flatMap((record) => record.architectures),
  );
  if (expectedArchitectures.some((architecture) => !tierThreeArchitectures.has(architecture))) {
    throw new Error("Tier 3 evidence must prove native execution for every stable architecture.");
  }

  return {
    schemaVersion: 1,
    sourceSha: value.sourceSha,
    candidateDigest: value.candidateDigest,
    records,
  };
}

function commandOptions(arguments_) {
  if (arguments_.length !== 8)
    throw new Error(
      "Usage: --input <path> --source-sha <sha> --candidate-digest <digest> --output <path>.",
    );
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--candidate-digest", "--input", "--output", "--source-sha"].includes(name) ||
      !value ||
      value.startsWith("--") ||
      options.has(name)
    ) {
      throw new Error(
        "Usage: --input <path> --source-sha <sha> --candidate-digest <digest> --output <path>.",
      );
    }
    options.set(name, value);
  }
  return {
    candidateDigest: options.get("--candidate-digest"),
    input: resolve(options.get("--input")),
    output: resolve(options.get("--output")),
    sourceSha: options.get("--source-sha"),
  };
}

async function main() {
  const options = commandOptions(process.argv.slice(2));
  let input;
  try {
    input = JSON.parse(await readFile(options.input, "utf8"));
  } catch {
    throw new Error("The v1 evidence index must be readable JSON.");
  }
  const evidence = validateV1EvidenceIndex(input, options);
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "v1_evidence_invalid"}\n`);
    process.exitCode = 1;
  }
}
