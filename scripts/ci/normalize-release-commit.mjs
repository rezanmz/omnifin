import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const fullShaPattern = /^[0-9a-f]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const releaseBranchPattern = /^release-please--branches--main--components--[A-Za-z0-9._-]+$/u;
const releaseTitlePattern = /^chore\(release\): prepare 0\.\d+\.\d+$/u;
const allowedFiles = Object.freeze([
  ".release-please-manifest.json",
  "CHANGELOG.md",
  "package.json",
]);
const maximumFileBytes = 512 * 1_024;
const maximumTotalBytes = 1_024 * 1_024;
export const pullRequestBaseReadAttempts = 15;
export const pullRequestHeadReadAttempts = 15;
const pullRequestPropagationReadDelayMs = 2_000;
export const gitSafetyArguments = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
]);

export class PullRequestBaseNotReadyError extends Error {
  constructor() {
    super("The release pull request does not yet report the exact protected main SHA.");
    this.name = "PullRequestBaseNotReadyError";
  }
}

function requireFullSha(value, label) {
  if (!fullShaPattern.test(value ?? "")) throw new Error(`${label} must be a full lowercase SHA.`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} cannot contain credentials, a query, or a fragment.`);
  }
  return url.href.replace(/\/$/u, "");
}

export function validateGitHubEndpoints({ apiUrl, graphqlUrl, serverUrl }) {
  const api = new URL(apiUrl);
  const graphql = new URL(graphqlUrl);
  const server = new URL(serverUrl);
  if (server.pathname !== "/") {
    throw new Error("GITHUB_SERVER_URL must identify the GitHub origin root.");
  }
  if (server.hostname === "github.com") {
    if (
      api.origin !== "https://api.github.com" ||
      api.pathname !== "/" ||
      graphql.origin !== "https://api.github.com" ||
      graphql.pathname !== "/graphql"
    ) {
      throw new Error("GitHub.com API endpoints must use the canonical api.github.com URLs.");
    }
  } else if (
    api.origin !== server.origin ||
    api.pathname !== "/api/v3" ||
    graphql.origin !== server.origin ||
    graphql.pathname !== "/api/graphql"
  ) {
    throw new Error("GitHub Enterprise API endpoints must remain on the server origin.");
  }
}

export function releaseConfiguration(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY ?? "";
  if (!repositoryPattern.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must identify one repository.");
  }
  if (!environment.GH_TOKEN) {
    throw new Error("GH_TOKEN is required to normalize the release commit.");
  }
  const runId = environment.GITHUB_RUN_ID ?? "";
  const runAttempt = environment.GITHUB_RUN_ATTEMPT ?? "";
  if (!/^\d+$/u.test(runId) || !/^\d+$/u.test(runAttempt)) {
    throw new Error("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be decimal integers.");
  }
  if (!environment.GITHUB_WORKSPACE || !path.isAbsolute(environment.GITHUB_WORKSPACE)) {
    throw new Error("GITHUB_WORKSPACE must be an absolute path.");
  }
  let releasePullRequest;
  try {
    releasePullRequest = JSON.parse(environment.RELEASE_PR_JSON ?? "");
  } catch {
    throw new Error("RELEASE_PR_JSON must contain the Release Please pull request output.");
  }

  const apiUrl = requireUrl(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    "GITHUB_API_URL",
  );
  const graphqlUrl = requireUrl(
    environment.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql",
    "GITHUB_GRAPHQL_URL",
  );
  const serverUrl = requireUrl(
    environment.GITHUB_SERVER_URL ?? "https://github.com",
    "GITHUB_SERVER_URL",
  );
  validateGitHubEndpoints({ apiUrl, graphqlUrl, serverUrl });

  return {
    apiUrl,
    expectedBaseSha: requireFullSha(environment.EXPECTED_BASE_SHA, "EXPECTED_BASE_SHA"),
    graphqlUrl,
    releasePullRequest: validateReleasePleaseOutput(releasePullRequest),
    repository,
    runAttempt,
    runId,
    serverUrl,
    token: environment.GH_TOKEN,
    workspace: environment.GITHUB_WORKSPACE,
  };
}

export function validateReleasePleaseOutput(value) {
  const pullRequest = requireObject(value, "Release Please output");
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1) {
    throw new Error("Release Please output must contain a positive pull request number.");
  }
  if (pullRequest.baseBranchName !== "main") {
    throw new Error("Release Please output must target main.");
  }
  if (!releaseBranchPattern.test(pullRequest.headBranchName ?? "")) {
    throw new Error("Release Please output uses a non-canonical release branch.");
  }
  if (!releaseTitlePattern.test(pullRequest.title ?? "")) {
    throw new Error("Release Please output has an unexpected release title.");
  }
  return {
    baseBranchName: pullRequest.baseBranchName,
    headBranchName: pullRequest.headBranchName,
    number: pullRequest.number,
    title: pullRequest.title,
  };
}

export function validatePullRequest(pullRequestValue, config) {
  const pullRequest = requireObject(pullRequestValue, "GitHub pull request");
  if (pullRequest.number !== config.releasePullRequest.number || pullRequest.state !== "open") {
    throw new Error("The release pull request is not the expected open pull request.");
  }
  if (pullRequest.base?.repo?.full_name !== config.repository) {
    throw new Error("The release pull request base is not this repository.");
  }
  if (pullRequest.head?.repo?.full_name !== config.repository) {
    throw new Error("The release pull request must originate in this repository.");
  }
  if (
    pullRequest.base.ref !== "main" ||
    pullRequest.base.ref !== config.releasePullRequest.baseBranchName
  ) {
    throw new Error("The release pull request does not target the expected protected branch.");
  }
  const baseSha = requireFullSha(pullRequest.base.sha, "Release pull request base");
  if (baseSha !== config.expectedBaseSha) throw new PullRequestBaseNotReadyError();
  if (
    pullRequest.head.ref !== config.releasePullRequest.headBranchName ||
    !releaseBranchPattern.test(pullRequest.head.ref ?? "")
  ) {
    throw new Error("The release pull request head is not the expected canonical branch.");
  }
  if (
    pullRequest.title !== config.releasePullRequest.title ||
    !releaseTitlePattern.test(pullRequest.title ?? "")
  ) {
    throw new Error("The release pull request title changed unexpectedly.");
  }
  return {
    branch: pullRequest.head.ref,
    headSha: requireFullSha(pullRequest.head.sha, "Release pull request head"),
    title: pullRequest.title,
  };
}

export async function waitForExpectedPullRequest(config, dependencies) {
  for (let attempt = 1; attempt <= pullRequestBaseReadAttempts; attempt += 1) {
    try {
      return validatePullRequest(
        await dependencies.fetchPullRequest(config.releasePullRequest.number),
        config,
      );
    } catch (error) {
      if (!(error instanceof PullRequestBaseNotReadyError)) throw error;
      if (attempt === pullRequestBaseReadAttempts) {
        throw new Error(
          "The release pull request did not report the exact protected main SHA within the bounded propagation window.",
        );
      }
      await dependencies.pause(pullRequestPropagationReadDelayMs);
    }
  }
  throw new Error("The release pull request propagation check ended unexpectedly.");
}

export async function waitForSignedPullRequest(
  config,
  { previousHeadSha, signedSha },
  dependencies,
) {
  for (let attempt = 1; attempt <= pullRequestHeadReadAttempts; attempt += 1) {
    const release = validatePullRequest(
      await dependencies.fetchPullRequest(config.releasePullRequest.number),
      config,
    );
    if (release.headSha === signedSha) return release;
    if (release.headSha !== previousHeadSha) {
      throw new Error("The release branch moved to an unexpected commit after replacement.");
    }
    if (attempt === pullRequestHeadReadAttempts) {
      throw new Error(
        "The release pull request did not report the normalized commit within the bounded propagation window.",
      );
    }
    await dependencies.pause(pullRequestPropagationReadDelayMs);
  }
  throw new Error("The normalized release pull request propagation check ended unexpectedly.");
}

export function validateOriginalCommit(commitValue, { expectedBaseSha, headSha, title }) {
  const commit = requireObject(commitValue, "Release commit");
  if (commit.sha !== headSha) throw new Error("GitHub returned the wrong release commit.");
  if (
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    commit.parents[0]?.sha !== expectedBaseSha
  ) {
    throw new Error("The release branch must contain exactly one commit on the expected base.");
  }
  const message = commit.commit?.message;
  if (typeof message !== "string" || message.split("\n", 1)[0] !== title) {
    throw new Error("The release commit headline does not match the reviewed pull request title.");
  }
  return {
    messageBody: message.includes("\n") ? message.slice(message.indexOf("\n") + 1).trim() : "",
    treeSha: requireFullSha(commit.commit?.tree?.sha, "Release commit tree"),
    verified: commit.commit?.verification?.verified === true,
    verificationReason: commit.commit?.verification?.reason,
  };
}

export function validateComparison(comparisonValue, { expectedBaseSha, headSha }) {
  const comparison = requireObject(comparisonValue, "Release comparison");
  if (
    comparison.base_commit?.sha !== expectedBaseSha ||
    comparison.merge_base_commit?.sha !== expectedBaseSha ||
    comparison.status !== "ahead" ||
    comparison.ahead_by !== 1 ||
    comparison.behind_by !== 0 ||
    comparison.total_commits !== 1 ||
    comparison.commits?.length !== 1 ||
    comparison.commits[0]?.sha !== headSha
  ) {
    throw new Error("The release comparison is not one exact commit ahead of protected main.");
  }
  if (!Array.isArray(comparison.files)) throw new Error("The release comparison has no file list.");

  const expected = [...allowedFiles].sort();
  const actual = comparison.files.map((file) => file.filename).sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error("The release commit changes files outside the reviewed release metadata set.");
  }

  for (const file of comparison.files) {
    if (!["added", "modified"].includes(file.status) || file.previous_filename) {
      throw new Error(`Release metadata cannot rename or delete ${file.filename}.`);
    }
    if (typeof file.patch !== "string" || file.patch.length === 0) {
      throw new Error(`Release metadata must be a bounded textual change: ${file.filename}.`);
    }
    if (!Number.isSafeInteger(file.changes) || file.changes < 1 || file.changes > 10_000) {
      throw new Error(`Release metadata has an invalid change count: ${file.filename}.`);
    }
    requireFullSha(file.sha, `Release blob ${file.filename}`);
  }
  return comparison.files;
}

function decodeContent(content, file) {
  const normalized = content.replace(/\s/gu, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new Error(`GitHub returned invalid base64 for ${file}.`);
  }
  return { bytes: Buffer.from(normalized, "base64"), normalized };
}

export function prepareAdditions(files, contentResponses) {
  let totalBytes = 0;
  const additions = files.map((file) => {
    const response = requireObject(contentResponses.get(file.filename), `Content ${file.filename}`);
    if (response.type !== "file" || response.encoding !== "base64" || response.sha !== file.sha) {
      throw new Error(`GitHub returned unexpected content metadata for ${file.filename}.`);
    }
    const { bytes, normalized } = decodeContent(response.content ?? "", file.filename);
    if (response.size !== bytes.length || bytes.length > maximumFileBytes) {
      throw new Error(`Release metadata exceeds the per-file size limit: ${file.filename}.`);
    }
    totalBytes += bytes.length;
    return { contents: normalized, path: file.filename };
  });
  if (totalBytes > maximumTotalBytes) {
    throw new Error("Release metadata exceeds the aggregate size limit.");
  }
  return additions.sort((left, right) => left.path.localeCompare(right.path));
}

export function validateSignedCommit(commitValue, signatureValue, expected) {
  const commit = requireObject(commitValue, "Normalized release commit");
  const signature = requireObject(signatureValue, "Normalized release signature");
  if (commit.sha !== expected.signedSha)
    throw new Error("GitHub returned the wrong normalized commit.");
  if (commit.commit?.tree?.sha !== expected.treeSha) {
    throw new Error("The normalized release commit tree does not match Release Please.");
  }
  if (
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    commit.parents[0]?.sha !== expected.expectedBaseSha
  ) {
    throw new Error("The normalized release commit has an unexpected parent.");
  }
  if (
    signature.isValid !== true ||
    signature.wasSignedByGitHub !== true ||
    commit.commit?.verification?.verified !== true ||
    commit.commit?.verification?.reason !== "valid"
  ) {
    throw new Error("The normalized release commit is not verified and GitHub-signed.");
  }
}

function encodedReference(branch) {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function makeProductionDependencies(config) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
    "user-agent": "omnifin-release-normalizer",
    "x-github-api-version": "2022-11-28",
  };

  async function request(method, endpoint, body) {
    let response;
    try {
      response = await fetch(`${config.apiUrl}${endpoint}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`GitHub ${method} request failed.`);
    }
    if (!response.ok)
      throw new Error(`GitHub ${method} request failed with HTTP ${response.status}.`);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error(`GitHub ${method} request returned invalid JSON.`);
    }
  }

  async function graphql(query, variables) {
    let response;
    try {
      response = await fetch(config.graphqlUrl, {
        body: JSON.stringify({ query, variables }),
        headers,
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("GitHub GraphQL request failed.");
    }
    if (!response.ok)
      throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("GitHub GraphQL request returned invalid JSON.");
    }
    if (payload.errors?.length || !payload.data)
      throw new Error("GitHub rejected the signed commit mutation.");
    return payload.data;
  }

  return {
    createReference: (branch, sha) =>
      request("POST", `/repos/${config.repository}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      }),
    createSignedCommit: async ({ additions, branch, expectedHeadSha, messageBody, title }) => {
      const data = await graphql(
        `
          mutation NormalizeReleaseCommit($input: CreateCommitOnBranchInput!) {
            createCommitOnBranch(input: $input) {
              commit {
                oid
                signature {
                  isValid
                  wasSignedByGitHub
                }
                tree {
                  oid
                }
              }
              ref {
                name
                prefix
              }
            }
          }
        `,
        {
          input: {
            branch: { branchName: branch, repositoryNameWithOwner: config.repository },
            expectedHeadOid: expectedHeadSha,
            fileChanges: { additions },
            message: { body: messageBody || undefined, headline: title },
          },
        },
      );
      return data.createCommitOnBranch;
    },
    deleteReference: (branch) =>
      request("DELETE", `/repos/${config.repository}/git/refs/heads/${encodedReference(branch)}`),
    fetchComparison: (base, head) =>
      request("GET", `/repos/${config.repository}/compare/${base}...${head}`),
    fetchContent: (file, ref) =>
      request(
        "GET",
        `/repos/${config.repository}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
      ),
    fetchCommit: (sha) => request("GET", `/repos/${config.repository}/commits/${sha}`),
    fetchPullRequest: (number) => request("GET", `/repos/${config.repository}/pulls/${number}`),
    fetchReference: (branch) =>
      request("GET", `/repos/${config.repository}/git/ref/heads/${encodedReference(branch)}`),
    pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    replaceWithLease: async ({ branch, expectedHeadSha, signedSha, temporaryBranch }) => {
      const remote = `${config.serverUrl}/${config.repository}.git`;
      const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      await execFile(
        "git",
        [
          ...gitSafetyArguments,
          "fetch",
          "--no-tags",
          "--depth=1",
          remote,
          `refs/heads/${temporaryBranch}`,
        ],
        { cwd: config.workspace, env: gitEnvironment, timeout: 60_000 },
      );
      await execFile(
        "git",
        [
          ...gitSafetyArguments,
          "push",
          "--porcelain",
          `--force-with-lease=refs/heads/${branch}:${expectedHeadSha}`,
          remote,
          `${signedSha}:refs/heads/${branch}`,
        ],
        { cwd: config.workspace, env: gitEnvironment, timeout: 60_000 },
      );
    },
  };
}

export async function normalizeReleaseCommit(
  config,
  dependencies = makeProductionDependencies(config),
) {
  const release = await waitForExpectedPullRequest(config, dependencies);
  const originalCommit = validateOriginalCommit(await dependencies.fetchCommit(release.headSha), {
    expectedBaseSha: config.expectedBaseSha,
    headSha: release.headSha,
    title: release.title,
  });
  const files = validateComparison(
    await dependencies.fetchComparison(config.expectedBaseSha, release.headSha),
    { expectedBaseSha: config.expectedBaseSha, headSha: release.headSha },
  );
  const contentResponses = new Map(
    await Promise.all(
      files.map(async (file) => [
        file.filename,
        await dependencies.fetchContent(file.filename, release.headSha),
      ]),
    ),
  );
  const additions = prepareAdditions(files, contentResponses);

  if (originalCommit.verified && originalCommit.verificationReason === "valid") {
    return { normalized: false, sha: release.headSha };
  }

  const temporaryBranch = `automation/release-signing/${config.runId}-${config.runAttempt}-${randomUUID()}`;
  let temporaryCreated = false;
  try {
    const reference = await dependencies.createReference(temporaryBranch, config.expectedBaseSha);
    temporaryCreated = true;
    if (
      reference?.ref !== `refs/heads/${temporaryBranch}` ||
      reference?.object?.sha !== config.expectedBaseSha
    ) {
      throw new Error("GitHub created an unexpected temporary signing reference.");
    }

    const mutation = await dependencies.createSignedCommit({
      additions,
      branch: temporaryBranch,
      expectedHeadSha: config.expectedBaseSha,
      messageBody: originalCommit.messageBody,
      title: release.title,
    });
    const signedSha = requireFullSha(mutation?.commit?.oid, "Normalized release commit");
    if (
      mutation?.ref?.name !== temporaryBranch ||
      mutation?.ref?.prefix !== "refs/heads/" ||
      mutation?.commit?.tree?.oid !== originalCommit.treeSha
    ) {
      throw new Error(
        "GitHub created a normalized commit with unexpected reference or tree metadata.",
      );
    }
    const signedCommit = await dependencies.fetchCommit(signedSha);
    validateSignedCommit(signedCommit, mutation.commit.signature, {
      expectedBaseSha: config.expectedBaseSha,
      signedSha,
      treeSha: originalCommit.treeSha,
    });

    const beforePush = await dependencies.fetchPullRequest(config.releasePullRequest.number);
    const beforePushRelease = validatePullRequest(beforePush, config);
    if (beforePushRelease.headSha !== release.headSha) {
      throw new Error("The release branch moved while its signed replacement was prepared.");
    }

    await dependencies.replaceWithLease({
      branch: release.branch,
      expectedHeadSha: release.headSha,
      signedSha,
      temporaryBranch,
    });

    const finalReference = await dependencies.fetchReference(release.branch);
    if (finalReference?.object?.sha !== signedSha) {
      throw new Error("The release branch did not resolve to the normalized commit.");
    }
    await waitForSignedPullRequest(
      config,
      { previousHeadSha: release.headSha, signedSha },
      dependencies,
    );
    const confirmedReference = await dependencies.fetchReference(release.branch);
    if (confirmedReference?.object?.sha !== signedSha) {
      throw new Error("The normalized release branch did not remain on the verified commit.");
    }
    return { normalized: true, sha: signedSha };
  } finally {
    if (temporaryCreated) await dependencies.deleteReference(temporaryBranch);
  }
}

async function main() {
  const config = releaseConfiguration();
  const result = await normalizeReleaseCommit(config);
  process.stdout.write(
    result.normalized
      ? `Release pull request now points to verified commit ${result.sha}.\n`
      : `Release pull request already points to verified commit ${result.sha}.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
