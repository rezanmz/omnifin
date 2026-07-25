import { spawnSync } from "node:child_process";
import process from "node:process";

const allowedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "OFL-1.1",
]);

const result = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 32 * 1_024 * 1_024,
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || "Unable to enumerate production dependency licenses.\n");
  process.exit(1);
}

const report = JSON.parse(result.stdout);
const rejected = Object.keys(report).filter((license) => !allowedLicenses.has(license));
if (rejected.length > 0) {
  process.stderr.write(`Disallowed or unreviewed production licenses: ${rejected.join(", ")}\n`);
  process.exit(1);
}

const packageCount = Object.values(report).reduce(
  (total, packages) => total + (Array.isArray(packages) ? packages.length : 0),
  0,
);
process.stdout.write(`License policy passed for ${packageCount} production dependency records.\n`);
