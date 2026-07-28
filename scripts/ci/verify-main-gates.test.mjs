import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateWorkflowRuns,
  githubJson,
  validateMainBranch,
  verifyMainGates,
} from "./verify-main-gates.mjs";

const repository = "rezanmz/omnifin";
const sha = "a".repeat(40);
const validRun = {
  conclusion: "success",
  event: "push",
  head_branch: "main",
  head_repository: { full_name: repository },
  head_sha: sha,
  id: 10,
  status: "completed",
};

test("accepts only a successful exact-SHA main push", () => {
  assert.equal(evaluateWorkflowRuns([validRun], { repository, sha }).state, "success");
});

test("does not accept pull-request or foreign-repository runs", () => {
  assert.equal(
    evaluateWorkflowRuns(
      [
        { ...validRun, event: "pull_request" },
        { ...validRun, head_repository: { full_name: "someone/fork" } },
      ],
      { repository, sha },
    ).state,
    "pending",
  );
});

test("the newest exact push attempt determines the gate", () => {
  assert.deepEqual(
    evaluateWorkflowRuns([validRun, { ...validRun, conclusion: "failure", id: 11 }], {
      repository,
      sha,
    }),
    { state: "failed", conclusion: "failure", url: undefined },
  );
});

test("requires main to remain protected", () => {
  assert.throws(
    () => validateMainBranch({ commit: { sha }, protected: false }, sha),
    /main branch is not protected/u,
  );
  assert.doesNotThrow(() => validateMainBranch({ commit: { sha }, protected: true }, sha));
});

test("requires the verified commit to remain the main tip", () => {
  assert.throws(
    () => validateMainBranch({ commit: { sha: "b".repeat(40) }, protected: true }, sha),
    /no longer the current main tip/u,
  );
});

test("retries bounded transient GitHub API responses", async () => {
  const statuses = [504, 429, 200];
  const delays = [];
  const payload = await githubJson(
    "https://api.github.test/gates",
    { token: "test-token" },
    {
      fetch: async () => {
        const status = statuses.shift();
        return status === 200
          ? Response.json({ workflow_runs: [] })
          : new Response(null, { headers: { "retry-after": "0" }, status });
      },
      wait: async (milliseconds) => delays.push(milliseconds),
    },
  );

  assert.deepEqual(payload, { workflow_runs: [] });
  assert.deepEqual(delays, [0, 0]);
  assert.deepEqual(statuses, []);
});

test("does not retry permanent GitHub API denials", async () => {
  let requests = 0;
  await assert.rejects(
    githubJson(
      "https://api.github.test/gates",
      { token: "test-token" },
      {
        fetch: async () => {
          requests += 1;
          return new Response(null, { status: 403 });
        },
        wait: async () => undefined,
      },
    ),
    /HTTP 403/u,
  );
  assert.equal(requests, 1);
});

test("fails closed after the bounded transient retry budget", async () => {
  let requests = 0;
  const delays = [];
  await assert.rejects(
    githubJson(
      "https://api.github.test/gates",
      { token: "test-token" },
      {
        fetch: async () => {
          requests += 1;
          return new Response(null, { status: 504 });
        },
        wait: async (milliseconds) => delays.push(milliseconds),
      },
    ),
    /HTTP 504/u,
  );
  assert.equal(requests, 4);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
});

test("rechecks protected main immediately before accepting successful gates", async () => {
  let mainTipChecks = 0;
  const results = await verifyMainGates(
    { requireMainTip: true, sha, waitSeconds: 0 },
    { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test-token" },
    {
      inspectGates: async () => [
        { name: "CI", state: "success" },
        { name: "Security", state: "success" },
      ],
      verifyMainTip: async () => {
        mainTipChecks += 1;
      },
    },
  );

  assert.equal(mainTipChecks, 2);
  assert.equal(results.length, 2);
});

test("fails when the final protected-main recheck detects a race", async () => {
  let mainTipChecks = 0;
  await assert.rejects(
    verifyMainGates(
      { requireMainTip: true, sha, waitSeconds: 0 },
      { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test-token" },
      {
        inspectGates: async () => [
          { name: "CI", state: "success" },
          { name: "Security", state: "success" },
        ],
        verifyMainTip: async () => {
          mainTipChecks += 1;
          if (mainTipChecks === 2) throw new Error("main moved");
        },
      },
    ),
    /main moved/u,
  );
});
