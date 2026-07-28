import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredWorkflows = Object.freeze([
  { file: "ci.yml", name: "CI" },
  { file: "security.yml", name: "Security" },
]);
const fullShaPattern = /^[0-9a-f]{40}$/u;
const githubQueryAttempts = 4;
const retryableGithubStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

export function evaluateWorkflowRuns(runs, { repository, sha }) {
  const matching = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "main" &&
        run.event === "push" &&
        run.head_repository?.full_name === repository,
    )
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
  const latest = matching[0];
  if (!latest || latest.status !== "completed") return { state: "pending" };
  if (latest.conclusion !== "success") {
    return { state: "failed", conclusion: latest.conclusion ?? "unknown", url: latest.html_url };
  }
  return { state: "success", url: latest.html_url };
}

function parseArguments(arguments_) {
  const options = { requireMainTip: false, sha: null, waitSeconds: 0 };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--require-main-tip") options.requireMainTip = true;
    else if (argument === "--sha") options.sha = arguments_[++index];
    else if (argument === "--wait-seconds") options.waitSeconds = Number(arguments_[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!fullShaPattern.test(options.sha ?? "")) {
    throw new Error("--sha must be a full lowercase commit SHA.");
  }
  if (
    !Number.isInteger(options.waitSeconds) ||
    options.waitSeconds < 0 ||
    options.waitSeconds > 1_800
  ) {
    throw new Error("--wait-seconds must be an integer from 0 through 1800.");
  }
  return options;
}

function configuration(environment) {
  const repository = environment.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must identify one repository.");
  }
  if (!environment.GITHUB_TOKEN)
    throw new Error("GITHUB_TOKEN is required to inspect workflow runs.");
  return {
    apiUrl: environment.GITHUB_API_URL ?? "https://api.github.com",
    repository,
    token: environment.GITHUB_TOKEN,
  };
}

function retryDelay(response, attempt) {
  const retryAfterHeader = response?.headers.get("retry-after");
  if (retryAfterHeader !== null && retryAfterHeader !== undefined) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(retryAfter * 1_000, 15_000);
    }
  }
  return 1_000 * 2 ** attempt;
}

export async function githubJson(url, config, dependencies = {}) {
  const request = dependencies.fetch ?? fetch;
  const wait =
    dependencies.wait ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < githubQueryAttempts; attempt += 1) {
    let response;
    try {
      response = await request(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${config.token}`,
          "user-agent": "omnifin-main-gate",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt === githubQueryAttempts - 1) {
        throw new Error("GitHub gate query failed after bounded network retries.");
      }
      await wait(1_000 * 2 ** attempt);
      continue;
    }

    if (!response.ok) {
      if (!retryableGithubStatuses.has(response.status) || attempt === githubQueryAttempts - 1) {
        throw new Error(`GitHub gate query failed with HTTP ${response.status}.`);
      }
      await wait(retryDelay(response, attempt));
      continue;
    }

    try {
      return await response.json();
    } catch {
      if (attempt === githubQueryAttempts - 1) {
        throw new Error("GitHub gate query returned invalid JSON after bounded retries.");
      }
      await wait(1_000 * 2 ** attempt);
    }
  }

  throw new Error("GitHub gate query exhausted its retry budget.");
}

export function validateMainBranch(branch, sha) {
  if (branch?.protected !== true) {
    throw new Error("The main branch is not protected.");
  }
  if (branch.commit?.sha !== sha) {
    throw new Error("The verified commit is no longer the current main tip.");
  }
}

async function verifyMainTip(sha, config) {
  const branch = await githubJson(
    `${config.apiUrl}/repos/${config.repository}/branches/main`,
    config,
  );
  validateMainBranch(branch, sha);
}

async function inspectGates(sha, config) {
  const results = [];
  for (const workflow of requiredWorkflows) {
    const query = new URLSearchParams({
      branch: "main",
      event: "push",
      head_sha: sha,
      per_page: "20",
    });
    const payload = await githubJson(
      `${config.apiUrl}/repos/${config.repository}/actions/workflows/${workflow.file}/runs?${query}`,
      config,
    );
    if (!Array.isArray(payload.workflow_runs)) {
      throw new Error(`GitHub returned an invalid ${workflow.name} workflow response.`);
    }
    results.push({
      ...evaluateWorkflowRuns(payload.workflow_runs, { repository: config.repository, sha }),
      name: workflow.name,
    });
  }
  return results;
}

export async function verifyMainGates(options, environment = process.env, dependencies = {}) {
  const config = configuration(environment);
  const inspect = dependencies.inspectGates ?? inspectGates;
  const verifyTip = dependencies.verifyMainTip ?? verifyMainTip;
  const deadline = Date.now() + options.waitSeconds * 1_000;
  if (options.requireMainTip) await verifyTip(options.sha, config);

  while (true) {
    const results = await inspect(options.sha, config);
    const failed = results.find((result) => result.state === "failed");
    if (failed) {
      throw new Error(`${failed.name} concluded ${failed.conclusion} for the exact source SHA.`);
    }
    if (results.every((result) => result.state === "success")) {
      if (options.requireMainTip) await verifyTip(options.sha, config);
      return results;
    }
    if (Date.now() >= deadline) {
      const pending = results
        .filter((result) => result.state !== "success")
        .map((result) => result.name)
        .join(", ");
      throw new Error(`Required exact-SHA push gates are not successful: ${pending}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
    if (options.requireMainTip) await verifyTip(options.sha, config);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/ci/verify-main-gates.mjs --sha <full-sha> [--require-main-tip] [--wait-seconds <0-1800>]\n",
    );
    return;
  }
  const results = await verifyMainGates(options);
  process.stdout.write(
    `Exact-SHA main gates passed: ${results.map((result) => result.name).join(", ")}.\n`,
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
