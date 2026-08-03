import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

function repositoryFile(name) {
  return readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
}

function ignoreEntries(name) {
  return new Set(
    repositoryFile(name)
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith("#")),
  );
}

function isCoveredByGenericSidecarRule(entries, path) {
  const basename = path.split("/").at(-1);

  return [...entries].some((entry) => {
    if (entry.startsWith("**/*")) {
      return basename.endsWith(entry.slice(4));
    }

    if (entry.startsWith("*") && !entry.includes("/")) {
      return basename.endsWith(entry.slice(1));
    }

    return false;
  });
}

test("the security audit covers production and development dependencies", () => {
  const rootPackage = JSON.parse(repositoryFile("package.json"));
  assert.equal(rootPackage.scripts["security:audit"], "pnpm audit --audit-level low");
  assert.doesNotMatch(rootPackage.scripts["security:audit"], /--(?:dev|prod)/u);
});

test("known vulnerable transitive tools resolve to reviewed patched versions", () => {
  const workspace = parse(repositoryFile("pnpm-workspace.yaml"));
  assert.equal(workspace.overrides["brace-expansion"], "5.0.9");
  assert.equal(workspace.overrides.esbuild, "0.28.1");
  assert.equal(workspace.overrides.postcss, "8.5.24");
  assert.equal(workspace.overrides.tmp, "0.2.7");
  assert.equal(workspace.overrides.uuid, "11.1.1");
  assert.equal(
    workspace.patchedDependencies["brace-expansion@5.0.9"],
    "patches/brace-expansion@5.0.9.patch",
  );

  const compatibilityPatch = repositoryFile("patches/brace-expansion@5.0.9.patch");
  assert.match(compatibilityPatch, /module\.exports = expand/u);
  assert.match(compatibilityPatch, /EXPANSION_MAX_LENGTH/u);
});

test("root lint covers repository automation", () => {
  const rootPackage = JSON.parse(repositoryFile("package.json"));
  assert.match(rootPackage.scripts.lint, /pnpm lint:root/u);
  assert.match(rootPackage.scripts["lint:root"], /scripts/u);
  assert.match(rootPackage.scripts["lint:root"], /docker/u);
});

test("the shared image does not allocate writable storage implicitly", () => {
  const dockerfile = repositoryFile("Dockerfile");
  assert.doesNotMatch(dockerfile, /^VOLUME\b/mu);

  const patches = dockerfile.indexOf("COPY patches patches");
  const install = dockerfile.indexOf("pnpm install --frozen-lockfile");
  assert.ok(patches >= 0 && patches < install);

  assert.match(dockerfile, /npm run build-release/u);
  assert.match(dockerfile, /\/out\/gateway\/node_modules\/\*\/better-sqlite3/u);
  assert.match(dockerfile, /rm -rf "\$better_sqlite_dir\/prebuilds"/u);
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.12@sha256:[a-f0-9]{64}$/mu);
  assert.match(dockerfile, /ARG NODE_IMAGE=node:24\.18\.0-trixie-slim@sha256:[a-f0-9]{64}/u);

  assert.match(
    dockerfile,
    /ARG RUNTIME_IMAGE=gcr\.io\/distroless\/nodejs24-debian13:nonroot@sha256:[a-f0-9]{64}/u,
  );
  assert.match(dockerfile, /^USER 65532:65532$/mu);
  assert.match(
    dockerfile,
    /COPY --from=runtime-layout --chown=65532:65532 --chmod=0700 \/layout\/data \/data/u,
  );
  assert.match(
    dockerfile,
    /COPY --from=runtime-layout --chown=65532:65532 --chmod=0700 \/layout\/backups \/backups/u,
  );
  assert.match(
    dockerfile,
    /^ENTRYPOINT \["\/nodejs\/bin\/node", "\/opt\/omnifin\/bin\/entrypoint\.mjs"\]$/mu,
  );
  assert.doesNotMatch(
    dockerfile.slice(dockerfile.indexOf("FROM ${RUNTIME_IMAGE} AS runtime")),
    /^(?:RUN|VOLUME)\b/mu,
  );

  const entrypoint = repositoryFile("docker/entrypoint.mjs");
  assert.match(entrypoint, /process\.execve\(process\.execPath/u);
  assert.match(entrypoint, /maintenance: \["\/opt\/omnifin\/gateway\/dist\/maintenance\.js"\]/u);
  assert.doesNotMatch(entrypoint, /(?:spawn|exec|fork)Sync/u);

  const compose = repositoryFile("compose.yaml");
  assert.match(compose, /uid=65532,gid=65532/u);
  assert.match(compose, /^  maintenance:$/mu);
  assert.match(compose, /OMNIFIN_GATEWAY_HEALTH_URL: http:\/\/gateway:4000\/healthz/u);
  assert.match(compose, /create_host_path: false/u);
  assert.doesNotMatch(compose, /uid=10001|gid=10001/u);
});

test("the Docker build context excludes local and sensitive output", () => {
  const ignored = ignoreEntries(".dockerignore");

  for (const required of [
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    ".git",
    ".turbo",
    "artifacts",
    "**/data",
    "**/*.db",
    "**/*.db-shm",
    "**/*.db-wal",
    "**/*.key",
    "**/.lighthouseci",
    "**/.next",
    "**/*.p12",
    "**/*.pem",
    "**/*.sqlite",
    "**/*.sqlite3",
    "**/*.tsbuildinfo",
    "**/coverage",
    "**/dist",
    "**/node_modules",
    "**/playwright-report",
    "**/secrets",
    "**/storybook-static",
    "**/test-results",
    "*.log",
    "docker/secrets/*",
  ]) {
    assert.ok(ignored.has(required), `Expected .dockerignore to include ${required}`);
  }
});

test("SQLite sidecars stay outside Git and nested Docker build contexts", () => {
  const gitIgnored = ignoreEntries(".gitignore");
  const dockerIgnored = ignoreEntries(".dockerignore");

  for (const required of ["*-wal", "*-shm", "*-journal"]) {
    assert.ok(gitIgnored.has(required), `Expected .gitignore to include ${required}`);
    assert.ok(
      dockerIgnored.has(`**/${required}`),
      `Expected .dockerignore to include **/${required}`,
    );
  }

  for (const sentinel of [
    "runtime/omnifin.sqlite-wal",
    "apps/gateway/data/omnifin.sqlite3-shm",
    "services/control-plane/state/custom-name-journal",
  ]) {
    assert.ok(
      isCoveredByGenericSidecarRule(gitIgnored, sentinel),
      `Expected Git to ignore the SQLite sidecar sentinel ${sentinel}`,
    );
    assert.ok(
      isCoveredByGenericSidecarRule(dockerIgnored, sentinel),
      `Expected the Docker context to ignore the SQLite sidecar sentinel ${sentinel}`,
    );
  }
});

test("generated integration artifacts stay outside Git and Docker build contexts", () => {
  assert.ok(ignoreEntries(".gitignore").has("artifacts/"));
  assert.ok(ignoreEntries(".dockerignore").has("artifacts"));
});
