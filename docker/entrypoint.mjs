import { constants } from "node:fs";
import { access } from "node:fs/promises";
import process from "node:process";

const commandName = process.argv[2] ?? "gateway";
const commandArguments = process.argv.slice(3);

const targets = {
  gateway: ["/opt/omnifin/gateway/dist/main.js"],
  web: ["/opt/omnifin/web/apps/web/server.js", "/opt/omnifin/web/server.js"],
};

if (!(commandName in targets)) {
  process.stderr.write("Usage: omnifin {gateway|web}\n");
  process.exit(64);
}

let target;
for (const candidate of targets[commandName]) {
  try {
    await access(candidate, constants.R_OK);
    target = candidate;
    break;
  } catch {
    // Try the next supported standalone layout.
  }
}

if (!target) {
  process.stderr.write(`Omnifin ${commandName} server artifact is missing.\n`);
  process.exit(70);
}

process.execve(process.execPath, [process.execPath, target, ...commandArguments], process.env);
