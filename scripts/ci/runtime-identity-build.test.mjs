import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function workflow(relativePath) {
  return parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function stepByName(job, name) {
  return job.steps.find((step) => step.name === name);
}

test("the image embeds a fail-closed development runtime identity by default", () => {
  const dockerfile = readFileSync(path.join(repositoryRoot, "Dockerfile"), "utf8");

  assert.match(dockerfile, /^ARG CHANNEL=development$/mu);
  assert.match(dockerfile, /^ARG VERSION=0\.0\.0-dev$/mu);
  assert.match(dockerfile, /^ARG REVISION=unknown$/mu);
  assert.match(dockerfile, /^ARG SOURCE_URL=https:\/\/github\.com\/rezanmz\/omnifin$/mu);
  for (const variable of ["CHANNEL", "VERSION", "REVISION", "SOURCE_URL"]) {
    assert.match(dockerfile, new RegExp(`OMNIFIN_BUILD_${variable}=\\$\\{${variable}\\}`, "u"));
  }
  assert.match(dockerfile, /org\.opencontainers\.image\.source="\$\{SOURCE_URL\}"/u);
  assert.match(dockerfile, /\/layout\/build-identity\.json/u);
  assert.match(
    dockerfile,
    /COPY --from=runtime-layout[^\n]+\/layout\/build-identity\.json \/opt\/omnifin\/build-identity\.json/u,
  );
});

test("edge candidates bind their API identity to the verified protected-main source", () => {
  const edge = workflow(".github/workflows/edge.yml");
  const buildJob = edge.jobs["build-candidate"];
  const identity = stepByName(buildJob, "Derive runtime identity");
  const build = stepByName(buildJob, "Build candidate archive without edge aliases");

  assert.equal(identity.id, "runtime");
  assert.equal(identity.env.VERIFIED_SHA, "${{ github.event.workflow_run.head_sha }}");
  assert.match(identity.run, /package\.json/u);
  assert.match(identity.run, /-edge/u);
  assert.match(identity.run, /GITHUB_OUTPUT/u);
  assert.match(build.with["build-args"], /CHANNEL=edge/u);
  assert.match(build.with["build-args"], /VERSION=\$\{\{ steps\.runtime\.outputs\.version \}\}/u);
  assert.match(
    build.with["build-args"],
    /REVISION=\$\{\{ github\.event\.workflow_run\.head_sha \}\}/u,
  );
  assert.match(
    build.with["build-args"],
    /SOURCE_URL=https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/tree\/\$\{\{ github\.event\.workflow_run\.head_sha \}\}/u,
  );
});

test("stable candidates bind their API identity to the immutable release source", () => {
  const publish = workflow(".github/workflows/publish.yml");
  const build = stepByName(
    publish.jobs["build-candidate"],
    "Build multi-architecture OCI candidate",
  );

  assert.match(build.with["build-args"], /CHANNEL=stable/u);
  assert.match(build.with["build-args"], /VERSION=\$\{\{ inputs\.version \}\}/u);
  assert.match(build.with["build-args"], /REVISION=\$\{\{ inputs\.release_sha \}\}/u);
  assert.match(
    build.with["build-args"],
    /SOURCE_URL=https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/tree\/\$\{\{ inputs\.release_sha \}\}/u,
  );
});
