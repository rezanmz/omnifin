import assert from "node:assert/strict";
import test from "node:test";

import { SERVICES, readinessBlock, validateReadinessLedger } from "./readiness.mjs";
import {
  fixtureChecksFor,
  nodeTestExecutionPassed,
  parseArguments,
  vitestExecutionPassed,
  vitestExecutionSummary,
  workspaceBuildArguments,
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
  assert.deepEqual(fixtureChecksFor("seerr"), [
    "authentication_header",
    "health_normalization",
    "identity_delegation",
    "request_creation",
    "response_normalization",
    "secret_isolation",
    "version_discovery",
  ]);
  assert.deepEqual(fixtureChecksFor("sabnzbd"), ["health_normalization", "version_discovery"]);
  assert.deepEqual(fixtureChecksFor("prowlarr"), [
    "application_sync",
    "authentication_header",
    "failure_history",
    "health_normalization",
    "indexer_inventory",
    "safe_test",
    "secret_isolation",
    "statistics",
    "version_discovery",
  ]);
  for (const service of ["radarr", "sonarr"]) {
    assert.deepEqual(fixtureChecksFor(service), [
      "acquisition_search",
      "authentication_header",
      "exact_target_validation",
      "health_normalization",
      "monitoring_read",
      "monitoring_update",
      "safe_mutation_shape",
      "secret_isolation",
      "version_discovery",
    ]);
  }
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

test("node fixture execution requires a real passing test summary", () => {
  const passing = ["TAP version 13", "# tests 10", "# pass 10", "# fail 0", "# cancelled 0"].join(
    "\n",
  );
  assert.equal(nodeTestExecutionPassed({ status: 0, stdout: passing }), true);
  assert.equal(
    nodeTestExecutionPassed({
      status: 0,
      stdout: "TAP version 13\n# tests 0\n# pass 0\n# fail 0\n# cancelled 0",
    }),
    false,
  );
  assert.equal(nodeTestExecutionPassed({ status: 1, stdout: passing }), false);
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

test("fixture packages build their workspace dependencies before contract execution", () => {
  assert.deepEqual(workspaceBuildArguments("@omnifin/gateway"), [
    "--filter",
    "@omnifin/gateway^...",
    "build",
  ]);
});
