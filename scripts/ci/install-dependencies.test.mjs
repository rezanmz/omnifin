import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const installer = path.resolve("scripts/ci/install-dependencies.sh");

async function fakePnpm({ failures }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnifin-install-retry-"));
  const executable = path.join(directory, "pnpm");
  const counter = path.join(directory, "attempts");
  const argumentsFile = path.join(directory, "arguments");
  await writeFile(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
attempt=0
if [[ -f "$INSTALL_ATTEMPTS_FILE" ]]; then attempt="$(cat "$INSTALL_ATTEMPTS_FILE")"; fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$INSTALL_ATTEMPTS_FILE"
printf '%s\\n' "$*" >> "$INSTALL_ARGUMENTS_FILE"
if (( attempt <= INSTALL_FAILURES )); then exit 42; fi
`,
  );
  await chmod(executable, 0o755);
  return { argumentsFile, counter, directory, failures };
}

test("dependency installation retries transient failures and preserves arguments", async () => {
  const fixture = await fakePnpm({ failures: 2 });
  const result = spawnSync(installer, ["--ignore-scripts"], {
    encoding: "utf8",
    env: {
      ...process.env,
      INSTALL_ARGUMENTS_FILE: fixture.argumentsFile,
      INSTALL_ATTEMPTS_FILE: fixture.counter,
      INSTALL_FAILURES: String(fixture.failures),
      INSTALL_RETRY_DELAY_SECONDS: "0",
      PATH: `${fixture.directory}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(fixture.counter, "utf8"), "3");
  assert.deepEqual((await readFile(fixture.argumentsFile, "utf8")).trim().split("\n"), [
    "install --frozen-lockfile --ignore-scripts",
    "install --frozen-lockfile --ignore-scripts",
    "install --frozen-lockfile --ignore-scripts",
  ]);
});

test("dependency installation keeps the final failure status", async () => {
  const fixture = await fakePnpm({ failures: 3 });
  const result = spawnSync(installer, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      INSTALL_ARGUMENTS_FILE: fixture.argumentsFile,
      INSTALL_ATTEMPTS_FILE: fixture.counter,
      INSTALL_FAILURES: String(fixture.failures),
      INSTALL_RETRY_DELAY_SECONDS: "0",
      PATH: `${fixture.directory}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 42);
  assert.equal(await readFile(fixture.counter, "utf8"), "3");
  assert.match(result.stderr, /failed after 3 attempts/u);
});
