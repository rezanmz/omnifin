#!/usr/bin/env node

import { resolve } from "node:path";

import { runIntegration, SERVICES } from "./run.mjs";

const strict = process.argv.includes("--strict");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;

if (outputIndex >= 0 && !output) {
  process.stderr.write("--output requires a path.\n");
  process.exitCode = 64;
} else {
  process.exitCode = await runIntegration({
    mode: "live",
    output: output ? resolve(output) : null,
    services: [...SERVICES],
    strict,
  });
}
