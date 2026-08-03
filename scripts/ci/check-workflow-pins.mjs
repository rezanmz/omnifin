import { execFileSync } from "node:child_process";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isScalar, LineCounter, parseDocument, visit } from "yaml";

const remoteActionPattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@([0-9a-f]{40})$/u;
const annotationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function parseActionReference(reference, version, line) {
  if (reference.startsWith("./")) return { line, local: true, reference };
  const pin = reference.match(remoteActionPattern);
  return {
    line,
    local: false,
    reference,
    sha: pin?.[1] ?? null,
    version,
  };
}

export function parseUses(contents, file = "<memory>") {
  const lineCounter = new LineCounter();
  const document = parseDocument(contents, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${file} is not valid YAML: ${document.errors[0].message}`);
  }

  const actions = [];
  visit(document, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "uses") return;
      if (!isScalar(pair.value) || typeof pair.value.value !== "string") {
        const line = lineCounter.linePos(pair.key.range[0]).line;
        throw new Error(`${file}:${line} uses must be a literal string.`);
      }
      const line = lineCounter.linePos(pair.key.range[0]).line;
      const comment = typeof pair.value.comment === "string" ? pair.value.comment.trim() : "";
      const version = annotationPattern.test(comment) ? comment : null;
      actions.push(parseActionReference(pair.value.value, version, line));
    },
  });
  return actions;
}

function actionRepository(reference) {
  return reference.split("@", 1)[0].split("/").slice(0, 2).join("/");
}

export function resolvePublicTag(
  repository,
  version,
  { attempts = 3, execute = execFileSync } = {},
) {
  const url = `https://github.com/${repository}.git`;
  let output;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      output = execute(
        "git",
        [
          "-c",
          "credential.helper=",
          "ls-remote",
          url,
          `refs/tags/${version}`,
          `refs/tags/${version}^{}`,
        ],
        {
          encoding: "utf8",
          env: {
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            PATH: process.env.PATH,
          },
          timeout: 30_000,
        },
      );
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (output === undefined) throw lastError;
  const refs = new Map(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/u);
        return [ref, sha];
      }),
  );
  return refs.get(`refs/tags/${version}^{}`) ?? refs.get(`refs/tags/${version}`) ?? null;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function localReferenceFiles(reference, root, sourceFile) {
  const requested = path.resolve(root, reference);
  if (!isWithin(root, requested)) {
    throw new Error(`${sourceFile} references a local action outside the repository: ${reference}`);
  }

  let target;
  try {
    target = await realpath(requested);
  } catch {
    throw new Error(`${sourceFile} references a missing local action: ${reference}`);
  }
  const realRoot = await realpath(root);
  if (!isWithin(realRoot, target)) {
    throw new Error(`${sourceFile} references a local action outside the repository: ${reference}`);
  }

  const targetStats = await stat(target);
  if (targetStats.isFile() && /\.ya?ml$/u.test(target)) return [target];
  if (!targetStats.isDirectory()) {
    throw new Error(
      `${sourceFile} local action is not a directory or reusable workflow: ${reference}`,
    );
  }

  const manifests = [];
  for (const name of ["action.yml", "action.yaml"]) {
    const candidate = path.join(target, name);
    if (await exists(candidate)) {
      const manifest = await realpath(candidate);
      if (!isWithin(realRoot, manifest)) {
        throw new Error(`${sourceFile} references an action manifest outside the repository.`);
      }
      manifests.push(manifest);
    }
  }
  if (manifests.length > 0) return manifests;
  if (await exists(path.join(target, "Dockerfile"))) return [];
  throw new Error(
    `${sourceFile} local action has no action.yml, action.yaml, or Dockerfile: ${reference}`,
  );
}

export async function checkWorkflowPins({ remote = false, root = process.cwd() } = {}) {
  const repositoryRoot = path.resolve(root);
  const workflowsDirectory = path.join(repositoryRoot, ".github/workflows");
  const workflowFiles = (await readdir(workflowsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => path.join(workflowsDirectory, entry.name))
    .sort();
  const problems = [];
  const remoteReferences = [];
  const pendingFiles = [...workflowFiles];
  const visitedFiles = new Set();

  while (pendingFiles.length > 0) {
    const file = pendingFiles.shift();
    if (visitedFiles.has(file)) continue;
    visitedFiles.add(file);
    const contents = await readFile(file, "utf8");
    const actions = parseUses(contents, path.relative(repositoryRoot, file));
    for (const action of actions) {
      if (action.local) {
        try {
          pendingFiles.push(
            ...(await localReferenceFiles(
              action.reference,
              repositoryRoot,
              `${path.relative(repositoryRoot, file)}:${action.line}`,
            )),
          );
        } catch (error) {
          problems.push(error.message);
        }
        continue;
      }
      if (!action.sha) {
        problems.push(
          `${path.relative(repositoryRoot, file)}:${action.line} uses ${action.reference}`,
        );
        continue;
      }
      if (remote && !action.version) {
        problems.push(
          `${path.relative(repositoryRoot, file)}:${action.line} has no immutable version annotation`,
        );
        continue;
      }
      remoteReferences.push({ ...action, file });
    }
  }

  if (remote && problems.length === 0) {
    const resolutions = new Map();
    for (const action of remoteReferences) {
      const repository = actionRepository(action.reference);
      const key = `${repository}@${action.version}`;
      let resolved = resolutions.get(key);
      if (resolved === undefined) {
        try {
          resolved = resolvePublicTag(repository, action.version);
        } catch {
          resolved = null;
        }
        resolutions.set(key, resolved);
      }
      if (resolved !== action.sha) {
        problems.push(
          `${path.relative(repositoryRoot, action.file)}:${action.line} pins ${action.sha}, but ${repository}@${action.version} resolves to ${resolved ?? "nothing"}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    const heading = remote
      ? "Every remote action pin must match its public immutable version tag:"
      : "Every remote action must be pinned to a full 40-character commit SHA:";
    throw new Error(`${heading}\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }

  return { remoteActionCount: remoteReferences.length, workflowCount: workflowFiles.length };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: node scripts/ci/check-workflow-pins.mjs [--remote]\n");
    return;
  }
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--remote");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const remote = process.argv.includes("--remote");
  const result = await checkWorkflowPins({ remote });
  process.stdout.write(
    `Verified ${result.remoteActionCount} ${remote ? "publicly resolved " : ""}pinned remote action references across ${result.workflowCount} workflows.\n`,
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
