import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STABLE_ARCHITECTURES, validateV1EvidenceIndex } from "./release-evidence.mjs";

const sourceSha = "a".repeat(40);
const candidateDigest = `sha256:${"b".repeat(64)}`;
const options = { candidateDigest, sourceSha, today: "2026-08-14" };

function record(tier, architectures = STABLE_ARCHITECTURES) {
  return {
    architectures,
    artifact: {
      sha256: "c".repeat(64),
      url: `https://github.com/rezanmz/omnifin/releases/download/v1.0.0/tier-${tier}.json`,
    },
    candidateDigest,
    claim: `Tier ${tier} release claim`,
    expiresAt: "2026-08-15",
    limitations: "Sanitized diagnostic output excludes secrets and host paths.",
    owner: "release-maintainer",
    result: "passed",
    sourceSha,
    tier,
    upstream: tier === 1 ? { fixtureRevision: sourceSha } : { versions: { jellyfin: "10.11.1" } },
    verifiedAt: "2026-08-14",
  };
}

function index(records = [record(1), record(2), record(3), record(4)]) {
  return { candidateDigest, records, schemaVersion: 1, sourceSha };
}

test("accepts four exact-candidate evidence tiers with native stable architecture coverage", () => {
  const validated = validateV1EvidenceIndex(index(), options);

  assert.equal(validated.records.length, 4);
  assert.deepEqual(validated.records[2].architectures, [...STABLE_ARCHITECTURES]);
});

test("rejects a candidate digest mismatch before accepting evidence", () => {
  const evidence = index();
  evidence.records[0].candidateDigest = `sha256:${"d".repeat(64)}`;

  assert.throws(
    () => validateV1EvidenceIndex(evidence, options),
    /must match the exact candidate digest/u,
  );
});

test("rejects missing cumulative evidence tiers", () => {
  assert.throws(
    () => validateV1EvidenceIndex(index([record(1), record(2), record(3), record(3)]), options),
    /Tier 4 record/u,
  );
});

test("rejects expired evidence", () => {
  const evidence = index();
  evidence.records[3].expiresAt = "2026-08-13";

  assert.throws(() => validateV1EvidenceIndex(evidence, options), /unexpired evidence/u);
});

test("rejects Tier 3 evidence without every advertised stable architecture", () => {
  assert.throws(
    () =>
      validateV1EvidenceIndex(
        index([record(1), record(2), record(3, ["linux/amd64"]), record(4)]),
        options,
      ),
    /native execution for every stable architecture/u,
  );
});

test("rejects records without a durable checksum-bound artifact", () => {
  const evidence = index();
  evidence.records[0].artifact.url = "http://evidence.invalid/tier-1.json";

  assert.throws(() => validateV1EvidenceIndex(evidence, options), /credential-free HTTPS URL/u);
});

test("command writes only the normalized exact-candidate evidence index", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-release-evidence-"));
  const inputPath = path.join(directory, "input.json");
  const outputPath = path.join(directory, "output.json");
  try {
    await writeFile(inputPath, JSON.stringify(index()));
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./release-evidence.mjs", import.meta.url)),
        "--input",
        inputPath,
        "--source-sha",
        sourceSha,
        "--candidate-digest",
        candidateDigest,
        "--output",
        outputPath,
      ],
      { stdio: "pipe" },
    );
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), index());
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
