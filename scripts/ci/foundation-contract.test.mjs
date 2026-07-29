import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkFoundationContract,
  REQUIRED_PUBLIC_FILES,
  REQUIRED_ROOT_SCRIPTS,
} from "./foundation-contract.mjs";

const services = [
  "oidc",
  "authentik",
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "bazarr",
  "qbittorrent",
  "sabnzbd",
];

function releaseCoverage() {
  const profiles = {};
  for (const profile of ["phase0", "phase1", "phase2", "phase3", "phase4", "phase5", "v1"]) {
    profiles[profile] = {
      fixture: profile === "phase0" ? ["jellyfin"] : services,
      live: profile === "phase0" ? [] : services,
    };
  }
  return { profiles, schemaVersion: 1, selectedProfile: "phase0" };
}

function validFiles() {
  const files = Object.fromEntries(REQUIRED_PUBLIC_FILES.map((file) => [file, "fixture\n"]));
  files.LICENSE = "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3\n";
  files["package.json"] = JSON.stringify({
    engines: { node: ">=24" },
    license: "AGPL-3.0-only",
    packageManager: "pnpm@11.9.0",
    private: true,
    scripts: Object.fromEntries(
      REQUIRED_ROOT_SCRIPTS.map((name) => [
        name,
        name === "foundation:check" ? "node scripts/ci/foundation-contract.mjs" : `run-${name}`,
      ]),
    ),
  });
  files["pnpm-workspace.yaml"] = "packages:\n  - apps/*\n  - packages/*\n";
  files["tsconfig.base.json"] = JSON.stringify({
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      strict: true,
    },
  });
  files["compose.yaml"] = [
    "x-service: &service",
    "  image: ghcr.io/rezanmz/omnifin:latest",
    "  init: true",
    "  read_only: true",
    "  cap_drop: [ALL]",
    "  security_opt: [no-new-privileges:true]",
    "services:",
    "  gateway:",
    "    <<: *service",
    "    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:4000/healthz] }",
    "  maintenance:",
    "    <<: *service",
    "  web:",
    "    <<: *service",
    '    ports: ["127.0.0.1:3000:3000"]',
    "    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:3000/healthz] }",
    "secrets:",
    "  omnifin_encryption_key: { environment: OMNIFIN_ENCRYPTION_KEY }",
    "  omnifin_recovery_secret: { environment: OMNIFIN_RECOVERY_SECRET }",
    "",
  ].join("\n");
  files["scripts/integration/readiness.json"] = JSON.stringify({
    schemaVersion: 1,
    services: Object.fromEntries(
      services.map((service) => [service, { fixture: "ready", live: "pending" }]),
    ),
  });
  files["scripts/integration/release-coverage.json"] = JSON.stringify(releaseCoverage());
  files["release-please-config.json"] = JSON.stringify({
    draft: true,
    "include-v-in-tag": true,
    "initial-version": "0.1.0",
  });
  files[".github/workflows/ci.yml"] = [
    "name: CI",
    "jobs:",
    "  quality:",
    "    steps:",
    "      - run: pnpm foundation:check",
    "",
  ].join("\n");
  files["apps/gateway/drizzle/0000_foundation.sql"] = "select 1;\n";
  return files;
}

async function withRepository(mutator, callback) {
  const root = await mkdtemp(join(tmpdir(), "omnifin-foundation-"));
  try {
    const files = validFiles();
    mutator?.(files);
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = join(root, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    }
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("accepts the complete public-project foundation contract", async () => {
  await withRepository(undefined, async (root) => {
    assert.deepEqual(await checkFoundationContract({ root }), {
      publicFileCount: REQUIRED_PUBLIC_FILES.length,
      requiredScriptCount: REQUIRED_ROOT_SCRIPTS.length,
      serviceCount: 3,
    });
  });
});

test("rejects a missing public governance file", async () => {
  await withRepository(
    (files) => delete files["SECURITY.md"],
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /SECURITY\.md is required/u);
    },
  );
});

test("rejects a deployment that publishes the gateway", async () => {
  await withRepository(
    (files) => {
      files["compose.yaml"] = files["compose.yaml"].replace(
        "    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:4000/healthz] }",
        '    ports: ["4000:4000"]\n    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:4000/healthz] }',
      );
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /gateway must not publish/u);
    },
  );
});

test("rejects a phase0 profile that claims pending live compatibility", async () => {
  await withRepository(
    (files) => {
      const coverage = releaseCoverage();
      coverage.profiles.phase0.live = ["jellyfin"];
      files["scripts/integration/release-coverage.json"] = JSON.stringify(coverage);
    },
    async (root) => {
      await assert.rejects(
        checkFoundationContract({ root }),
        /phase0\.live requires pending coverage/u,
      );
    },
  );
});

test("rejects CI that can bypass the foundation check", async () => {
  await withRepository(
    (files) => {
      files[".github/workflows/ci.yml"] = "name: CI\njobs: { quality: { steps: [] } }\n";
    },
    async (root) => {
      await assert.rejects(
        checkFoundationContract({ root }),
        /must execute pnpm foundation:check/u,
      );
    },
  );
});
