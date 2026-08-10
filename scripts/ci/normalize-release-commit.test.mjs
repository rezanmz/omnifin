import assert from "node:assert/strict";
import test from "node:test";

import {
  gitCommandTimeoutMs,
  gitSafetyArguments,
  normalizeReleaseCommit,
  replaceWithLease,
  prepareAdditions,
  pullRequestBaseReadAttempts,
  pullRequestHeadReadAttempts,
  releaseReferenceReadAttempts,
  temporaryReferenceFetchAttempts,
  temporaryReferenceFetchRetryDelaysMs,
  releaseConfiguration,
  validateComparison,
  validateGitHubEndpoints,
  validateOriginalCommit,
  validatePullRequest,
  validateReleasePleaseOutput,
  validateSignedCommit,
  waitForExpectedPullRequest,
  waitForSignedPullRequest,
  waitForSignedReference,
} from "./normalize-release-commit.mjs";

const repository = "rezanmz/omnifin";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const signedSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const releaseBranch = "release-please--branches--main--components--omnifin";
const releaseTitle = "chore(release): prepare 0.5.3";
const fileContents = new Map([
  [".release-please-manifest.json", '{".":"0.5.3"}\n'],
  ["CHANGELOG.md", "# Changelog\n\n## 0.5.3\n"],
  ["package.json", '{"name":"omnifin","version":"0.5.3"}\n'],
]);
const blobShas = new Map([
  [".release-please-manifest.json", "e".repeat(40)],
  ["CHANGELOG.md", "f".repeat(40)],
  ["package.json", "1".repeat(40)],
]);

function releaseOutput(overrides = {}) {
  return {
    baseBranchName: "main",
    headBranchName: releaseBranch,
    number: 150,
    title: releaseTitle,
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return {
    apiUrl: "https://api.github.com",
    expectedBaseSha: baseSha,
    graphqlUrl: "https://api.github.com/graphql",
    releasePullRequest: releaseOutput(),
    repository,
    runAttempt: "1",
    runId: "42",
    serverUrl: "https://github.com",
    token: "test-token",
    workspace: "/tmp/workspace",
    ...overrides,
  };
}

function pullRequest(currentHead = headSha, overrides = {}) {
  return {
    base: { ref: "main", repo: { full_name: repository }, sha: baseSha },
    head: { ref: releaseBranch, repo: { full_name: repository }, sha: currentHead },
    number: 150,
    state: "open",
    title: releaseTitle,
    ...overrides,
  };
}

function commit(sha = headSha, overrides = {}) {
  return {
    commit: {
      message: releaseTitle,
      tree: { sha: treeSha },
      verification: { reason: "unsigned", verified: false },
    },
    parents: [{ sha: baseSha }],
    sha,
    ...overrides,
  };
}

function comparison(overrides = {}) {
  return {
    ahead_by: 1,
    base_commit: { sha: baseSha },
    behind_by: 0,
    commits: [{ sha: headSha }],
    files: [...fileContents.keys()].map((filename) => ({
      changes: 2,
      filename,
      patch: "@@ -1 +1 @@",
      sha: blobShas.get(filename),
      status: "modified",
    })),
    merge_base_commit: { sha: baseSha },
    status: "ahead",
    total_commits: 1,
    ...overrides,
  };
}

function contentResponse(filename, overrides = {}) {
  const bytes = Buffer.from(fileContents.get(filename), "utf8");
  return {
    content: bytes.toString("base64"),
    encoding: "base64",
    sha: blobShas.get(filename),
    size: bytes.length,
    type: "file",
    ...overrides,
  };
}

function dependencies(options = {}) {
  let currentHead = headSha;
  let expectedBaseReads = 0;
  let finalHeadReads = 0;
  let pullRequestReads = 0;
  let referenceReads = 0;
  const calls = [];
  const dependencySet = {
    createReference: async (branch, sha) => {
      calls.push(["createReference", branch, sha]);
      return { object: { sha: baseSha }, ref: `refs/heads/${branch}` };
    },
    createSignedCommit: async (input) => {
      calls.push(["createSignedCommit", input]);
      return {
        commit: {
          oid: signedSha,
          signature: { isValid: true, wasSignedByGitHub: true },
          tree: { oid: treeSha },
        },
        ref: { name: input.branch, prefix: "refs/heads/" },
      };
    },
    deleteReference: async (branch) => calls.push(["deleteReference", branch]),
    fetchCommit: async (sha) => {
      calls.push(["fetchCommit", sha]);
      if (sha === headSha) return commit(headSha, options.originalCommit);
      if (sha === signedSha) {
        return commit(signedSha, {
          commit: {
            message: releaseTitle,
            tree: { sha: treeSha },
            verification: { reason: "valid", verified: true },
          },
          ...options.signedCommit,
        });
      }
      throw new Error(`Unexpected commit ${sha}`);
    },
    fetchComparison: async () => comparison(options.comparison),
    fetchContent: async (filename) => contentResponse(filename, options.contents?.[filename]),
    fetchPullRequest: async () => {
      pullRequestReads += 1;
      calls.push(["fetchPullRequest", currentHead]);
      if (pullRequestReads <= (options.staleBaseReads ?? 0)) {
        return pullRequest(currentHead, {
          base: { ref: "main", repo: { full_name: repository }, sha: "9".repeat(40) },
        });
      }
      expectedBaseReads += 1;
      if (options.moveBeforePush && expectedBaseReads === 2) {
        return pullRequest("9".repeat(40));
      }
      if (currentHead === signedSha) {
        finalHeadReads += 1;
        if (options.unexpectedFinalHead) return pullRequest("8".repeat(40));
        if (finalHeadReads <= (options.staleFinalHeadReads ?? 0)) {
          return pullRequest(headSha);
        }
      }
      return pullRequest(currentHead, options.pullRequest);
    },
    fetchReference: async () => {
      referenceReads += 1;
      calls.push(["fetchReference", releaseBranch]);
      const staleReference =
        currentHead === signedSha && referenceReads <= (options.staleReferenceReads ?? 0);
      return {
        ref: `refs/heads/${releaseBranch}`,
        object: {
          type: "commit",
          sha:
            options.moveReferenceAfterFinalHead && referenceReads === 2
              ? "8".repeat(40)
              : staleReference
                ? headSha
                : currentHead,
        },
      };
    },
    pause: async (milliseconds) => calls.push(["pause", milliseconds]),
    replaceWithLease: async (input) => {
      calls.push(["replaceWithLease", input]);
      if (options.temporaryFetchExhausted) {
        throw new Error("The temporary signing reference could not be fetched.");
      }
      if (options.leaseFailure) throw new Error("stale lease");
      assert.equal(input.expectedHeadSha, currentHead);
      currentHead = input.signedSha;
    },
  };
  return { calls, dependencySet };
}

function replacementInput() {
  return {
    branch: releaseBranch,
    environment: { GIT_TERMINAL_PROMPT: "0" },
    expectedHeadSha: headSha,
    remote: "https://github.com/rezanmz/omnifin.git",
    signedSha,
    temporaryBranch: "automation/release-signing/test-ref",
    workspace: "/tmp/workspace",
  };
}

function gitReplacement({ fetchErrors = [], pushError } = {}) {
  const calls = [];
  let fetchAttempts = 0;
  const runGit = async (arguments_, options) => {
    calls.push({ arguments_, options });
    if (arguments_.includes("fetch")) {
      const error = fetchErrors[fetchAttempts];
      fetchAttempts += 1;
      if (error) throw error;
    } else if (pushError) {
      throw pushError;
    }
  };
  const pauses = [];
  return {
    calls,
    fetchAttempts: () => fetchAttempts,
    pauses,
    pause: async (ms) => pauses.push(ms),
    runGit,
  };
}

test("parses only the exact release workflow context", () => {
  const result = releaseConfiguration({
    EXPECTED_BASE_SHA: baseSha,
    GH_TOKEN: "secret",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "42",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKSPACE: "/tmp/workspace",
    RELEASE_PR_JSON: JSON.stringify(releaseOutput()),
  });

  assert.equal(result.repository, repository);
  assert.deepEqual(result.releasePullRequest, releaseOutput());
  assert.equal(result.token, "secret");
});

test("rejects missing credentials and credential-bearing GitHub URLs", () => {
  const environment = {
    EXPECTED_BASE_SHA: baseSha,
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "42",
    GITHUB_WORKSPACE: "/tmp/workspace",
    RELEASE_PR_JSON: JSON.stringify(releaseOutput()),
  };
  assert.throws(() => releaseConfiguration(environment), /GH_TOKEN is required/u);
  assert.throws(
    () =>
      releaseConfiguration({
        ...environment,
        GH_TOKEN: "token",
        GITHUB_SERVER_URL: "https://token@github.com",
      }),
    /cannot contain credentials/u,
  );
});

test("binds release APIs to the canonical GitHub host", () => {
  assert.doesNotThrow(() =>
    validateGitHubEndpoints({
      apiUrl: "https://api.github.com",
      graphqlUrl: "https://api.github.com/graphql",
      serverUrl: "https://github.com",
    }),
  );
  assert.doesNotThrow(() =>
    validateGitHubEndpoints({
      apiUrl: "https://github.example/api/v3",
      graphqlUrl: "https://github.example/api/graphql",
      serverUrl: "https://github.example",
    }),
  );
  assert.throws(
    () =>
      validateGitHubEndpoints({
        apiUrl: "https://capture.example",
        graphqlUrl: "https://api.github.com/graphql",
        serverUrl: "https://github.com",
      }),
    /canonical api\.github\.com/u,
  );
  assert.throws(
    () =>
      validateGitHubEndpoints({
        apiUrl: "https://github.example/api/v3",
        graphqlUrl: "https://capture.example/api/graphql",
        serverUrl: "https://github.example",
      }),
    /remain on the server origin/u,
  );
});

test("authenticated Git operations disable hooks and inherited credential helpers", () => {
  assert.deepEqual(gitSafetyArguments, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
  ]);
});

test("retries a temporary-reference fetch timeout once, then pushes exactly once", async () => {
  const runner = gitReplacement({
    fetchErrors: [
      {
        code: null,
        killed: true,
        signal: "SIGTERM",
        stderr: "remote: injected timeout diagnostic",
      },
    ],
  });

  await replaceWithLease(replacementInput(), runner);

  assert.equal(runner.fetchAttempts(), 2);
  assert.deepEqual(runner.pauses, [temporaryReferenceFetchRetryDelaysMs[0]]);
  assert.equal(runner.calls.filter(({ arguments_ }) => arguments_.includes("fetch")).length, 2);
  assert.equal(runner.calls.filter(({ arguments_ }) => arguments_.includes("push")).length, 1);
  assert.equal(runner.calls[0].options.timeout, gitCommandTimeoutMs);
  assert.equal(runner.calls[1].options.timeout, gitCommandTimeoutMs);
  assert.equal(runner.calls[2].options.timeout, gitCommandTimeoutMs);
});

test("retries the exact temporary-reference propagation error, then pushes exactly once", async () => {
  const input = replacementInput();
  const runner = gitReplacement({
    fetchErrors: [
      {
        code: 128,
        killed: false,
        signal: null,
        stderr: `fatal: couldn't find remote ref refs/heads/${input.temporaryBranch}\n`,
      },
    ],
  });

  await replaceWithLease(input, runner);

  assert.equal(runner.fetchAttempts(), 2);
  assert.deepEqual(runner.pauses, [temporaryReferenceFetchRetryDelaysMs[0]]);
  assert.equal(runner.calls.filter(({ arguments_ }) => arguments_.includes("push")).length, 1);
});

test("exhausts temporary-reference fetch retries without pushing or leaking Git diagnostics", async () => {
  const input = replacementInput();
  const injectedStderr = `fatal: couldn't find remote ref refs/heads/${input.temporaryBranch}\n`;
  const runner = gitReplacement({
    fetchErrors: [
      { code: 128, killed: false, signal: null, stderr: injectedStderr },
      { code: 128, killed: false, signal: null, stderr: injectedStderr },
      { code: 128, killed: false, signal: null, stderr: injectedStderr },
    ],
  });

  await assert.rejects(replaceWithLease(input, runner), (error) => {
    assert.equal(error.message, "The temporary signing reference could not be fetched.");
    assert.equal(error.message.includes(input.temporaryBranch), false);
    assert.equal(error.message.includes(injectedStderr), false);
    assert.equal(error.message.includes(input.remote), false);
    return true;
  });
  assert.equal(runner.fetchAttempts(), temporaryReferenceFetchAttempts);
  assert.deepEqual(runner.pauses, temporaryReferenceFetchRetryDelaysMs);
  assert.equal(runner.calls.filter(({ arguments_ }) => arguments_.includes("push")).length, 0);
});

test("does not retry a generic or authentication exit 128 fetch failure", async () => {
  const injectedStderr =
    "fatal: Authentication failed for 'https://token@capture.example/repo.git'";
  const runner = gitReplacement({
    fetchErrors: [{ code: 128, killed: false, signal: null, stderr: injectedStderr }],
  });

  await assert.rejects(replaceWithLease(replacementInput(), runner), (error) => {
    assert.equal(error.message, "The temporary signing reference could not be fetched.");
    assert.equal(error.message.includes(injectedStderr), false);
    return true;
  });
  assert.equal(runner.fetchAttempts(), 1);
  assert.deepEqual(runner.pauses, []);
  assert.equal(runner.calls.filter(({ arguments_ }) => arguments_.includes("push")).length, 0);
});

test("never retries a push timeout, authentication failure, or lease rejection", async () => {
  for (const pushError of [
    { code: null, killed: true, signal: "SIGTERM", stderr: "injected push timeout" },
    { code: 128, killed: false, signal: null, stderr: "fatal: Authentication failed" },
    { code: 1, killed: false, signal: null, stderr: "injected stale lease diagnostic" },
  ]) {
    const runner = gitReplacement({ pushError });
    await assert.rejects(replaceWithLease(replacementInput(), runner), (error) => {
      assert.equal(error.message, "The lease-protected release branch replacement failed.");
      assert.equal(error.message.includes(pushError.stderr), false);
      return true;
    });
    assert.equal(runner.fetchAttempts(), 1);
    assert.equal(runner.calls.filter(({ arguments_ }) => arguments_.includes("push")).length, 1);
    assert.deepEqual(runner.pauses, []);
  }
});

test("accepts only canonical Release Please output", () => {
  assert.deepEqual(validateReleasePleaseOutput(releaseOutput()), releaseOutput());
  assert.throws(
    () => validateReleasePleaseOutput(releaseOutput({ headBranchName: "feature/release" })),
    /non-canonical/u,
  );
  assert.throws(
    () => validateReleasePleaseOutput(releaseOutput({ title: "chore: release 0.5.3" })),
    /unexpected release title/u,
  );
});

test("binds the pull request to the same repository, branch, base, and title", () => {
  assert.deepEqual(validatePullRequest(pullRequest(), configuration()), {
    branch: releaseBranch,
    headSha,
    title: releaseTitle,
  });
  assert.throws(
    () =>
      validatePullRequest(
        pullRequest(headSha, {
          head: { ref: releaseBranch, repo: { full_name: "fork/omnifin" }, sha: headSha },
        }),
        configuration(),
      ),
    /originate in this repository/u,
  );
  assert.throws(
    () =>
      validatePullRequest(
        pullRequest(headSha, {
          base: { ref: "main", repo: { full_name: repository }, sha: "9".repeat(40) },
        }),
        configuration(),
      ),
    /exact protected main SHA/u,
  );
  assert.throws(
    () => validatePullRequest(pullRequest(headSha, { state: "closed" }), configuration()),
    /expected open pull request/u,
  );
});

test("waits through bounded GitHub base propagation without weakening pull request identity", async () => {
  const { calls, dependencySet } = dependencies({ staleBaseReads: 2 });
  assert.deepEqual(await waitForExpectedPullRequest(configuration(), dependencySet), {
    branch: releaseBranch,
    headSha,
    title: releaseTitle,
  });
  assert.equal(calls.filter(([name]) => name === "fetchPullRequest").length, 3);
  assert.deepEqual(
    calls.filter(([name]) => name === "pause"),
    [
      ["pause", 2_000],
      ["pause", 2_000],
    ],
  );
});

test("does not retry a pull request identity mismatch", async () => {
  const { calls, dependencySet } = dependencies({
    pullRequest: {
      head: { ref: releaseBranch, repo: { full_name: "fork/omnifin" }, sha: headSha },
    },
  });
  await assert.rejects(
    waitForExpectedPullRequest(configuration(), dependencySet),
    /originate in this repository/u,
  );
  assert.equal(calls.filter(([name]) => name === "fetchPullRequest").length, 1);
  assert.equal(
    calls.some(([name]) => name === "pause"),
    false,
  );
});

test("fails closed when the pull request base never becomes exact", async () => {
  const { calls, dependencySet } = dependencies({
    staleBaseReads: pullRequestBaseReadAttempts,
  });
  await assert.rejects(
    waitForExpectedPullRequest(configuration(), dependencySet),
    /bounded propagation window/u,
  );
  assert.equal(
    calls.filter(([name]) => name === "fetchPullRequest").length,
    pullRequestBaseReadAttempts,
  );
  assert.equal(calls.filter(([name]) => name === "pause").length, pullRequestBaseReadAttempts - 1);
  assert.equal(
    calls.some(([name]) => name === "createReference"),
    false,
  );
});

test("waits through bounded signed-head propagation without accepting a third SHA", async () => {
  let reads = 0;
  const pauses = [];
  const result = await waitForSignedPullRequest(
    configuration(),
    { previousHeadSha: headSha, signedSha },
    {
      fetchPullRequest: async () => {
        reads += 1;
        return pullRequest(reads <= 2 ? headSha : signedSha);
      },
      pause: async (milliseconds) => pauses.push(milliseconds),
    },
  );

  assert.equal(result.headSha, signedSha);
  assert.equal(reads, 3);
  assert.deepEqual(pauses, [2_000, 2_000]);

  await assert.rejects(
    waitForSignedPullRequest(
      configuration(),
      { previousHeadSha: headSha, signedSha },
      {
        fetchPullRequest: async () => pullRequest("8".repeat(40)),
        pause: async () => assert.fail("unexpected head must not be retried"),
      },
    ),
    /unexpected commit after replacement/u,
  );
});

test("fails closed when signed-head propagation never converges", async () => {
  let reads = 0;
  const pauses = [];
  await assert.rejects(
    waitForSignedPullRequest(
      configuration(),
      { previousHeadSha: headSha, signedSha },
      {
        fetchPullRequest: async () => {
          reads += 1;
          return pullRequest(headSha);
        },
        pause: async (milliseconds) => pauses.push(milliseconds),
      },
    ),
    /did not report the normalized commit/u,
  );
  assert.equal(reads, pullRequestHeadReadAttempts);
  assert.equal(pauses.length, pullRequestHeadReadAttempts - 1);
});

test("waits through bounded release-reference propagation without accepting a third SHA", async () => {
  let reads = 0;
  const pauses = [];
  const result = await waitForSignedReference(
    { branch: releaseBranch, previousHeadSha: headSha, signedSha },
    {
      fetchReference: async () => {
        reads += 1;
        return {
          object: { sha: reads <= 2 ? headSha : signedSha, type: "commit" },
          ref: `refs/heads/${releaseBranch}`,
        };
      },
      pause: async (milliseconds) => pauses.push(milliseconds),
    },
  );

  assert.equal(result.object.sha, signedSha);
  assert.equal(reads, 3);
  assert.deepEqual(pauses, [2_000, 2_000]);

  await assert.rejects(
    waitForSignedReference(
      { branch: releaseBranch, previousHeadSha: headSha, signedSha },
      {
        fetchReference: async () => ({
          object: { sha: "8".repeat(40), type: "commit" },
          ref: `refs/heads/${releaseBranch}`,
        }),
        pause: async () => assert.fail("unexpected reference must not be retried"),
      },
    ),
    /unexpected commit after replacement/u,
  );
});

test("fails closed when release-reference propagation never converges", async () => {
  let reads = 0;
  const pauses = [];
  await assert.rejects(
    waitForSignedReference(
      { branch: releaseBranch, previousHeadSha: headSha, signedSha },
      {
        fetchReference: async () => {
          reads += 1;
          return {
            object: { sha: headSha, type: "commit" },
            ref: `refs/heads/${releaseBranch}`,
          };
        },
        pause: async (milliseconds) => pauses.push(milliseconds),
      },
    ),
    /bounded propagation window/u,
  );
  assert.equal(reads, releaseReferenceReadAttempts);
  assert.equal(pauses.length, releaseReferenceReadAttempts - 1);
});

test("rejects unexpected release-reference identity or object type without retrying", async () => {
  for (const reference of [
    {
      object: { sha: signedSha, type: "commit" },
      ref: "refs/heads/release-please--branches--main--components--other",
    },
    {
      object: { sha: signedSha, type: "tag" },
      ref: `refs/heads/${releaseBranch}`,
    },
  ]) {
    let paused = false;
    await assert.rejects(
      waitForSignedReference(
        { branch: releaseBranch, previousHeadSha: headSha, signedSha },
        {
          fetchReference: async () => reference,
          pause: async () => {
            paused = true;
          },
        },
      ),
      /unexpected release branch metadata/u,
    );
    assert.equal(paused, false);
  }
});

test("requires one release commit on the exact base with the reviewed title", () => {
  assert.equal(
    validateOriginalCommit(commit(), { expectedBaseSha: baseSha, headSha, title: releaseTitle })
      .treeSha,
    treeSha,
  );
  assert.throws(
    () =>
      validateOriginalCommit(commit(headSha, { parents: [{ sha: "9".repeat(40) }] }), {
        expectedBaseSha: baseSha,
        headSha,
        title: releaseTitle,
      }),
    /exactly one commit/u,
  );
  assert.throws(
    () =>
      validateOriginalCommit(
        commit(headSha, {
          commit: { message: "fix: wrong", tree: { sha: treeSha }, verification: {} },
        }),
        { expectedBaseSha: baseSha, headSha, title: releaseTitle },
      ),
    /headline/u,
  );
});

test("accepts only the exact textual release metadata comparison", () => {
  assert.equal(validateComparison(comparison(), { expectedBaseSha: baseSha, headSha }).length, 3);
  assert.throws(
    () =>
      validateComparison(
        comparison({
          files: [
            ...comparison().files,
            {
              filename: "Dockerfile",
              patch: "+x",
              sha: "2".repeat(40),
              status: "modified",
              changes: 1,
            },
          ],
        }),
        { expectedBaseSha: baseSha, headSha },
      ),
    /outside the reviewed release metadata set/u,
  );
  assert.throws(
    () =>
      validateComparison(
        comparison({
          files: comparison().files.map((file, index) =>
            index === 0 ? { ...file, previous_filename: "old.json", status: "renamed" } : file,
          ),
        }),
        { expectedBaseSha: baseSha, headSha },
      ),
    /cannot rename or delete/u,
  );
  assert.throws(
    () =>
      validateComparison(
        comparison({
          files: comparison().files.map((file, index) =>
            index === 0 ? { ...file, patch: null } : file,
          ),
        }),
        { expectedBaseSha: baseSha, headSha },
      ),
    /bounded textual change/u,
  );
  assert.throws(
    () => validateComparison(comparison({ ahead_by: 2 }), { expectedBaseSha: baseSha, headSha }),
    /one exact commit ahead/u,
  );
});

test("bounds decoded release metadata and rejects mismatched blobs", () => {
  const files = comparison().files;
  const valid = new Map(files.map((file) => [file.filename, contentResponse(file.filename)]));
  assert.deepEqual(
    prepareAdditions(files, valid).map(({ path }) => path),
    [".release-please-manifest.json", "CHANGELOG.md", "package.json"],
  );

  const wrongBlob = new Map(valid);
  wrongBlob.set("package.json", contentResponse("package.json", { sha: "2".repeat(40) }));
  assert.throws(() => prepareAdditions(files, wrongBlob), /unexpected content metadata/u);

  const oversized = new Map(valid);
  const bytes = Buffer.alloc(512 * 1_024 + 1, "x");
  oversized.set(
    "package.json",
    contentResponse("package.json", { content: bytes.toString("base64"), size: bytes.length }),
  );
  assert.throws(() => prepareAdditions(files, oversized), /per-file size limit/u);

  const aggregate = new Map(
    files.map((file) => {
      const large = Buffer.alloc(400 * 1_024, file.filename[0]);
      return [
        file.filename,
        contentResponse(file.filename, { content: large.toString("base64"), size: large.length }),
      ];
    }),
  );
  assert.throws(() => prepareAdditions(files, aggregate), /aggregate size limit/u);
});

test("requires both GraphQL and REST GitHub signature evidence and an exact tree", () => {
  const validCommit = commit(signedSha, {
    commit: {
      message: releaseTitle,
      tree: { sha: treeSha },
      verification: { reason: "valid", verified: true },
    },
  });
  assert.doesNotThrow(() =>
    validateSignedCommit(
      validCommit,
      { isValid: true, wasSignedByGitHub: true },
      {
        expectedBaseSha: baseSha,
        signedSha,
        treeSha,
      },
    ),
  );
  assert.throws(
    () =>
      validateSignedCommit(
        validCommit,
        { isValid: true, wasSignedByGitHub: false },
        {
          expectedBaseSha: baseSha,
          signedSha,
          treeSha,
        },
      ),
    /not verified and GitHub-signed/u,
  );
  assert.throws(
    () =>
      validateSignedCommit(
        { ...validCommit, commit: { ...validCommit.commit, tree: { sha: "9".repeat(40) } } },
        { isValid: true, wasSignedByGitHub: true },
        { expectedBaseSha: baseSha, signedSha, treeSha },
      ),
    /tree does not match/u,
  );
});

test("creates a verified replacement and moves the release branch with an exact lease", async () => {
  const { calls, dependencySet } = dependencies();
  const result = await normalizeReleaseCommit(configuration(), dependencySet);

  assert.deepEqual(result, { normalized: true, sha: signedSha });
  const signedInput = calls.find(([name]) => name === "createSignedCommit")[1];
  assert.deepEqual(
    signedInput.additions.map(({ path }) => path),
    [".release-please-manifest.json", "CHANGELOG.md", "package.json"],
  );
  assert.deepEqual(calls.find(([name]) => name === "replaceWithLease")[1], {
    branch: releaseBranch,
    expectedHeadSha: headSha,
    signedSha,
    temporaryBranch: calls.find(([name]) => name === "createReference")[1],
  });
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("waits for the pull request head after the exact release ref is replaced", async () => {
  const { calls, dependencySet } = dependencies({ staleFinalHeadReads: 2 });
  const result = await normalizeReleaseCommit(configuration(), dependencySet);

  assert.deepEqual(result, { normalized: true, sha: signedSha });
  assert.equal(
    calls.filter(([name, milliseconds]) => name === "pause" && milliseconds === 2_000).length,
    2,
  );
});

test("waits for the exact release ref after the lease-protected replacement", async () => {
  const { calls, dependencySet } = dependencies({ staleReferenceReads: 2 });
  const result = await normalizeReleaseCommit(configuration(), dependencySet);

  assert.deepEqual(result, { normalized: true, sha: signedSha });
  assert.equal(calls.filter(([name]) => name === "fetchReference").length, 4);
  assert.equal(
    calls.filter(([name, milliseconds]) => name === "pause" && milliseconds === 2_000).length,
    2,
  );
});

test("rejects an unexpected pull request head after the exact release ref is replaced", async () => {
  const { calls, dependencySet } = dependencies({ unexpectedFinalHead: true });
  await assert.rejects(
    normalizeReleaseCommit(configuration(), dependencySet),
    /unexpected commit after replacement/u,
  );
  assert.equal(calls.filter(([name]) => name === "replaceWithLease").length, 1);
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("rejects a release ref that moves after pull request propagation", async () => {
  const { calls, dependencySet } = dependencies({ moveReferenceAfterFinalHead: true });
  await assert.rejects(
    normalizeReleaseCommit(configuration(), dependencySet),
    /unexpected commit after replacement/u,
  );
  assert.equal(calls.filter(([name]) => name === "replaceWithLease").length, 1);
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("does not rewrite an already verified exact release commit", async () => {
  const { calls, dependencySet } = dependencies({
    originalCommit: {
      commit: {
        message: releaseTitle,
        tree: { sha: treeSha },
        verification: { reason: "valid", verified: true },
      },
    },
  });
  const result = await normalizeReleaseCommit(configuration(), dependencySet);
  assert.deepEqual(result, { normalized: false, sha: headSha });
  assert.equal(
    calls.some(([name]) => name === "createReference"),
    false,
  );
});

test("leaves the release branch untouched when it moves before replacement", async () => {
  const { calls, dependencySet } = dependencies({ moveBeforePush: true });
  await assert.rejects(normalizeReleaseCommit(configuration(), dependencySet), /moved while/u);
  assert.equal(
    calls.some(([name]) => name === "replaceWithLease"),
    false,
  );
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("cleans the temporary reference when the atomic lease rejects the push", async () => {
  const { calls, dependencySet } = dependencies({ leaseFailure: true });
  await assert.rejects(normalizeReleaseCommit(configuration(), dependencySet), /stale lease/u);
  assert.equal(calls.filter(([name]) => name === "replaceWithLease").length, 1);
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("cleans the temporary reference when fetch retries are exhausted", async () => {
  const { calls, dependencySet } = dependencies({ temporaryFetchExhausted: true });
  await assert.rejects(
    normalizeReleaseCommit(configuration(), dependencySet),
    /temporary signing reference could not be fetched/u,
  );
  assert.equal(calls.filter(([name]) => name === "replaceWithLease").length, 1);
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("rejects a GraphQL tree mismatch before touching the release branch", async () => {
  const { calls, dependencySet } = dependencies();
  const originalCreate = dependencySet.createSignedCommit;
  dependencySet.createSignedCommit = async (input) => {
    const result = await originalCreate(input);
    result.commit.tree.oid = "9".repeat(40);
    return result;
  };
  await assert.rejects(
    normalizeReleaseCommit(configuration(), dependencySet),
    /unexpected reference or tree/u,
  );
  assert.equal(
    calls.some(([name]) => name === "replaceWithLease"),
    false,
  );
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("rejects a GraphQL branch-name mismatch before touching the release branch", async () => {
  const { calls, dependencySet } = dependencies();
  const originalCreate = dependencySet.createSignedCommit;
  dependencySet.createSignedCommit = async (input) => {
    const result = await originalCreate(input);
    result.ref.name = "automation/release-signing/unexpected";
    return result;
  };
  await assert.rejects(
    normalizeReleaseCommit(configuration(), dependencySet),
    /unexpected reference or tree/u,
  );
  assert.equal(
    calls.some(([name]) => name === "replaceWithLease"),
    false,
  );
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});

test("rejects a GraphQL reference-prefix mismatch before touching the release branch", async () => {
  const { calls, dependencySet } = dependencies();
  const originalCreate = dependencySet.createSignedCommit;
  dependencySet.createSignedCommit = async (input) => {
    const result = await originalCreate(input);
    result.ref.prefix = "refs/tags/";
    return result;
  };
  await assert.rejects(
    normalizeReleaseCommit(configuration(), dependencySet),
    /unexpected reference or tree/u,
  );
  assert.equal(
    calls.some(([name]) => name === "replaceWithLease"),
    false,
  );
  assert.equal(calls.filter(([name]) => name === "deleteReference").length, 1);
});
