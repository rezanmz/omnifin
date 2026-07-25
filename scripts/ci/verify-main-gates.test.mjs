import assert from "node:assert/strict";
import test from "node:test";

import { evaluateWorkflowRuns, validateMainBranch, verifyMainGates } from "./verify-main-gates.mjs";

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
