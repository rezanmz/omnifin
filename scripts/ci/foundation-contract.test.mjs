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
    "  image: ${OMNIFIN_IMAGE:?Set OMNIFIN_IMAGE from the release environment file}",
    "  init: true",
    "  read_only: true",
    "  cap_drop: [ALL]",
    "  security_opt: [no-new-privileges:true]",
    "  pids_limit: 256",
    "  stop_grace_period: 30s",
    '  logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }',
    '  tmpfs: ["/tmp:size=64m,mode=1777"]',
    "services:",
    "  gateway:",
    "    <<: *service",
    "    mem_limit: 768m",
    "    cpus: 2.0",
    "    environment:",
    "      OMNIFIN_IMAGE_REF: ${OMNIFIN_IMAGE:?Set OMNIFIN_IMAGE from the release environment file}",
    "    volumes: [omnifin_data:/data]",
    "    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:4000/readyz] }",
    "  maintenance:",
    "    <<: *service",
    "    mem_limit: 768m",
    "    cpus: 2.0",
    "    environment:",
    "      NODE_ENV: production",
    "      OMNIFIN_BACKUP_DIRECTORY: /backups",
    "      OMNIFIN_BASE_URL: ${OMNIFIN_BASE_URL:-http://localhost:3000}",
    "      OMNIFIN_ENCRYPTION_KEY_FILE: /run/secrets/omnifin_encryption_key",
    "      OMNIFIN_GATEWAY_HEALTH_URL: http://gateway:4000/healthz",
    "      OMNIFIN_GATEWAY_READY_URL: http://gateway:4000/readyz",
    "      OMNIFIN_IMAGE_REF: ${OMNIFIN_IMAGE:?Set OMNIFIN_IMAGE from the release environment file}",
    "    secrets: [omnifin_encryption_key]",
    "    volumes: [omnifin_data:/data]",
    "  web:",
    "    <<: *service",
    "    mem_limit: 1g",
    "    cpus: 2.0",
    '    ports: ["127.0.0.1:3000:3000"]',
    '    tmpfs: ["/tmp:size=64m,mode=1777", "/opt/omnifin/web/.next/cache:size=256m,uid=65532,gid=65532,mode=0700", "/opt/omnifin/web/apps/web/.next/cache:size=256m,uid=65532,gid=65532,mode=0700"]',
    "    depends_on: { gateway: { condition: service_healthy } }",
    "    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:3000/healthz] }",
    "secrets:",
    "  omnifin_encryption_key:",
    "    file: ${OMNIFIN_ENCRYPTION_KEY_FILE:-./secrets/omnifin_encryption_key}",
    "  omnifin_recovery_secret:",
    "    file: ${OMNIFIN_RECOVERY_SECRET_FILE:-./secrets/omnifin_recovery_secret}",
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
    "  container:",
    "    steps:",
    "      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
    "        with:",
    "          version: ${{ env.PNPM_VERSION }}",
    "      - run: pnpm install --frozen-lockfile --ignore-scripts",
    "      - run: node scripts/ci/foundation-contract.mjs --compose-policy",
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

test("rejects a maintenance service that mounts the recovery secret", async () => {
  await withRepository(
    (files) => {
      files["compose.yaml"] = files["compose.yaml"].replace(
        "    secrets: [omnifin_encryption_key]",
        "    secrets: [omnifin_encryption_key, omnifin_recovery_secret]",
      );
    },
    async (root) => {
      await assert.rejects(
        checkFoundationContract({ root }),
        /maintenance service must mount only the encryption-key secret/u,
      );
    },
  );
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
        "    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:4000/readyz] }",
        '    ports: ["4000:4000"]\n    healthcheck: { test: [CMD, healthcheck, http://127.0.0.1:4000/readyz] }',
      );
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /gateway must not publish/u);
    },
  );
});

const composePolicyFailures = [
  ["a missing memory limit", "mem_limit: 768m", /exact standalone memory limit/u],
  ["a missing CPU limit", "cpus: 2.0", /exact standalone CPU limit/u],
  ["a missing PID limit", "pids_limit: 256", /pids_limit to exactly 256/u],
  ["a missing stop grace period", "stop_grace_period: 30s", /stop_grace_period to exactly 30s/u],
  [
    "a missing log rotation policy",
    '  logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }',
    /exact json-file rotation/u,
  ],
  ["an incorrect gateway health target", "4000/readyz", /gateway must healthcheck \/readyz/u],
];

for (const [description, fragment, expectedMessage] of composePolicyFailures) {
  test(`rejects Compose with ${description}`, async () => {
    await withRepository(
      (files) => {
        files["compose.yaml"] = files["compose.yaml"].replace(fragment, "");
      },
      async (root) => {
        await assert.rejects(checkFoundationContract({ root }), expectedMessage);
      },
    );
  });
}

test("rejects a gateway without the canonical data volume", async () => {
  await withRepository(
    (files) => {
      files["compose.yaml"] = files["compose.yaml"].replace(
        "    volumes: [omnifin_data:/data]\n    healthcheck:",
        "    healthcheck:",
      );
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /gateway must mount.*\/data/u);
    },
  );
});

test("rejects an incorrect web health target", async () => {
  await withRepository(
    (files) => {
      files["compose.yaml"] = files["compose.yaml"].replace("3000/healthz", "3000/readyz");
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /web must healthcheck \/healthz/u);
    },
  );
});

test("rejects maintenance without the canonical data volume", async () => {
  await withRepository(
    (files) => {
      const lines = files["compose.yaml"].split("\n");
      lines.splice(lines.lastIndexOf("    volumes: [omnifin_data:/data]"), 1);
      files["compose.yaml"] = lines.join("\n");
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /maintenance must mount.*\/data/u);
    },
  );
});

test("rejects any non-loopback web publication", async () => {
  await withRepository(
    (files) => {
      files["compose.yaml"] = files["compose.yaml"].replace(
        '    ports: ["127.0.0.1:3000:3000"]',
        '    ports: ["127.0.0.1:3000:3000", "3000:3000"]',
      );
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /web socket must bind to loopback/u);
    },
  );
});

test("rejects non-portable environment-backed deployment secrets", async () => {
  await withRepository(
    (files) => {
      files["compose.yaml"] = files["compose.yaml"].replace(
        "    file: ${OMNIFIN_ENCRYPTION_KEY_FILE:-./secrets/omnifin_encryption_key}",
        "    environment: OMNIFIN_ENCRYPTION_KEY",
      );
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /portable file-backed secret/u);
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

test("rejects a Compose policy lane that uses pnpm without its pinned setup", async () => {
  await withRepository(
    (files) => {
      files[".github/workflows/ci.yml"] = files[".github/workflows/ci.yml"].replace(
        "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      );
    },
    async (root) => {
      await assert.rejects(
        checkFoundationContract({ root }),
        /container Compose policy lane must use the pinned pnpm setup action/u,
      );
    },
  );
});

test("rejects a non-blocking foundation step", async () => {
  await withRepository(
    (files) => {
      files[".github/workflows/ci.yml"] = [
        "name: CI",
        "jobs:",
        "  quality:",
        "    steps:",
        "      - run: pnpm foundation:check",
        "        continue-on-error: true",
        "",
      ].join("\n");
    },
    async (root) => {
      await assert.rejects(checkFoundationContract({ root }), /must fail closed/u);
    },
  );
});
