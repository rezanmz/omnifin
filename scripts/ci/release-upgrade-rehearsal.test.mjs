import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  failedUpgradeRehearsalReport,
  immutableOmnifinImage,
  publishedLoopbackPort,
  upgradeRehearsalReport,
} from "../release/upgrade-rehearsal.mjs";

const PREVIOUS_IMAGE =
  "ghcr.io/rezanmz/omnifin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CANDIDATE_IMAGE =
  "ghcr.io/rezanmz/omnifin@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HARNESS_SOURCE = readFileSync(
  new URL("../release/upgrade-rehearsal.mjs", import.meta.url),
  "utf8",
);

test("accepts only immutable public Omnifin image digests", () => {
  assert.deepEqual(immutableOmnifinImage(PREVIOUS_IMAGE), {
    digest: PREVIOUS_IMAGE.slice(PREVIOUS_IMAGE.indexOf("@") + 1),
    reference: PREVIOUS_IMAGE,
  });
  assert.throws(
    () => immutableOmnifinImage("ghcr.io/rezanmz/omnifin:latest"),
    /image_reference_invalid/u,
  );
  assert.throws(
    () =>
      immutableOmnifinImage(
        "registry.example.test/rezanmz/omnifin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    /image_reference_invalid/u,
  );
});

test("accepts exactly one structured IPv4 loopback port binding", () => {
  assert.equal(
    publishedLoopbackPort(
      '{"3000/tcp":null,"4000/tcp":[{"HostIp":"127.0.0.1","HostPort":"32768"}]}',
      "gateway_port",
    ),
    32_768,
  );

  for (const binding of [
    "null",
    "[]",
    "{}",
    '{"4000/tcp":null}',
    '{"4000/tcp":[{"HostIp":"0.0.0.0","HostPort":"32768"}]}',
    '{"4000/tcp":[{"HostIp":"::1","HostPort":"32768"}]}',
    '{"4000/tcp":[{"HostIp":"127.0.0.1","HostPort":"0"}]}',
    '{"4000/tcp":[{"HostIp":"127.0.0.1","HostPort":"65536"}]}',
    '{"4000/tcp":[{"HostIp":"127.0.0.1","HostPort":"not-a-port"}]}',
    '{"4000/tcp":[{"HostIp":"127.0.0.1","HostPort":"32768"},{"HostIp":"127.0.0.1","HostPort":"32769"}]}',
    '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"32769"}],"4000/tcp":[{"HostIp":"127.0.0.1","HostPort":"32768"}]}',
    "not-json",
  ]) {
    assert.throws(() => publishedLoopbackPort(binding, "gateway_port"), /gateway_port/u);
  }
});

test("builds a closed upgrade and rollback report", () => {
  const report = upgradeRehearsalReport({
    candidate: {
      image: CANDIDATE_IMAGE,
      migrationCount: 18,
      schemaSha256: "c".repeat(64),
      privateState: "candidate-private-state",
    },
    checks: [
      "previous_runtime_verified",
      "previous_state_seeded",
      "backup_verified",
      "candidate_runtime_verified",
      "candidate_state_verified",
      "candidate_backup_verified",
      "rollback_backup_verified",
      "rollback_state_verified",
    ],
    previous: {
      image: PREVIOUS_IMAGE,
      migrationCount: 17,
      schemaSha256: "d".repeat(64),
      databaseSha256: "private-database-digest",
    },
    rollback: {
      migrationCount: 17,
      schemaSha256: "d".repeat(64),
      providerId: "private-provider-id",
    },
  });

  assert.deepEqual(Object.keys(report).sort(), [
    "candidate",
    "checks",
    "previous",
    "rollback",
    "schemaVersion",
    "status",
  ]);
  assert.deepEqual(report.candidate, {
    digest: CANDIDATE_IMAGE.slice(CANDIDATE_IMAGE.indexOf("@") + 1),
    migrationCount: 18,
    schemaSha256: "c".repeat(64),
  });
  assert.deepEqual(report.previous, {
    digest: PREVIOUS_IMAGE.slice(PREVIOUS_IMAGE.indexOf("@") + 1),
    migrationCount: 17,
    schemaSha256: "d".repeat(64),
  });
  assert.deepEqual(report.rollback, {
    migrationCount: 17,
    schemaSha256: "d".repeat(64),
  });
  assert.doesNotMatch(JSON.stringify(report), /private-state|private-database|private-provider/u);
});

test("refuses passed evidence when any required transition check is missing", () => {
  assert.throws(
    () =>
      upgradeRehearsalReport({
        candidate: { image: CANDIDATE_IMAGE, migrationCount: 18, schemaSha256: "c".repeat(64) },
        checks: ["previous_runtime_verified", "rollback_state_verified"],
        previous: { image: PREVIOUS_IMAGE, migrationCount: 17, schemaSha256: "d".repeat(64) },
        rollback: { migrationCount: 17, schemaSha256: "d".repeat(64) },
      }),
    /rehearsal_checks_invalid/u,
  );
});

test("emits only bounded failure evidence", () => {
  const error = Object.assign(new Error("private failure detail"), {
    operation: "candidate_gateway_health",
    password: "private-password",
  });
  const report = failedUpgradeRehearsalReport(
    error,
    {
      candidate: immutableOmnifinImage(CANDIDATE_IMAGE),
      previous: immutableOmnifinImage(PREVIOUS_IMAGE),
    },
    ["previous_runtime_verified", "private-check"],
  );

  assert.deepEqual(report, {
    candidateDigest: CANDIDATE_IMAGE.slice(CANDIDATE_IMAGE.indexOf("@") + 1),
    checks: ["previous_runtime_verified"],
    errorCategory: "release_rehearsal_failed",
    previousDigest: PREVIOUS_IMAGE.slice(PREVIOUS_IMAGE.indexOf("@") + 1),
    schemaVersion: 1,
    status: "failed",
  });
  assert.doesNotMatch(JSON.stringify(report), /private failure|private-password|private-check/u);
});

test("requires the release rehearsal before stable alias promotion", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8"),
  );
  const rehearsal = workflow.jobs["rehearse-upgrade"];
  assert.equal(rehearsal.name, "Rehearse upgrade and exact-digest rollback");
  assert.deepEqual(rehearsal.needs, [
    "validate-release-metadata",
    "publish-candidate",
    "verify-candidate",
  ]);
  assert.equal(JSON.stringify(rehearsal).includes("secrets."), false);
  const exercise = rehearsal.steps.find(
    (step) => step.name === "Exercise upgrade and rollback on the hosted runner",
  );
  assert.match(exercise.run, /scripts\/release\/upgrade-rehearsal\.mjs/u);
  assert.match(exercise.run, /--candidate-image "\$candidate_ref"/u);
  assert.match(exercise.run, /--previous-image "\$previous_ref"/u);
  assert.match(exercise.run, /cosign verify/u);
  assert.match(exercise.run, /\(publish\|release-please\)/u);
  const evidence = rehearsal.steps.find(
    (step) => step.name === "Upload sanitized upgrade rehearsal evidence",
  );
  assert.equal(evidence.if, "always()");
  assert.equal(evidence.with["if-no-files-found"], "error");
  assert.ok(workflow.jobs["promote-stable"].needs.includes("rehearse-upgrade"));
  assert.match(workflow.jobs["promote-stable"].if, /needs\.rehearse-upgrade\.result == 'success'/u);

  const previous = rehearsal.steps.find((step) => step.name === "Resolve previous stable digest");
  assert.deepEqual(previous.env, {
    DOCKER_CONFIG: "${{ runner.temp }}/anonymous-docker",
    GH_TOKEN: "${{ github.token }}",
  });
  assert.match(previous.run, /mkdir --parents "\$DOCKER_CONFIG"/u);
  assert.match(previous.run, /oras repo tags "\$IMAGE_NAME" --format json/u);
  assert.match(
    previous.run,
    /\^\(0\|\[1-9\]\\d\*\)\\\.\(0\|\[1-9\]\\d\*\)\\\.\(0\|\[1-9\]\\d\*\)\$/u,
  );
  assert.match(previous.run, /oras resolve "\$\{IMAGE_NAME\}:\$\{newest_version\}"/u);
  assert.match(previous.run, /Stable releases exist but the latest alias could not be resolved/u);
  assert.match(
    previous.run,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases" --paginate --slurp\s*\\?\s*\| jq --raw-output/u,
  );
  assert.match(previous.run, /Published releases exist but no prior stable image can be resolved/u);
});

test("isolates and resource-bounds every rehearsal runtime", () => {
  assert.match(
    HARNESS_SOURCE,
    /docker\(\["network", "create", "--internal", resources\.network\]/u,
  );
  for (const option of ["--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus"]) {
    const occurrences = HARNESS_SOURCE.match(new RegExp(`"${option}"`, "gu")) ?? [];
    assert.equal(occurrences.length, 2, `${option} must protect gateway and maintenance runs`);
  }
  assert.equal((HARNESS_SOURCE.match(/"127\.0\.0\.1::4000"/gu) ?? []).length, 1);
  assert.doesNotMatch(HARNESS_SOURCE, /"0\.0\.0\.0:/u);
  assert.match(HARNESS_SOURCE, /json \.NetworkSettings\.Ports/u);
  assert.doesNotMatch(HARNESS_SOURCE, /docker\(\["port"/u);
  assert.match(HARNESS_SOURCE, /`\$\{operation\}_inspect`/u);
  assert.match(HARNESS_SOURCE, /`\$\{operation\}_contract`/u);
  assert.match(
    HARNESS_SOURCE,
    /function runMaintenance[\s\S]*resources\.containers\.add\(name\)[\s\S]*resources\.containers\.delete\(name\)/u,
  );
});

test("exercises the harness against public stable and protected-main edge digests", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/upgrade-rehearsal.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(JSON.stringify(workflow).includes("secrets."), false);
  assert.deepEqual(workflow.on.pull_request.paths, [
    ".github/workflows/publish.yml",
    ".github/workflows/upgrade-rehearsal.yml",
    "scripts/release/upgrade-rehearsal.mjs",
    "scripts/ci/release-upgrade-rehearsal.test.mjs",
  ]);
  const exercise = workflow.jobs.rehearsal.steps.find(
    (step) => step.name === "Exercise stable-to-edge upgrade and rollback",
  );
  assert.match(exercise.run, /oras resolve "\$\{IMAGE_NAME\}:latest"/u);
  assert.match(exercise.run, /oras resolve "\$\{IMAGE_NAME\}:edge"/u);
  assert.match(exercise.run, /previous_digest" = "\$candidate_digest/u);
  assert.match(exercise.run, /scripts\/release\/upgrade-rehearsal\.mjs/u);
  assert.equal((exercise.run.match(/cosign verify/gu) ?? []).length, 2);
  assert.match(exercise.run, /\(publish\|release-please\)/u);
  assert.match(exercise.run, /\.github\/workflows\/edge\.yml@refs\/heads\/main/u);
  const evidence = workflow.jobs.rehearsal.steps.find(
    (step) => step.name === "Upload sanitized upgrade rehearsal evidence",
  );
  assert.equal(evidence.if, "always()");
  assert.equal(evidence.with["if-no-files-found"], "error");
});
