import assert from "node:assert/strict";
import test from "node:test";

import { SERVICES, readinessBlock, validateReadinessLedger } from "./readiness.mjs";
import {
  fixtureChecksFor,
  parseArguments,
  vitestExecutionPassed,
  vitestExecutionSummary,
} from "./run.mjs";

function ledgerWith(state = "ready") {
  return {
    schemaVersion: 1,
    services: Object.fromEntries(
      SERVICES.map((service) => [service, { fixture: state, live: state }]),
    ),
  };
}

test("accepts an exact readiness schema", () => {
  assert.equal(validateReadinessLedger(ledgerWith()).schemaVersion, 1);
});

test("rejects a missing service instead of silently reducing coverage", () => {
  const ledger = ledgerWith();
  delete ledger.services.oidc;
  assert.throws(() => validateReadinessLedger(ledger), /missing: oidc/u);
});

test("rejects unknown readiness states", () => {
  const ledger = ledgerWith();
  ledger.services.authentik.live = "verified";
  assert.throws(() => validateReadinessLedger(ledger), /pending or ready/u);
});

test("strict mode blocks pending coverage before a probe runs", () => {
  const ledger = validateReadinessLedger(ledgerWith("pending"));
  assert.deepEqual(readinessBlock(ledger, "jellyfin", "live", true), {
    service: "jellyfin",
    profile: "live-coverage",
    status: "not_ready",
    errorCategory: "coverage_not_ready",
  });
  assert.equal(readinessBlock(ledger, "jellyfin", "live", false), null);
});

test("integration arguments require exactly one selection mode", () => {
  assert.throws(() => parseArguments([]), /Select either --all/u);
  assert.throws(() => parseArguments(["--all", "--service", "jellyfin"]), /Select either --all/u);
  assert.deepEqual(parseArguments(["--service", "jellyfin"]).services, ["jellyfin"]);
});

test("fixture reports claim only authentication behavior covered by their tests", () => {
  assert.deepEqual(fixtureChecksFor("seerr"), ["health_normalization", "version_discovery"]);
  assert.deepEqual(fixtureChecksFor("sabnzbd"), ["health_normalization", "version_discovery"]);
  assert.equal(fixtureChecksFor("oidc"), null);
});

test("fixture execution rejects zero-match, all-skipped, and malformed Vitest reports", () => {
  const report = {
    numFailedTests: 0,
    numPassedTests: 0,
    numPendingTests: 12,
    numTotalTests: 12,
    success: true,
  };
  assert.equal(vitestExecutionPassed({ status: 0, stdout: JSON.stringify(report) }), false);
  assert.equal(vitestExecutionPassed({ status: 0, stdout: "not-json" }), false);
  assert.equal(
    vitestExecutionPassed({
      status: 0,
      stdout: JSON.stringify({ ...report, numPassedTests: 1, numPendingTests: 11 }),
    }),
    true,
  );
});

test("fixture execution reads a dedicated reporter artifact instead of command stdout", () => {
  const report = JSON.stringify({
    numFailedTests: 0,
    numPassedTests: 1,
    numPendingTests: 0,
    numTotalTests: 1,
    success: true,
  });
  assert.equal(
    vitestExecutionPassed({ status: 0, stdout: "package-manager output before JSON" }, report),
    true,
  );
});

test("fixture failures expose only bounded test-file basenames", () => {
  const reporterOutput = JSON.stringify({
    numFailedTests: 1,
    numPassedTests: 1,
    numPendingTests: 0,
    numTotalTests: 2,
    success: false,
    testResults: [
      {
        message: "private assertion and protocol payload",
        name: "/home/runner/work/omnifin/apps/gateway/test/oidc-routes.test.ts",
        status: "failed",
      },
      {
        name: "/home/runner/work/omnifin/apps/gateway/test/oidc-protocol.test.ts",
        status: "passed",
      },
    ],
  });
  const summary = vitestExecutionSummary({ status: 1, stdout: "ignored" }, reporterOutput);
  assert.deepEqual(summary, {
    failedTestFiles: ["oidc-routes.test.ts"],
    passed: false,
  });
  assert.equal(JSON.stringify(summary).includes("private assertion"), false);
  assert.equal(JSON.stringify(summary).includes("/home/runner"), false);
});
