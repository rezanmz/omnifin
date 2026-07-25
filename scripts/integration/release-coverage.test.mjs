import assert from "node:assert/strict";
import test from "node:test";

import {
  coverageForVersion,
  readReleaseCoverage,
  validateReleaseCoverage,
} from "./release-coverage.mjs";
import { readReadinessLedger, SERVICES } from "./readiness.mjs";

test("the selected release profile matches the reviewed readiness ledger", async () => {
  const coverage = await readReleaseCoverage();
  const selected = coverageForVersion(coverage, "0.1.0", readReadinessLedger());
  assert.equal(selected.profile, coverage.selectedProfile);
});

test("phase 0 release coverage excludes future live capabilities", async () => {
  const coverage = await readReleaseCoverage();
  coverage.selectedProfile = "phase0";
  const selected = coverageForVersion(coverage, "0.1.0", readReadinessLedger());
  assert.equal(selected.profile, "phase0");
  assert.deepEqual(selected.liveServices, []);
  assert.equal(selected.fixtureServices.includes("jellyfin"), true);
  assert.equal(selected.fixtureServices.includes("oidc"), false);
});

test("version 1 cannot publish without the explicit full-matrix profile", async () => {
  const coverage = await readReleaseCoverage();
  coverage.selectedProfile = "phase5";
  assert.throws(
    () => coverageForVersion(coverage, "1.0.0", readReadinessLedger()),
    /full v1 release profile/u,
  );
});

test("advancing a profile fails while its required readiness is pending", async () => {
  const coverage = await readReleaseCoverage();
  const readiness = structuredClone(readReadinessLedger());
  coverage.selectedProfile = "phase1";
  readiness.services.oidc.fixture = "pending";
  readiness.services.authentik.fixture = "pending";
  assert.throws(
    () => coverageForVersion(coverage, "0.2.0", readiness),
    /phase1.fixture requires pending coverage: oidc, authentik/u,
  );
});

test("the v1 profile cannot omit any service", async () => {
  const coverage = await readReleaseCoverage();
  coverage.profiles.v1.live = SERVICES.slice(1);
  assert.throws(() => validateReleaseCoverage(coverage), /all earlier coverage|every live/u);
});
