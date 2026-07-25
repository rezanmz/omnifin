import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const ignoredDirectories = new Set([".git", ".next", ".turbo", "node_modules"]);

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(entryPath)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
  }

  return files;
}

function localTargets(markdown) {
  const targets = [];
  const pattern = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const target = match[1];
    if (target) targets.push(decodeURIComponent(target.split("#", 1)[0] ?? ""));
  }
  return targets.filter(Boolean);
}

const missing = [];
for (const file of await collectMarkdownFiles(repositoryRoot)) {
  const markdown = await readFile(file, "utf8");
  for (const target of localTargets(markdown)) {
    const resolved = target.startsWith("/")
      ? path.join(repositoryRoot, target)
      : path.resolve(path.dirname(file), target);
    try {
      await access(resolved);
    } catch {
      missing.push(`${path.relative(repositoryRoot, file)} -> ${target}`);
    }
  }
}

if (missing.length > 0) {
  console.error(`Broken local documentation links:\n${missing.join("\n")}`);
  process.exitCode = 1;
} else {
  process.stdout.write("All local documentation links resolve.\n");
}
