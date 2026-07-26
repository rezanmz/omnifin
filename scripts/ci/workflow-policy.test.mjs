import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

function workflow(name) {
  return readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
}

function repositoryFile(name) {
  return readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
}

function workflowDocument(name) {
  return parse(workflow(name));
}

function namedStep(steps, name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `Expected workflow step: ${name}`);
  return step;
}

test("CI reruns pull request title policy after title edits", () => {
  const source = workflow("ci.yml");
  const pullRequest = source.slice(source.indexOf("  pull_request:"), source.indexOf("  push:"));
  assert.match(pullRequest, /\n\s+types:\n(?:\s+- .+\n)*\s+- edited\n/u);
});

test("CI installs actionlint from a checksum-pinned release", () => {
  const source = workflow("ci.yml");
  const validation = source.slice(
    source.indexOf("- name: Validate workflow syntax and expressions"),
    source.indexOf("- name: Install pnpm"),
  );

  assert.match(validation, /ACTIONLINT_VERSION: 1\.7\.12/u);
  assert.match(validation, /ACTIONLINT_SHA256: [a-f0-9]{64}/u);
  assert.match(validation, /sha256sum --check --strict/u);
  assert.match(validation, /actionlint_\$\{ACTIONLINT_VERSION\}_linux_amd64\.tar\.gz/u);
  assert.match(validation, /"\$install_dir\/actionlint" \.github\/workflows\/\*\.yml/u);
  assert.doesNotMatch(validation, /latest/u);
});

test("security workflow creates the SBOM output directory before generation", () => {
  const source = workflow("security.yml");
  const prepare = source.indexOf("- name: Prepare SBOM output directory");
  const generate = source.indexOf("- name: Generate SPDX JSON SBOM");
  assert.notEqual(prepare, -1);
  assert.ok(prepare < generate);
  assert.match(source.slice(prepare, generate), /run: mkdir --parents artifacts/u);
});

test("security workflow separates complete Trivy reports from enforcement", () => {
  const document = workflowDocument("security.yml");
  const policies = [
    {
      job: "source-scan",
      report: "Report all source findings",
      vulnerabilities: "Enforce fixable source vulnerabilities",
      policy: "Enforce source secret and IaC policy",
      gate: "Enforce source scan policy",
      vulnerabilityId: "trivy-source-vulnerabilities",
      policyId: "trivy-source-policy",
    },
    {
      job: "container-scan",
      report: "Report all application image findings",
      vulnerabilities: "Enforce fixable application image vulnerabilities",
      policy: "Enforce application image secret and IaC policy",
      gate: "Enforce container scan policy",
      vulnerabilityId: "trivy-container-vulnerabilities",
      policyId: "trivy-container-policy",
    },
  ];

  for (const policy of policies) {
    const steps = document.jobs[policy.job].steps;
    const report = namedStep(steps, policy.report);
    assert.equal(report.with.scanners, "vuln,secret,misconfig");
    assert.equal(report.with.severity, "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL");
    assert.equal(report.with["ignore-unfixed"], "false");
    assert.equal(report.with["exit-code"], "0");
    assert.equal(report.with.format, "sarif");
    assert.equal(report.with["limit-severities-for-sarif"], "false");
    assert.equal(report.with.version, "v0.70.0");
    assert.equal(report["continue-on-error"], undefined);

    const vulnerabilities = namedStep(steps, policy.vulnerabilities);
    assert.equal(vulnerabilities.id, policy.vulnerabilityId);
    assert.equal(vulnerabilities.with.scanners, "vuln");
    assert.equal(vulnerabilities.with.severity, "HIGH,CRITICAL");
    assert.equal(vulnerabilities.with["ignore-unfixed"], "true");
    assert.equal(vulnerabilities.with["exit-code"], "1");
    assert.equal(vulnerabilities.with.format, "table");
    assert.equal(vulnerabilities.with["skip-setup-trivy"], "true");
    assert.equal(vulnerabilities.with.version, "v0.70.0");
    assert.equal(vulnerabilities["continue-on-error"], true);

    const scannerPolicy = namedStep(steps, policy.policy);
    assert.equal(scannerPolicy.id, policy.policyId);
    assert.equal(scannerPolicy.with.scanners, "secret,misconfig");
    assert.equal(scannerPolicy.with.severity, "HIGH,CRITICAL");
    assert.equal(scannerPolicy.with["ignore-unfixed"], undefined);
    assert.equal(scannerPolicy.with["exit-code"], "1");
    assert.equal(scannerPolicy.with.format, "table");
    assert.equal(scannerPolicy.with["skip-setup-trivy"], "true");
    assert.equal(scannerPolicy.with.version, "v0.70.0");
    assert.equal(scannerPolicy["continue-on-error"], true);

    const gate = namedStep(steps, policy.gate);
    assert.match(gate.if, new RegExp(`steps\\.${policy.vulnerabilityId}\\.outcome`, "u"));
    assert.match(gate.if, new RegExp(`steps\\.${policy.policyId}\\.outcome`, "u"));
  }
});

test("Trivy policy does not use broad workflow or repository suppressions", () => {
  const source = workflow("security.yml");
  assert.doesNotMatch(
    source,
    /^\s+(?:trivyignores|trivy-config|skip-dirs|skip-files|ignore-policy|ignore-status):/mu,
  );
  assert.equal(existsSync(new URL("../../.trivyignore", import.meta.url)), false);
  assert.equal(existsSync(new URL("../../.trivyignore.yml", import.meta.url)), false);
  assert.equal(existsSync(new URL("../../.trivyignore.yaml", import.meta.url)), false);
});

test("security image build verifies the single pinned distroless runtime reference", () => {
  const document = workflowDocument("security.yml");
  const steps = document.jobs["container-scan"].steps;
  const install = namedStep(steps, "Install Cosign");
  const verify = namedStep(steps, "Verify pinned distroless runtime signature");
  const build = namedStep(steps, "Build scan target");

  assert.equal(install.uses, "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6");
  assert.equal(install.with["cosign-release"], "v3.1.2");
  assert.ok(steps.indexOf(install) < steps.indexOf(verify));
  assert.ok(steps.indexOf(verify) < steps.indexOf(build));
  assert.match(verify.run, /mapfile -t runtime_lines/u);
  assert.match(verify.run, /grep --extended-regexp '\^ARG RUNTIME_IMAGE='/u);
  assert.match(verify.run, /runtime_image="\$\{runtime_lines\[0\]#ARG RUNTIME_IMAGE=\}"/u);
  assert.match(
    verify.run,
    /\^gcr\\\.io\/distroless\/nodejs24-debian13:nonroot@sha256:\[0-9a-f\]\{64\}\$/u,
  );
  assert.match(verify.run, /--certificate-identity keyless@distroless\.iam\.gserviceaccount\.com/u);
  assert.match(verify.run, /--certificate-oidc-issuer https:\/\/accounts\.google\.com/u);
  assert.match(verify.run, /"\$runtime_image" >\/dev\/null/u);
  assert.doesNotMatch(verify.run, /sha256:[a-f0-9]{64}/u);
  assert.doesNotMatch(verify.run, /\b(?:eval|source)\b/u);
});

test("edge and release promotion require anonymous two-platform candidate scans", () => {
  const candidates = [
    {
      file: "edge.yml",
      digestSource: "needs.build-candidate.outputs.digest",
      promote: "promote",
    },
    {
      file: "publish.yml",
      digestSource: "needs.publish-candidate.outputs.digest",
      promote: "promote-stable",
    },
  ];

  for (const candidate of candidates) {
    const source = workflow(candidate.file);
    const document = parse(source);
    const scan = document.jobs["scan-candidate"];
    assert.deepEqual(scan.permissions, { contents: "read" });
    assert.equal(scan.environment, undefined);
    assert.deepEqual(scan.strategy.matrix.target, [
      { platform: "linux/amd64", suffix: "linux-amd64" },
      { platform: "linux/arm64", suffix: "linux-arm64" },
    ]);

    const report = namedStep(scan.steps, "Report all published candidate findings");
    assert.equal(report.env.TRIVY_PLATFORM, "${{ matrix.target.platform }}");
    assert.equal(report.with["image-ref"].includes(candidate.digestSource), true);
    assert.equal(report.with.scanners, "vuln,secret,misconfig");
    assert.equal(report.with.severity, "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL");
    assert.equal(report.with["ignore-unfixed"], "false");
    assert.equal(report.with["exit-code"], "0");
    assert.equal(report.with.format, "sarif");
    assert.equal(report.with["limit-severities-for-sarif"], "false");
    assert.equal(report.with.version, "v0.70.0");

    const vulnerabilities = namedStep(scan.steps, "Enforce fixable candidate vulnerabilities");
    assert.equal(vulnerabilities.env.TRIVY_PLATFORM, "${{ matrix.target.platform }}");
    assert.equal(vulnerabilities.with.scanners, "vuln");
    assert.equal(vulnerabilities.with.severity, "HIGH,CRITICAL");
    assert.equal(vulnerabilities.with["ignore-unfixed"], "true");
    assert.equal(vulnerabilities.with.format, "table");

    const scannerPolicy = namedStep(scan.steps, "Enforce candidate secret and IaC policy");
    assert.equal(scannerPolicy.env.TRIVY_PLATFORM, "${{ matrix.target.platform }}");
    assert.equal(scannerPolicy.with.scanners, "secret,misconfig");
    assert.equal(scannerPolicy.with.severity, "HIGH,CRITICAL");
    assert.equal(scannerPolicy.with["ignore-unfixed"], undefined);
    assert.equal(scannerPolicy.with.format, "table");

    const scanSource = JSON.stringify(scan);
    assert.match(source, /Retain complete candidate scan report/u);
    assert.doesNotMatch(scanSource, /secrets\./u);
    assert.doesNotMatch(scanSource, /docker\/login-action/u);
    assert.ok(document.jobs[candidate.promote].needs.includes("scan-candidate"));
  }
});

test("each live integration matrix job receives only its service configuration", () => {
  const source = workflow("integration-live.yml");
  const serviceByVariable = {
    OMNIFIN_AUTHENTIK_ISSUER_URL: "authentik",
    OMNIFIN_BAZARR_API_KEY: "bazarr",
    OMNIFIN_BAZARR_URL: "bazarr",
    OMNIFIN_JELLYFIN_URL: "jellyfin",
    OMNIFIN_OIDC_ISSUER_URL: "oidc",
    OMNIFIN_PROWLARR_API_KEY: "prowlarr",
    OMNIFIN_PROWLARR_URL: "prowlarr",
    OMNIFIN_QBITTORRENT_PASSWORD: "qbittorrent",
    OMNIFIN_QBITTORRENT_URL: "qbittorrent",
    OMNIFIN_QBITTORRENT_USERNAME: "qbittorrent",
    OMNIFIN_RADARR_API_KEY: "radarr",
    OMNIFIN_RADARR_URL: "radarr",
    OMNIFIN_SABNZBD_API_KEY: "sabnzbd",
    OMNIFIN_SABNZBD_URL: "sabnzbd",
    OMNIFIN_SEERR_API_KEY: "seerr",
    OMNIFIN_SEERR_URL: "seerr",
    OMNIFIN_SONARR_API_KEY: "sonarr",
    OMNIFIN_SONARR_URL: "sonarr",
  };

  for (const [variable, service] of Object.entries(serviceByVariable)) {
    const line = source
      .split("\n")
      .find((candidate) => candidate.trimStart().startsWith(`${variable}:`));
    assert.ok(line, `${variable} must be configured.`);
    assert.match(line, new RegExp(`matrix\\.service == '${service}'`, "u"));
  }
});

test("fixture integration reports pending work without weakening the strict ready gate", () => {
  const document = workflowDocument("integration.yml");
  const detect = document.jobs.detect;
  const integration = document.jobs.integration;
  const gate = document.jobs.gate;

  assert.equal(detect.outputs.deferred, "${{ steps.matrix.outputs.deferred }}");
  const report = namedStep(detect.steps, "Report fixture coverage still under development");
  assert.equal(report.if, "steps.matrix.outputs.deferred != '[]'");
  assert.equal(report.env.DEFERRED_SERVICES, "${{ steps.matrix.outputs.deferred }}");
  assert.match(report.run, /not part of this integration claim/u);

  const strict = namedStep(integration.steps, "Run strict fixture integration gate");
  assert.match(strict.run, /--mode fixture --strict/u);
  assert.equal(strict["continue-on-error"], undefined);

  const aggregate = namedStep(gate.steps, "Require connector selection and fixture integration");
  assert.match(aggregate.run, /job\.result !== "success"/u);
});

test("edge promotion revalidates protected main immediately before moving aliases", () => {
  const source = workflow("edge.yml");
  const promotionStart = source.indexOf("- name: Preserve immutable SHA identity");
  const promotionEnd = source.indexOf("- name: Remove registry credentials", promotionStart);
  assert.notEqual(promotionStart, -1);
  assert.notEqual(promotionEnd, -1);

  const promotion = source.slice(promotionStart, promotionEnd);
  const registryInspection = promotion.indexOf('existing_output=$(oras resolve "$sha_ref"');
  const protectedMainCheck = promotion.indexOf("node scripts/ci/verify-main-gates.mjs");
  const aliasMutation = promotion.indexOf('oras cp "${IMAGE_NAME}@${IMAGE_DIGEST}"');

  assert.ok(registryInspection >= 0 && registryInspection < protectedMainCheck);
  assert.ok(protectedMainCheck < aliasMutation);
  assert.match(
    promotion.slice(protectedMainCheck, aliasMutation),
    /--sha "\$VERIFIED_SHA" --require-main-tip --wait-seconds 0/u,
  );
});

test("CI builds Storybook before exercising stories", () => {
  const source = workflow("ci.yml");
  const build = source.indexOf("pnpm --filter @omnifin/web build:storybook");
  const testStories = source.indexOf("pnpm test:storybook");
  assert.ok(build >= 0 && build < testStories);
});

test("browser-backed CI builds workspace dependencies before the web application", () => {
  const document = workflowDocument("ci.yml");

  for (const jobName of ["browser", "storybook", "visual", "lighthouse"]) {
    const build = namedStep(document.jobs[jobName].steps, "Build web application");
    assert.equal(build.run, "pnpm build", `${jobName} must use the dependency-aware root build`);
  }
});

test("CI rejects migration metadata and schema drift", () => {
  const source = workflow("ci.yml");
  assert.match(source, /pnpm --filter @omnifin\/gateway db:check/u);
  assert.match(source, /pnpm --filter @omnifin\/gateway db:generate/u);
  assert.match(source, /git diff --exit-code -- apps\/gateway\/drizzle/u);
  assert.match(source, /git ls-files --others --exclude-standard -- apps\/gateway\/drizzle/u);
});

test("container CI validates Compose before building the image", () => {
  const source = workflow("ci.yml");
  const compose = source.indexOf("docker compose config --quiet");
  const build = source.indexOf("- name: Build immutable application image");
  assert.ok(compose >= 0 && compose < build);
});

test("Lighthouse diagnostics use the package output and fail when absent", () => {
  const source = workflow("ci.yml");
  assert.match(source, /path: apps\/web\/\.lighthouseci/u);
  assert.match(source, /if-no-files-found: error/u);
});

test("Turbo development tasks receive every documented source environment variable", () => {
  const example = repositoryFile(".env.example");
  const turbo = JSON.parse(repositoryFile("turbo.json"));
  const documented = example
    .split("\n")
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1])
    .filter(Boolean);
  const available = new Set([
    ...(turbo.globalEnv ?? []),
    ...(turbo.globalPassThroughEnv ?? []),
    ...(turbo.tasks?.dev?.env ?? []),
    ...(turbo.tasks?.dev?.passThroughEnv ?? []),
  ]);

  for (const variable of documented) {
    assert.ok(available.has(variable), `${variable} must reach package development tasks.`);
  }
  assert.equal(available.has("DATABASE_URL"), false);
});

test("source development servers default to loopback", () => {
  const example = repositoryFile(".env.example");
  const webPackage = JSON.parse(repositoryFile("apps/web/package.json"));
  const rootPackage = JSON.parse(repositoryFile("package.json"));
  assert.doesNotMatch(example, /^NODE_ENV=/mu);
  assert.match(example, /^OMNIFIN_HOST=127\.0\.0\.1$/mu);
  assert.match(example, /^OMNIFIN_DATABASE_URL=\.\/data\/omnifin\.db$/mu);
  assert.match(example, /^TURBO_TELEMETRY_DISABLED=1$/mu);
  assert.match(webPackage.scripts.build, /NODE_ENV=production/u);
  assert.match(webPackage.scripts.dev, /--hostname 127\.0\.0\.1/u);
  assert.match(webPackage.scripts.dev, /NODE_ENV=development/u);
  assert.match(webPackage.scripts.start, /--hostname 127\.0\.0\.1/u);
  assert.match(webPackage.scripts.start, /NODE_ENV=production/u);
  assert.match(rootPackage.scripts.build, /TURBO_TELEMETRY_DISABLED=1/u);
});
