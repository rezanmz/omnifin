import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assembleV1Evidence, V1_EVIDENCE_INPUTS } from "./release-evidence-assembly.mjs";

const sourceSha = "a".repeat(40);
const candidateDigest = `sha256:${"b".repeat(64)}`;

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-v1-evidence-"));
  const inputFiles = {};
  for (const name of Object.values(V1_EVIDENCE_INPUTS).flat()) {
    const inputPath = path.join(directory, name);
    await writeFile(inputPath, `sanitized ${name}\n`);
    inputFiles[name] = inputPath;
  }
  return { directory, inputFiles };
}

function options(fixtureDirectory, inputFiles) {
  return {
    candidateDigest,
    inputFiles,
    outputDirectory: path.join(fixtureDirectory, "output"),
    releaseTag: "v1.0.0",
    repository: "rezanmz/omnifin",
    runId: "123456789",
    sourceSha,
    verifiedAt: "2026-08-14",
  };
}

test("assembles four checksum-bound candidate evidence tiers from gate artifacts", async () => {
  const value = await fixture();
  try {
    const index = await assembleV1Evidence(options(value.directory, value.inputFiles));

    assert.equal(index.sourceSha, sourceSha);
    assert.equal(index.candidateDigest, candidateDigest);
    assert.deepEqual(
      index.records.map((record) => record.tier),
      [1, 2, 3, 4],
    );
    assert.deepEqual(index.records[2].architectures, ["linux/amd64", "linux/arm64"]);
    assert.match(index.records[3].artifact.url, /releases\/download\/v1\.0\.0\//u);
    const tierFour = JSON.parse(
      await readFile(
        path.join(value.directory, "output", "v1-evidence-tier-4-123456789.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      tierFour.inputs.map((input) => input.name),
      ["install.json", "upgrade.json"],
    );
  } finally {
    await rm(value.directory, { force: true, recursive: true });
  }
});

test("refuses incomplete or renamed candidate-gate evidence", async () => {
  const value = await fixture();
  try {
    const incomplete = { ...value.inputFiles };
    delete incomplete["upgrade.json"];
    await assert.rejects(
      assembleV1Evidence(options(value.directory, incomplete)),
      /every required candidate-gate artifact/u,
    );
    await assert.rejects(
      assembleV1Evidence({ ...options(value.directory, value.inputFiles), runId: "0" }),
      /runId is invalid/u,
    );
  } finally {
    await rm(value.directory, { force: true, recursive: true });
  }
});
