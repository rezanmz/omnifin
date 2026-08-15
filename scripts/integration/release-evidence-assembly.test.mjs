import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assembleV1Evidence, V1_EVIDENCE_INPUTS } from "./release-evidence-assembly.mjs";
import { LIVE_EVIDENCE_COVERAGE } from "./live-evidence.mjs";
import { SERVICES } from "./readiness.mjs";

const sourceSha = "a".repeat(40);
const candidateDigest = `sha256:${"b".repeat(64)}`;

function liveEvidence() {
  return {
    architecture: "linux/amd64",
    expiresAt: "2026-09-13",
    limitations: "Sanitized reports omit credentials and host data",
    owner: "integration-operator",
    result: "passed",
    schemaVersion: 1,
    services: Object.fromEntries(
      SERVICES.map((service, index) => [
        service,
        {
          capabilities: index === 0 ? LIVE_EVIDENCE_COVERAGE : ["version-discovery"],
          result: "passed",
          version: "1.2.3",
        },
      ]),
    ),
    sourceSha,
    verifiedAt: "2026-08-14",
    verifiedCoverage: LIVE_EVIDENCE_COVERAGE,
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-v1-evidence-"));
  const inputFiles = {};
  for (const name of Object.values(V1_EVIDENCE_INPUTS).flat()) {
    const inputPath = path.join(directory, name);
    await writeFile(
      inputPath,
      name === "live.json"
        ? `${JSON.stringify(liveEvidence())}\n`
        : name === "home-lab.json"
          ? `${JSON.stringify({
              architecture: "linux/arm64",
              candidateDigest,
              deployment: { network: "real", tls: "reverse-proxy", type: "home-lab" },
              expiresAt: "2026-09-13",
              owner: "home-lab-operator",
              result: "passed",
              schemaVersion: 1,
              sourceSha,
              upstream: { versions: { jellyfin: "10.11.1" } },
              verifiedAt: "2026-08-14",
              verifiedCoverage: [
                "documented-install",
                "tls-reverse-proxy",
                "bootstrap",
                "backup",
                "empty-host-restore",
                "upgrade",
                "rollback",
                "troubleshooting",
                "real-network",
                "sse-media-proxying",
                "recovery-evidence",
                "sanitized-diagnostics",
              ],
            })}\n`
          : `sanitized ${name}\n`,
    );
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
    assert.deepEqual(index.records[1].architectures, ["linux/amd64"]);
    assert.deepEqual(index.records[1].upstream.versions.jellyfin, "1.2.3");
    assert.deepEqual(index.records[3].architectures, ["linux/arm64"]);
    assert.match(index.records[3].artifact.url, /releases\/download\/v1\.0\.0\//u);
    const tierFour = JSON.parse(
      await readFile(
        path.join(value.directory, "output", "v1-evidence-tier-4-123456789.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      tierFour.inputs.map((input) => input.name),
      ["install.json", "upgrade.json", "home-lab.json"],
    );
  } finally {
    await rm(value.directory, { force: true, recursive: true });
  }
});

test("requires a durable external home-lab report for Tier 4 evidence", async () => {
  const value = await fixture();
  delete value.inputFiles["home-lab.json"];
  try {
    await assert.rejects(
      assembleV1Evidence(options(value.directory, value.inputFiles)),
      /every required candidate-gate artifact/u,
    );
  } finally {
    await rm(value.directory, { force: true, recursive: true });
  }
});

test("rejects a malformed external home-lab report", async () => {
  const value = await fixture();
  try {
    await writeFile(value.inputFiles["home-lab.json"], "{}\n");
    await assert.rejects(
      assembleV1Evidence(options(value.directory, value.inputFiles)),
      /exact versioned report schema/u,
    );
  } finally {
    await rm(value.directory, { force: true, recursive: true });
  }
});

test("rejects non-UTF-8 home-lab reports", async () => {
  const value = await fixture();
  try {
    const report = Buffer.from(await readFile(value.inputFiles["home-lab.json"]));
    const ownerOffset = report.indexOf(Buffer.from("home-lab-operator"));
    report[ownerOffset] = 0xc3;
    await writeFile(value.inputFiles["home-lab.json"], report);
    await assert.rejects(
      assembleV1Evidence(options(value.directory, value.inputFiles)),
      /valid UTF-8/u,
    );
  } finally {
    await rm(value.directory, { force: true, recursive: true });
  }
});

test("rejects malformed or unbound live evidence before creating a v1 index", async () => {
  const value = await fixture();
  try {
    const cases = [
      {
        name: "bare probe report",
        report: {
          mode: "live",
          releaseProfile: "v1",
          results: SERVICES.map((service) => ({
            checks: ["authentication", "version_discovery"],
            profile: "live-upstream",
            service,
            status: "passed",
            version: "1.2.3",
          })),
          schemaVersion: 1,
          summary: { failed: 0, notConfigured: 0, notImplemented: 0, notReady: 0, passed: 10 },
        },
      },
      {
        name: "wrong source",
        report: { ...liveEvidence(), sourceSha: "c".repeat(40) },
      },
      {
        name: "unsafe owner",
        report: { ...liveEvidence(), owner: "https://operator.invalid" },
      },
      {
        name: "expired verification",
        report: { ...liveEvidence(), expiresAt: "2026-08-13" },
      },
      {
        name: "unsupported architecture",
        report: { ...liveEvidence(), architecture: "darwin/arm64" },
      },
      {
        name: "missing capability coverage",
        report: { ...liveEvidence(), verifiedCoverage: ["version-discovery"] },
      },
      {
        name: "failed service",
        report: {
          ...liveEvidence(),
          services: {
            ...liveEvidence().services,
            jellyfin: { ...liveEvidence().services.jellyfin, result: "failed" },
          },
        },
      },
      {
        name: "unsafe service version",
        report: {
          ...liveEvidence(),
          services: {
            ...liveEvidence().services,
            jellyfin: { ...liveEvidence().services.jellyfin, version: "https://jellyfin.invalid" },
          },
        },
      },
      {
        name: "unsafe limitation",
        report: { ...liveEvidence(), limitations: "See https://internal.invalid" },
      },
    ];
    for (const { name, report } of cases) {
      await writeFile(value.inputFiles["live.json"], `${JSON.stringify(report)}\n`);
      await assert.rejects(
        assembleV1Evidence({
          ...options(value.directory, value.inputFiles),
          outputDirectory: path.join(value.directory, `output-${name.replaceAll(" ", "-")}`),
        }),
        /Live evidence/u,
      );
    }
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
