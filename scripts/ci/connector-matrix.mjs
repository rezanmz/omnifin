import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readReadinessLedger, SERVICES } from "../integration/readiness.mjs";

const globalPatterns = [
  /^\.github\/workflows\/integration(?:-live)?\.yml$/u,
  /^compose\.integration\.ya?ml$/u,
  /^deploy\/integration\//u,
  /^docker\/integration\//u,
  /^scripts\/integration\//u,
  /^tests\/integration\/(?:fixtures|shared)\//u,
  /^apps\/gateway\/src\/connectors\//u,
  /^packages\/connectors\/src\/(?!.*(?:oidc|authentik|jellyfin|seerr|radarr|sonarr|bazarr|prowlarr|qbittorrent|sabnzbd))/u,
  /^pnpm-lock\.yaml$/u,
];
const authPattern =
  /^(?:apps\/gateway\/(?:src\/auth\/|test\/auth)|packages\/contracts\/(?:src|test)\/auth\.)/u;

export function selectConnectorServices(changedFiles, { emptyBase = false, readiness }) {
  const fixtureReadyServices = SERVICES.filter(
    (service) => readiness.services[service].fixture === "ready",
  );
  if (fixtureReadyServices.length === 0) {
    throw new Error("At least one fixture integration service must be marked ready");
  }

  const explicitlySelected = new Set();
  for (const file of changedFiles) {
    for (const service of SERVICES) {
      if (file.toLowerCase().includes(service)) explicitlySelected.add(service);
    }
    if (authPattern.test(file)) {
      explicitlySelected.add("oidc");
      explicitlySelected.add("authentik");
      explicitlySelected.add("jellyfin");
    }
  }

  const globalChange = changedFiles.some((file) =>
    globalPatterns.some((pattern) => pattern.test(file)),
  );
  if (globalChange) {
    const selected = new Set(fixtureReadyServices);
    // The repository's one-time foundation PR starts from an empty bootstrap
    // commit and must establish the ledger before pending identity suites exist.
    // Every later global change preserves explicitly selected pending services.
    if (!emptyBase) {
      for (const service of explicitlySelected) selected.add(service);
    }
    return SERVICES.filter((service) => selected.has(service));
  }

  if (explicitlySelected.size === 0) return fixtureReadyServices;
  return SERVICES.filter((service) => explicitlySelected.has(service));
}

async function main() {
  const readiness = readReadinessLedger();
  const eventName = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) throw new Error("GITHUB_OUTPUT is required");

  let selectedServices;
  if (eventName !== "pull_request") {
    selectedServices = SERVICES.filter(
      (service) => readiness.services[service].fixture === "ready",
    );
  } else {
    const baseSha = process.env.OMNIFIN_BASE_SHA ?? "";
    const headSha = process.env.OMNIFIN_HEAD_SHA ?? "";
    const fullShaPattern = /^[0-9a-f]{40}$/u;
    if (!fullShaPattern.test(baseSha) || !fullShaPattern.test(headSha)) {
      throw new Error("Pull request integration selection requires full base and head SHAs");
    }

    const changedFiles = execFileSync("git", ["diff", "--name-only", `${baseSha}...${headSha}`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const baseFiles = execFileSync("git", ["ls-tree", "--name-only", "-r", baseSha], {
      encoding: "utf8",
    }).trim();
    selectedServices = selectConnectorServices(changedFiles, {
      emptyBase: baseFiles.length === 0,
      readiness,
    });
  }

  const matrix = JSON.stringify({ service: selectedServices });
  await appendFile(outputFile, `matrix=${matrix}\n`, "utf8");
  process.stdout.write(`Integration services: ${selectedServices.join(", ")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
