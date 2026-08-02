import assert from "node:assert/strict";
import test from "node:test";

import {
  boundDiagnosticTail,
  collectContainerDiagnostics,
  createFailureReport,
  parseDoctorSmokeReport,
  parseRetainedBackupSmokeReport,
  redactDiagnosticText,
} from "../container-smoke.mjs";

test("retained backup smoke reports accept only the bounded privacy-safe contract", () => {
  const fileName = "omnifin-auto-20260801T120000000Z-00000000-0000-4000-8000-000000000001.sqlite";
  const report = {
    operation: "backup-retained",
    status: "ok",
    backup: {
      bytes: 4096,
      databaseSha256: "a".repeat(64),
      fileName,
      manifestFileName: `${fileName}.manifest.json`,
      migrationCount: 12,
      schemaSha256: "b".repeat(64),
    },
    retention: { candidates: 1, removed: 0, retained: 1, state: "ready" },
  };

  assert.deepEqual(parseRetainedBackupSmokeReport(JSON.stringify(report)), report);
  assert.throws(
    () =>
      parseRetainedBackupSmokeReport(
        JSON.stringify({ ...report, backupDirectory: "/private/backups" }),
      ),
    /maintenance_retained_backup_report_invalid/u,
  );
  assert.throws(
    () =>
      parseRetainedBackupSmokeReport(
        JSON.stringify({
          ...report,
          backup: { ...report.backup, manifestFileName: "different.manifest.json" },
        }),
      ),
    /maintenance_retained_backup_report_invalid/u,
  );
});

test("deployment doctor smoke reports accept only the bounded preview posture", () => {
  const mutableImage = "omnifin:smoke-fixture";
  const report = {
    operation: "doctor",
    status: "attention",
    schemaVersion: 1,
    state: "attention",
    readyCount: 4,
    total: 6,
    generatedAt: "2026-08-01T12:00:00.000Z",
    checks: [
      { id: "runtime", state: "ready" },
      { code: "image_reference_not_immutable", id: "image", state: "attention" },
      { id: "gateway", state: "ready" },
      { code: "public_origin_invalid", id: "public_boundary", state: "attention" },
      { id: "storage", state: "ready" },
      { id: "backup", state: "ready" },
    ],
  };
  assert.deepEqual(parseDoctorSmokeReport(JSON.stringify(report), mutableImage), report);

  assert.throws(
    () =>
      parseDoctorSmokeReport(
        JSON.stringify({ ...report, publicUrl: "https://private.example.test" }),
        mutableImage,
      ),
    /maintenance_doctor_report_invalid/u,
  );
  assert.throws(
    () =>
      parseDoctorSmokeReport(
        JSON.stringify({
          ...report,
          checks: report.checks.map((check, index) =>
            index === 0 ? { ...check, detail: "/private/runtime/path" } : check,
          ),
        }),
        mutableImage,
      ),
    /maintenance_doctor_report_invalid/u,
  );
});

test("deployment doctor smoke reports bind image posture to the exercised reference", () => {
  const mutableImage = "omnifin:smoke-fixture";
  const immutableImage = `ghcr.io/rezanmz/omnifin@sha256:${"a".repeat(64)}`;
  const mutableReport = {
    operation: "doctor",
    status: "attention",
    schemaVersion: 1,
    state: "attention",
    readyCount: 4,
    total: 6,
    generatedAt: "2026-08-01T12:00:00.000Z",
    checks: [
      { id: "runtime", state: "ready" },
      { code: "image_reference_not_immutable", id: "image", state: "attention" },
      { id: "gateway", state: "ready" },
      { code: "public_origin_invalid", id: "public_boundary", state: "attention" },
      { id: "storage", state: "ready" },
      { id: "backup", state: "ready" },
    ],
  };
  const immutableReport = {
    ...mutableReport,
    readyCount: 5,
    checks: mutableReport.checks.map((check) =>
      check.id === "image" ? { id: "image", state: "ready" } : check,
    ),
  };

  assert.deepEqual(
    parseDoctorSmokeReport(JSON.stringify(immutableReport), immutableImage),
    immutableReport,
  );
  assert.throws(
    () => parseDoctorSmokeReport(JSON.stringify(immutableReport), mutableImage),
    /maintenance_doctor_report_invalid/u,
  );
  assert.throws(
    () => parseDoctorSmokeReport(JSON.stringify(mutableReport), immutableImage),
    /maintenance_doctor_report_invalid/u,
  );
  assert.throws(
    () => parseDoctorSmokeReport(JSON.stringify(mutableReport)),
    /maintenance_doctor_image_reference_invalid/u,
  );
});

test("diagnostic redaction removes exact smoke secrets, host paths, and common credentials", () => {
  const encryptionSecret = "generated-encryption-value";
  const recoverySecret = "generated-recovery-value";
  const repositoryPath = "/private/work/omnifin";
  const bearerCredential = ["Bearer", "synthetic-access-value"].join(" ");
  const secondBearerCredential = ["Bearer", "second-synthetic-access-value"].join(" ");
  const input = [
    `\u001B[31mfailed at ${repositoryPath}/scripts/container-smoke.mjs\u001B[0m`,
    `encryption=${encryptionSecret}`,
    `recovery=${recoverySecret}`,
    'clientSecret: "upstream-client-value"',
    `Authorization: ${bearerCredential}`,
    `standalone ${secondBearerCredential}`,
    "Cookie=session=browser-cookie-value",
  ].join("\n");

  const result = redactDiagnosticText(input, {
    secretValues: [encryptionSecret, recoverySecret],
    sensitivePaths: [repositoryPath],
  });

  assert.doesNotMatch(
    result,
    /generated-|synthetic-access|upstream-|browser-cookie|\/private\/work/u,
  );
  assert.doesNotMatch(result, /\u001B/u);
  assert.match(result, /\[REDACTED_PATH\]/u);
  assert.match(result, /Authorization: "\[REDACTED\]"/u);
  assert.match(result, /Bearer \[REDACTED\]/u);
});

test("diagnostic tails have deterministic line and character bounds", () => {
  assert.equal(
    boundDiagnosticTail("line-1\nline-2\nline-3\nline-4", {
      maxLines: 2,
      maxCharacters: 100,
    }),
    "line-3\nline-4",
  );

  const bounded = boundDiagnosticTail(`prefix-${"x".repeat(100)}-tail`, {
    maxLines: 1,
    maxCharacters: 48,
  });
  assert.equal(bounded.length, 48);
  assert.match(bounded, /^\[diagnostic truncated\]\n/u);
  assert.match(bounded, /-tail$/u);
});

test("container diagnostics inspect state and bounded logs only for tracked containers", () => {
  const calls = [];
  const secret = "generated-smoke-secret";
  const execute = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[1] === "inspect") {
      return {
        ok: true,
        stdout: JSON.stringify({
          Status: "exited",
          Running: false,
          ExitCode: 1,
          OOMKilled: false,
          Error: "",
          Health: {
            Status: "unhealthy",
            FailingStreak: 4,
            Log: [{ Output: `never expose ${secret}` }],
          },
        }),
      };
    }
    return {
      ok: true,
      stdout: `${"old-line\n".repeat(80)}recoverySecret=${secret}\nlast-line`,
    };
  };

  const result = collectContainerDiagnostics(
    [{ component: "gateway", name: "run-owned-gateway" }],
    { secretValues: [secret] },
    execute,
  );

  assert.deepEqual(
    calls.map((arguments_) => arguments_.at(-1)),
    ["run-owned-gateway", "run-owned-gateway"],
  );
  assert.equal(
    calls.some((arguments_) => arguments_.includes("env")),
    false,
  );
  assert.deepEqual(result[0].state, {
    status: "exited",
    running: false,
    exitCode: 1,
    oomKilled: false,
    health: { status: "unhealthy", failingStreak: 4 },
  });
  assert.equal(result[0].logs.split("\n").length <= 60, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
  assert.match(result[0].logs, /last-line$/u);
});

test("failure reports keep command and diagnostic failures bounded and redacted", () => {
  const secret = "generated-smoke-secret";
  const hostPath = "/private/work/omnifin";
  const execute = () => ({
    ok: false,
    failure: {
      code: "ETIMEDOUT",
      exitCode: null,
      signal: "SIGTERM",
      stderr: `diagnostic failed: ${hostPath}; token=${secret}`,
    },
  });
  const report = createFailureReport(
    {
      operation: "gateway_health",
      commandFailure: {
        code: "1",
        exitCode: 1,
        signal: null,
        stderr: `docker failed: ${hostPath}; password=${secret}`,
      },
    },
    [{ component: "gateway", name: "run-owned-gateway" }],
    { secretValues: [secret], sensitivePaths: [hostPath] },
    execute,
  );
  const serialized = JSON.stringify(report);

  assert.equal(report.errorCategory, "gateway_health");
  assert.equal(report.containers[0].state.status, "diagnostic_unavailable");
  assert.equal(report.containers[0].logs, "");
  assert.doesNotMatch(serialized, /generated-smoke-secret|\/private\/work/u);
  assert.match(serialized, /REDACTED/u);
  assert.ok(serialized.length < 10_000);
});
