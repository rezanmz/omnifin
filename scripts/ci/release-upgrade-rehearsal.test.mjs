import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import {
  classifyV0131RollbackProbeResult,
  failedUpgradeRehearsalReport,
  immutableOmnifinImage,
  privateContainerAddress,
  ROLLBACK_V0131_EXCEPTION_CHECK,
  runningContainerState,
  usesV0131RollbackCompatibility,
  upgradeRehearsalReport,
  validateV0131RollbackAdminError,
  validatePreviousRestoreEvidence,
} from "../release/upgrade-rehearsal.mjs";
import {
  classifyQuarantinedRollback,
  verifyQuarantinedRollback,
} from "../release/verify-v0131-quarantined-rollback.mjs";

const PREVIOUS_IMAGE =
  "ghcr.io/rezanmz/omnifin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CANDIDATE_IMAGE =
  "ghcr.io/rezanmz/omnifin@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HARNESS_SOURCE = readFileSync(
  new URL("../release/upgrade-rehearsal.mjs", import.meta.url),
  "utf8",
);
const PROBE_HARNESS_SOURCE = HARNESS_SOURCE.slice(
  HARNESS_SOURCE.indexOf("function runV0131RollbackProbe"),
  HARNESS_SOURCE.indexOf("export function validatePreviousRestoreEvidence"),
);
const ROLLBACK_PROBE_SOURCE = readFileSync(
  new URL("../release/verify-v0131-quarantined-rollback.mjs", import.meta.url),
  "utf8",
);
const V0131_DIGEST = "sha256:deae382a5c09560322eb5146764393bd0155c314087768426b757ca0c6fbff11";
const ROLLBACK_PROBE_SUCCESS = '{"operation":"rollback_quarantine_raw_verify","status":"ok"}\n';
const ROLLBACK_PROVIDER_CREATED_AT = 1_700_000_000_000;
const ROLLBACK_PROVIDER_CHECKED_AT = ROLLBACK_PROVIDER_CREATED_AT + 1;
const ROLLBACK_FAILURE_FINGERPRINT = "A".repeat(43);
const ROLLBACK_PROVIDER = Object.freeze({
  id: "oidc-upgrade-rehearsal",
  slug: "upgrade-rehearsal",
  clientId: "omnifin-upgrade-rehearsal",
  tokenEndpointAuthMethod: "client_secret_basic",
  encryptedClientSecret: "encrypted-client-secret",
  approvedEndpointOriginsJson: "[]",
  discoveryState: "failed",
  discoveryCapabilitiesJson: JSON.stringify({
    configurationFingerprint: ROLLBACK_FAILURE_FINGERPRINT,
    schemaVersion: 1,
  }),
  discoveryCheckedAt: ROLLBACK_PROVIDER_CHECKED_AT,
  createdAt: ROLLBACK_PROVIDER_CREATED_AT,
  updatedAt: ROLLBACK_PROVIDER_CHECKED_AT,
  allowJitProvisioning: 0,
  enabled: 1,
});

function createRollbackProbeFixture({ providers = [ROLLBACK_PROVIDER], transaction = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omnifin-rollback-probe-"));
  const databasePath = join(directory, "rollback.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    create table oidc_providers (
      id text,
      slug text,
      client_id text,
      token_endpoint_auth_method text,
      encrypted_client_secret text,
      approved_endpoint_origins_json text,
      discovery_state text,
      discovery_capabilities_json text,
      discovery_checked_at integer,
      created_at integer,
      updated_at integer,
      allow_jit_provisioning integer,
      enabled integer
    );
    create table auth_transactions (provider_id text);
  `);
  const insertProvider = database.prepare(`
    insert into oidc_providers (
      id,
      slug,
      client_id,
      token_endpoint_auth_method,
      encrypted_client_secret,
      approved_endpoint_origins_json,
      discovery_state,
      discovery_capabilities_json,
      discovery_checked_at,
      created_at,
      updated_at,
      allow_jit_provisioning,
      enabled
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const provider of providers) {
    insertProvider.run(
      provider.id,
      provider.slug,
      provider.clientId,
      provider.tokenEndpointAuthMethod,
      provider.encryptedClientSecret,
      provider.approvedEndpointOriginsJson,
      provider.discoveryState,
      provider.discoveryCapabilitiesJson,
      provider.discoveryCheckedAt,
      provider.createdAt,
      provider.updatedAt,
      provider.allowJitProvisioning,
      provider.enabled,
    );
  }
  if (transaction) {
    database
      .prepare("insert into auth_transactions (provider_id) values (?)")
      .run(ROLLBACK_PROVIDER.id);
  }
  database.close();
  return { databasePath, directory };
}

function withRollbackProbeFixture(options, callback) {
  const fixture = createRollbackProbeFixture(options);
  try {
    return callback(fixture.databasePath);
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
}

test("verifies the quarantined rollback fixture without mocking SQLite", () => {
  assert.equal(
    withRollbackProbeFixture({}, (databasePath) => verifyQuarantinedRollback(databasePath)),
    true,
  );

  const mismatches = [
    ["id", "different-provider"],
    ["slug", "different-slug"],
    ["clientId", "different-client-id"],
    ["tokenEndpointAuthMethod", "client_secret_post"],
    ["approvedEndpointOriginsJson", '["https://unexpected.example"]'],
    ["discoveryState", "ready"],
    ["discoveryState", "unchecked"],
    ["discoveryCapabilitiesJson", "{}"],
    ["discoveryCapabilitiesJson", '{"authorization_endpoint":"unexpected"}'],
    [
      "discoveryCapabilitiesJson",
      JSON.stringify({
        configurationFingerprint: ROLLBACK_FAILURE_FINGERPRINT,
        schemaVersion: 1,
        unexpected: true,
      }),
    ],
    [
      "discoveryCapabilitiesJson",
      JSON.stringify({
        configurationFingerprint: ROLLBACK_FAILURE_FINGERPRINT,
        schemaVersion: 2,
      }),
    ],
    [
      "discoveryCapabilitiesJson",
      JSON.stringify({ configurationFingerprint: "invalid", schemaVersion: 1 }),
    ],
    ["discoveryCheckedAt", null],
    ["discoveryCheckedAt", "not-a-timestamp"],
    ["discoveryCheckedAt", ROLLBACK_PROVIDER_CREATED_AT - 1],
    ["allowJitProvisioning", 1],
    ["enabled", 0],
  ];
  for (const [field, value] of mismatches) {
    const provider = { ...ROLLBACK_PROVIDER, [field]: value };
    assert.equal(
      withRollbackProbeFixture({ providers: [provider] }, (databasePath) =>
        verifyQuarantinedRollback(databasePath),
      ),
      false,
      `provider field mismatch: ${field}`,
    );
  }

  for (const [name, options] of [
    ["missing provider", { providers: [] }],
    ["extra provider", { providers: [ROLLBACK_PROVIDER, { ...ROLLBACK_PROVIDER, id: "extra" }] }],
    ["absent ciphertext", { providers: [{ ...ROLLBACK_PROVIDER, encryptedClientSecret: null }] }],
    ["empty ciphertext", { providers: [{ ...ROLLBACK_PROVIDER, encryptedClientSecret: "" }] }],
    [
      "oversized ciphertext",
      { providers: [{ ...ROLLBACK_PROVIDER, encryptedClientSecret: "x".repeat(8_193) }] },
    ],
    ["retained transaction", { transaction: true }],
  ]) {
    assert.equal(
      withRollbackProbeFixture(options, (databasePath) => verifyQuarantinedRollback(databasePath)),
      false,
      name,
    );
  }
});

test("classifies each quarantined rollback predicate group without exposing values", () => {
  const cases = [
    ["database", { providers: [] }, "probe_database"],
    ["identity", { providers: [{ ...ROLLBACK_PROVIDER, clientId: "wrong" }] }, "probe_identity"],
    [
      "discovery",
      { providers: [{ ...ROLLBACK_PROVIDER, discoveryState: "ready" }] },
      "probe_discovery",
    ],
    [
      "timestamp",
      {
        providers: [{ ...ROLLBACK_PROVIDER, discoveryCheckedAt: ROLLBACK_PROVIDER_CREATED_AT - 1 }],
      },
      "probe_timestamp",
    ],
    ["transaction", { transaction: true }, "probe_transaction"],
  ];
  for (const [name, options, category] of cases) {
    assert.equal(
      withRollbackProbeFixture(options, (path) => classifyQuarantinedRollback(path)),
      category,
      name,
    );
  }
  assert.equal(classifyQuarantinedRollback("/missing/rollback.sqlite"), "probe_database");
});

test("CLI emits only its exact success JSON and discloses nothing on failure", () => {
  const fixture = createRollbackProbeFixture();
  const copiedProbePath = join(fixture.directory, "probe.mjs");
  const copiedProbe = ROLLBACK_PROBE_SOURCE.replace(
    'const DATABASE_PATH = "/backups/rollback.sqlite";',
    `const DATABASE_PATH = ${JSON.stringify(fixture.databasePath)};`,
  );
  writeFileSync(copiedProbePath, copiedProbe, { mode: 0o500 });
  try {
    const success = spawnSync(process.execPath, [realpathSync(copiedProbePath)], {
      encoding: "utf8",
    });
    assert.equal(success.status, 0);
    assert.equal(success.stdout, ROLLBACK_PROBE_SUCCESS);
    assert.equal(success.stderr, "");

    const invalidFixture = createRollbackProbeFixture({ transaction: true });
    const invalidProbePath = join(invalidFixture.directory, "probe.mjs");
    writeFileSync(
      invalidProbePath,
      copiedProbe.replace(
        JSON.stringify(fixture.databasePath),
        JSON.stringify(invalidFixture.databasePath),
      ),
      { mode: 0o500 },
    );
    try {
      const failure = spawnSync(process.execPath, [realpathSync(invalidProbePath)], {
        encoding: "utf8",
      });
      assert.notEqual(failure.status, 0);
      assert.equal(
        failure.stdout,
        '{"operation":"rollback_quarantine_raw_verify","status":"failed","category":"probe_transaction"}\n',
      );
      assert.equal(failure.stderr, "");
      assert.doesNotMatch(
        failure.stdout + failure.stderr,
        /encrypted-client-secret|oidc-upgrade-rehearsal|private|ciphertext|configurationFingerprint|response|error/u,
      );
    } finally {
      rmSync(invalidFixture.directory, { force: true, recursive: true });
    }
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test("maps only bounded raw probe status and output combinations", () => {
  assert.equal(
    classifyV0131RollbackProbeResult(
      0,
      '{"operation":"rollback_quarantine_raw_verify","status":"ok"}\n',
    ),
    null,
  );
  assert.equal(
    classifyV0131RollbackProbeResult(
      1,
      '{"operation":"rollback_quarantine_raw_verify","status":"failed","category":"probe_database"}\n',
    ),
    "rollback_v0131_probe_database",
  );
  for (const category of ["identity", "discovery", "timestamp", "transaction"]) {
    assert.equal(
      classifyV0131RollbackProbeResult(
        1,
        `{"operation":"rollback_quarantine_raw_verify","status":"failed","category":"probe_${category}"}\n`,
      ),
      `rollback_v0131_probe_${category}`,
    );
  }
  assert.equal(
    classifyV0131RollbackProbeResult(125, "private docker stderr\n"),
    "rollback_v0131_probe_container",
  );
  for (const [status, output] of [
    [2, ""],
    [1, "private output\n"],
    [1, '{"operation":"rollback_quarantine_raw_verify","status":"failed","category":"private"}\n'],
    [0, '{"operation":"rollback_quarantine_raw_verify","status":"ok","private":"value"}\n'],
  ]) {
    assert.equal(classifyV0131RollbackProbeResult(status, output), "rollback_v0131_probe_invalid");
  }
});

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

test("accepts only a running gateway on one private container address", () => {
  assert.equal(runningContainerState("true:0", "gateway_state"), true);
  assert.equal(privateContainerAddress("172.19.0.2", "gateway_address"), "172.19.0.2");

  assert.throws(() => runningContainerState("false:1", "gateway_state"), /gateway_state_exited/u);
  assert.throws(() => runningContainerState("unknown", "gateway_state"), /gateway_state_invalid/u);
  for (const address of ["", "127.0.0.1", "8.8.8.8", "172.19.0.2\n172.19.0.3", "::1"]) {
    assert.throws(
      () => privateContainerAddress(address, "gateway_address"),
      /gateway_address_invalid/u,
    );
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

test("selects the v0.13.1 exception only for the exact signed digest", () => {
  const legacyPrevious = `ghcr.io/rezanmz/omnifin@${V0131_DIGEST}`;
  const almostLegacyPrevious = `ghcr.io/rezanmz/omnifin@${V0131_DIGEST.slice(0, -1)}0`;
  assert.equal(usesV0131RollbackCompatibility(V0131_DIGEST), true);
  assert.equal(usesV0131RollbackCompatibility(`${V0131_DIGEST.slice(0, -1)}0`), false);

  const evidence = {
    candidate: { image: CANDIDATE_IMAGE, migrationCount: 18, schemaSha256: "c".repeat(64) },
    previous: { image: legacyPrevious, migrationCount: 17, schemaSha256: "d".repeat(64) },
    rollback: { migrationCount: 17, schemaSha256: "d".repeat(64) },
  };
  const baseChecks = [
    "previous_runtime_verified",
    "previous_state_seeded",
    "backup_verified",
    "candidate_runtime_verified",
    "candidate_state_verified",
    "candidate_backup_verified",
    "rollback_backup_verified",
    ROLLBACK_V0131_EXCEPTION_CHECK,
    "rollback_state_verified",
  ];
  assert.equal(upgradeRehearsalReport({ ...evidence, checks: baseChecks }).status, "passed");
  assert.throws(
    () =>
      upgradeRehearsalReport({
        ...evidence,
        checks: baseChecks.filter((check) => check !== ROLLBACK_V0131_EXCEPTION_CHECK),
      }),
    /rehearsal_checks_invalid/u,
  );
  assert.throws(
    () =>
      upgradeRehearsalReport({
        ...evidence,
        previous: { ...evidence.previous, image: almostLegacyPrevious },
        checks: baseChecks,
      }),
    /rehearsal_checks_invalid/u,
  );
  assert.equal(
    failedUpgradeRehearsalReport(
      new Error("private"),
      {
        candidate: immutableOmnifinImage(CANDIDATE_IMAGE),
        previous: immutableOmnifinImage(almostLegacyPrevious),
      },
      [ROLLBACK_V0131_EXCEPTION_CHECK],
    ).checks.length,
    0,
  );
});

test("accepts only the quarantined v0.13.1 admin error", () => {
  assert.equal(
    validateV0131RollbackAdminError({
      body: { error: { code: "oidc_provider_configuration_unavailable" } },
      status: 503,
    }),
    true,
  );
  for (const response of [
    { body: { error: { code: "oidc_provider_configuration_unavailable" } }, status: 200 },
    { body: { error: { code: "internal_error" } }, status: 503 },
    { body: { error: {} }, status: 503 },
    { body: { error: "oidc_provider_configuration_unavailable" }, status: 503 },
    { body: null, status: 503 },
  ]) {
    assert.throws(
      () => validateV0131RollbackAdminError(response),
      /rollback_v0131_admin_error_invalid/u,
    );
  }
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
    assert.equal(
      occurrences.length,
      3,
      `${option} must protect gateway, maintenance, and probe runs`,
    );
  }
  assert.doesNotMatch(HARNESS_SOURCE, /"--publish"/u);
  assert.doesNotMatch(HARNESS_SOURCE, /\.NetworkSettings\.Ports/u);
  assert.match(HARNESS_SOURCE, /\.State\.Running/u);
  assert.match(HARNESS_SOURCE, /\.NetworkSettings\.Networks/u);
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
    "scripts/release/verify-v0131-quarantined-rollback.mjs",
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

test("keeps the raw rollback probe isolated and sanitized", () => {
  for (const option of [
    /"--network",\s*"none"/u,
    '"--read-only"',
    /"--cap-drop",\s*"ALL"/u,
    /"--security-opt",\s*"no-new-privileges"/u,
    '"--pids-limit"',
    '"--memory"',
    '"--cpus"',
    ":/backups:ro",
    ":/opt/omnifin/bin/verify-v0131-quarantined-rollback.mjs:ro",
    '"--entrypoint"',
  ]) {
    assert.match(
      PROBE_HARNESS_SOURCE,
      typeof option === "string" ? new RegExp(option, "u") : option,
    );
  }
  assert.doesNotMatch(
    PROBE_HARNESS_SOURCE,
    /encryptionFile|recoveryFile|omnifin_encryption_key|omnifin_recovery_secret/u,
  );
  assert.match(ROLLBACK_PROBE_SOURCE, /export function verifyQuarantinedRollback\(databasePath/u);
  assert.match(ROLLBACK_PROBE_SOURCE, /new DatabaseSync\(databasePath, \{ readOnly: true \}\)/u);
  assert.match(ROLLBACK_PROBE_SOURCE, /const DATABASE_PATH = "\/backups\/rollback\.sqlite"/u);
  assert.match(ROLLBACK_PROBE_SOURCE, /PRAGMA query_only=ON/u);
  assert.match(ROLLBACK_PROBE_SOURCE, /from oidc_providers/u);
  assert.match(ROLLBACK_PROBE_SOURCE, /from auth_transactions where provider_id = \?/u);
  assert.match(ROLLBACK_PROBE_SOURCE, /rollback_quarantine_raw_verify.*status.*ok/u);
  assert.doesNotMatch(
    ROLLBACK_PROBE_SOURCE,
    /console\.|JSON\.stringify\(provider|encryptedClientSecret\)/u,
  );
  assert.doesNotMatch(PROBE_HARNESS_SOURCE, /error\.(?:stderr|cause|message)/u);
  assert.doesNotMatch(PROBE_HARNESS_SOURCE, /new RehearsalFailure\([^)]*,\s*\{\s*cause/u);
  assert.doesNotMatch(PROBE_HARNESS_SOURCE, /throw error(?:;|\n)/u);
});

test("passes the production gateway runtime contract", () => {
  const gatewayStart = HARNESS_SOURCE.slice(
    HARNESS_SOURCE.indexOf("function startGateway"),
    HARNESS_SOURCE.indexOf("function stopGateway"),
  );
  assert.match(gatewayStart, /`\$\{resources\.backupVolume\}:\/backups`/u);
  assert.match(gatewayStart, /"OMNIFIN_BACKUP_DIRECTORY=\/backups"/u);
  assert.match(gatewayStart, /`OMNIFIN_IMAGE_REF=\$\{image\.reference\}`/u);
});

test("uses the prior image to restore the original backup and retains candidate evidence", () => {
  assert.match(
    HARNESS_SOURCE,
    /function restorePreviousState\(resources, priorImage, previous\)[\s\S]*?runMaintenance\(\s*resources,\s*priorImage,[\s\S]*?candidate-pre-rollback\.sqlite/u,
  );
  assert.match(
    HARNESS_SOURCE,
    /const candidateRollback = restorePreviousState\(resources, options\.previous, previous\)/u,
  );
  assert.match(HARNESS_SOURCE, /"\/backups\/previous\.sqlite"/u);
  assert.match(HARNESS_SOURCE, /"\/backups\/candidate-pre-rollback\.sqlite"/u);
});

test("validates sanitized previous-restore evidence against source and rollback backups", () => {
  const sourceDatabaseSha256 = "a".repeat(64);
  const publishedDatabaseSha256 = "b".repeat(64);
  const rollbackDatabaseSha256 = "c".repeat(64);
  const rollbackSchemaSha256 = "d".repeat(64);
  const previous = { databaseSha256: sourceDatabaseSha256 };
  const rollback = {
    databaseSha256: rollbackDatabaseSha256,
    migrationCount: 18,
    schemaSha256: rollbackSchemaSha256,
  };
  const restored = {
    databaseSha256: publishedDatabaseSha256,
    rollback: { ...rollback },
    sanitizedDatabaseSha256: publishedDatabaseSha256,
    sourceDatabaseSha256,
  };

  assert.equal(validatePreviousRestoreEvidence(restored, previous, rollback), true);
  assert.notEqual(restored.databaseSha256, previous.databaseSha256);
});

test("rejects missing and malformed previous-restore digests", () => {
  const evidence = {
    previous: { databaseSha256: "a".repeat(64) },
    restored: {
      databaseSha256: "b".repeat(64),
      rollback: {
        databaseSha256: "c".repeat(64),
        migrationCount: 18,
        schemaSha256: "d".repeat(64),
      },
      sanitizedDatabaseSha256: "b".repeat(64),
      sourceDatabaseSha256: "a".repeat(64),
    },
    rollback: {
      databaseSha256: "c".repeat(64),
      migrationCount: 18,
      schemaSha256: "d".repeat(64),
    },
  };

  for (const [name, mutate] of [
    ["source", (value) => delete value.restored.sourceDatabaseSha256],
    ["published", (value) => (value.restored.databaseSha256 = "B".repeat(64))],
    ["sanitized", (value) => (value.restored.sanitizedDatabaseSha256 = "not-a-sha256")],
    ["rollback database", (value) => delete value.restored.rollback.databaseSha256],
    ["rollback schema", (value) => (value.rollback.schemaSha256 = "e".repeat(63))],
  ]) {
    const candidate = structuredClone(evidence);
    mutate(candidate);
    assert.throws(
      () =>
        validatePreviousRestoreEvidence(candidate.restored, candidate.previous, candidate.rollback),
      /previous_restore_invalid/u,
      name,
    );
  }
});

test("rejects source and published database identity mismatches", () => {
  const sourceDatabaseSha256 = "a".repeat(64);
  const publishedDatabaseSha256 = "b".repeat(64);
  const rollback = {
    databaseSha256: "c".repeat(64),
    migrationCount: 18,
    schemaSha256: "d".repeat(64),
  };
  const previous = { databaseSha256: sourceDatabaseSha256 };
  const restored = {
    databaseSha256: publishedDatabaseSha256,
    rollback: { ...rollback },
    sanitizedDatabaseSha256: publishedDatabaseSha256,
    sourceDatabaseSha256,
  };

  for (const mutate of [
    (value) => (value.restored.sourceDatabaseSha256 = "e".repeat(64)),
    (value) => (value.restored.sanitizedDatabaseSha256 = "f".repeat(64)),
    (value) => (value.restored.sanitizedDatabaseSha256 = sourceDatabaseSha256),
    (value) => {
      value.restored.databaseSha256 = sourceDatabaseSha256;
      value.restored.sanitizedDatabaseSha256 = sourceDatabaseSha256;
    },
  ]) {
    const candidate = {
      previous: { ...previous },
      restored: { ...restored, rollback: { ...restored.rollback } },
      rollback: { ...rollback },
    };
    mutate(candidate);
    assert.throws(
      () =>
        validatePreviousRestoreEvidence(candidate.restored, candidate.previous, candidate.rollback),
      /previous_restore_invalid/u,
    );
  }
});

test("rejects every candidate rollback evidence mismatch", () => {
  const previous = { databaseSha256: "a".repeat(64) };
  const rollback = {
    databaseSha256: "c".repeat(64),
    migrationCount: 18,
    schemaSha256: "d".repeat(64),
  };
  const restored = {
    databaseSha256: "b".repeat(64),
    rollback: { ...rollback },
    sanitizedDatabaseSha256: "b".repeat(64),
    sourceDatabaseSha256: previous.databaseSha256,
  };

  for (const mutate of [
    (value) => (value.restored.rollback.databaseSha256 = "e".repeat(64)),
    (value) => (value.restored.rollback.schemaSha256 = "f".repeat(64)),
    (value) => (value.restored.rollback.migrationCount = 19),
    (value) => (value.rollback.databaseSha256 = "e".repeat(64)),
    (value) => (value.rollback.schemaSha256 = "f".repeat(64)),
    (value) => (value.rollback.migrationCount = 19),
  ]) {
    const candidate = {
      previous: { ...previous },
      restored: { ...restored, rollback: { ...restored.rollback } },
      rollback: { ...rollback },
    };
    mutate(candidate);
    assert.throws(
      () =>
        validatePreviousRestoreEvidence(candidate.restored, candidate.previous, candidate.rollback),
      /previous_restore_invalid/u,
    );
  }
});
