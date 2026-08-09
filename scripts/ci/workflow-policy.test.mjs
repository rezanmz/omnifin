import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

function repositoryJson(name) {
  return JSON.parse(repositoryFile(name));
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

test("release automation remains in the reviewed pre-1.0 channel", () => {
  const config = repositoryJson("release-please-config.json");
  const manifest = repositoryJson(".release-please-manifest.json");
  const packageDocument = repositoryJson("package.json");

  assert.equal(config["initial-version"], "0.1.0");
  assert.equal(config["bump-minor-pre-major"], true);
  assert.equal(config["pull-request-title-pattern"], "chore(release): prepare ${version}");
  assert.equal(
    config["pull-request-header"],
    "This pull request prepares the next reviewed Omnifin release.",
  );
  assert.equal(
    config["pull-request-footer"],
    "Merge only after the selected release profile and all protected checks are green.",
  );
  assert.equal(manifest["."], packageDocument.version);
  assert.match(packageDocument.version, /^0\.\d+\.\d+$/u);
});

test("release pull requests are normalized through a verified exact-tree commit", () => {
  const document = workflowDocument("release-please.yml");
  const release = document.jobs.release;
  const checkout = namedStep(release.steps, "Check out the exact protected source");
  const normalize = namedStep(release.steps, "Normalize release pull request to a verified commit");

  assert.deepEqual(release.permissions, { contents: "read" });
  assert.equal(checkout.with.ref, "${{ github.event.workflow_run.head_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(normalize.if, "steps.release.outputs.prs_created == 'true'");
  assert.equal(normalize.env.EXPECTED_BASE_SHA, "${{ github.event.workflow_run.head_sha }}");
  assert.equal(normalize.env.GH_TOKEN, "${{ secrets.RELEASE_PLEASE_TOKEN }}");
  assert.equal(normalize.env.RELEASE_PR_JSON, "${{ steps.release.outputs.pr }}");
  assert.equal(normalize.run, "node scripts/ci/normalize-release-commit.mjs");
  assert.equal(release.outputs["normalized-sha"], undefined);
  assert.doesNotMatch(JSON.stringify(release), /contents:\s*write|pull-requests:\s*write/u);
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

test("visual baseline refresh is review-only and cannot write to the repository", () => {
  const source = workflow("visual-baselines.yml");
  const document = workflowDocument("visual-baselines.yml");
  const refresh = document.jobs.refresh;
  const checkout = namedStep(refresh.steps, "Check out repository");
  const build = namedStep(refresh.steps, "Build web application");
  const installBrowsers = namedStep(refresh.steps, "Install browser runtimes");
  const generate = namedStep(refresh.steps, "Generate visual baselines");
  const upload = namedStep(refresh.steps, "Upload visual baselines for review");

  assert.deepEqual(document.permissions, { contents: "read" });
  assert.deepEqual(refresh.permissions, { contents: "read" });
  assert.equal(refresh.strategy["fail-fast"], false);
  assert.deepEqual(refresh.strategy.matrix.include, [
    { platform: "linux", runner: "ubuntu-latest" },
    { platform: "darwin", runner: "macos-latest" },
  ]);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(build.run, "pnpm build");
  assert.equal(
    installBrowsers.run,
    "node scripts/ci/install-playwright.mjs chromium firefox webkit",
  );
  assert.match(generate.run, /--update-snapshots/u);
  assert.equal(upload.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.doesNotMatch(source, /\b(?:git push|git commit|pull-requests: write|contents: write)\b/u);
});

test("visual comparisons retain PNG evidence without retry, trace, or video amplification", () => {
  const config = repositoryFile("apps/web/playwright.config.ts");
  const packageDocument = repositoryJson("apps/web/package.json");
  const refresh = workflowDocument("visual-baselines.yml");
  const generate = namedStep(refresh.jobs.refresh.steps, "Generate visual baselines");

  assert.match(packageDocument.scripts["test:visual"], /OMNIFIN_VISUAL_TEST=true/u);
  assert.match(config, /const visualTestMode = process\.env\.OMNIFIN_VISUAL_TEST === "true"/u);
  assert.match(config, /fullyParallel: !visualTestMode/u);
  assert.match(config, /retries: process\.env\.CI && !visualTestMode \? 2 : 0/u);
  assert.match(config, /trace: visualTestMode \? "off" : "retain-on-failure"/u);
  assert.match(config, /video: visualTestMode \? "off" : "retain-on-failure"/u);
  assert.match(
    config,
    /const isolatedTestMode = process\.env\.OMNIFIN_PLAYWRIGHT_TEST_MODE === "true"/u,
  );

  const workerPolicy = config.match(
    /\.\.\.\(\s*(?<condition>[^?]+?)\s*\?\s*\{\s*workers\s*:\s*1\s*\}\s*:\s*\{\s*\}\s*\)/u,
  );
  assert.ok(workerPolicy, "Playwright must define a conditional single-worker policy.");
  const workerCondition = workerPolicy.groups?.condition ?? "";
  assert.match(workerCondition, /\bvisualTestMode\b/u);
  assert.match(workerCondition, /\bisolatedTestMode\b/u);
  assert.match(
    workerCondition,
    /(?:\bvisualTestMode\b\s*\|\|\s*\bisolatedTestMode\b|\bisolatedTestMode\b\s*\|\|\s*\bvisualTestMode\b)/u,
  );
  assert.equal(generate.env.OMNIFIN_VISUAL_TEST, "true");
});

test("browser CI rejects retry-hidden flaky tests", () => {
  const config = repositoryFile("apps/web/playwright.config.ts");

  assert.match(config, /failOnFlakyTests: Boolean\(process\.env\.CI\)/u);
  assert.match(config, /retries: process\.env\.CI && !visualTestMode \? 2 : 0/u);
});

test("hosted Playwright installs use the bounded retry helper", () => {
  const workflowNames = readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
  const sources = workflowNames.map((name) => workflow(name));
  const helperCalls = sources.flatMap(
    (source) => source.match(/node scripts\/ci\/install-playwright\.mjs/gu) ?? [],
  );

  assert.equal(helperCalls.length, 9);
  for (const source of sources) {
    assert.doesNotMatch(source, /playwright install(?:\s|$)/u);
  }
});

test("edge and stable publications use the bounded OCI signing helper", () => {
  const edge = workflowDocument("edge.yml");
  const stable = workflowDocument("publish.yml");
  const edgeSigning = edge.jobs["attest-candidate"];
  const stableSigning = stable.jobs["attest-candidate"];

  for (const job of [edgeSigning, stableSigning]) {
    const checkout = namedStep(job.steps, "Check out the verified signing helper");
    const signing = job.steps.find((step) =>
      ["Sign edge candidate digest", "Sign image digest with keyless identity"].includes(step.name),
    );

    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(signing.run, "node scripts/ci/sign-oci-image.mjs");
  }

  assert.equal(
    namedStep(edgeSigning.steps, "Check out the verified signing helper").with.ref,
    "${{ github.event.workflow_run.head_sha }}",
  );
  assert.equal(
    namedStep(stableSigning.steps, "Check out the verified signing helper").with.ref,
    "${{ inputs.release_sha }}",
  );
  assert.doesNotMatch(workflow("edge.yml"), /run: cosign sign/u);
  assert.doesNotMatch(workflow("publish.yml"), /run: cosign sign/u);
});

test("release candidates and required artifacts retain stable identities across reruns", () => {
  const edge = workflow("edge.yml");
  const stable = workflow("publish.yml");
  const stableDocument = workflowDocument("publish.yml");
  const buildUpload = namedStep(
    stableDocument.jobs["build-candidate"].steps,
    "Upload candidate bundle",
  );
  const sbomUpload = namedStep(stableDocument.jobs["build-candidate"].steps, "Retain release SBOM");
  const candidateDownload = namedStep(
    stableDocument.jobs["publish-candidate"].steps,
    "Download candidate bundle",
  );
  const sbomDownload = namedStep(
    stableDocument.jobs["attest-candidate"].steps,
    "Download validated SPDX SBOM",
  );

  assert.match(edge, /CANDIDATE_TAG: edge-candidate-.*\$\{\{ github\.run_id \}\}/u);
  assert.doesNotMatch(edge.match(/CANDIDATE_TAG:.*$/mu)?.[0] ?? "", /run_attempt/u);
  assert.match(stable, /candidate-\$\{version\}-\$\{process\.env\.GITHUB_RUN_ID\}/u);
  assert.doesNotMatch(stable.match(/const candidateTag =.*$/mu)?.[0] ?? "", /RUN_ATTEMPT/u);
  assert.equal(buildUpload.with.name, "release-candidate-${{ github.run_id }}");
  assert.equal(buildUpload.with.overwrite, true);
  assert.equal(candidateDownload.with.name, buildUpload.with.name);
  assert.equal(
    sbomUpload.with.name,
    "omnifin-${{ inputs.version }}-${{ github.run_id }}-spdx-sbom",
  );
  assert.equal(sbomUpload.with.overwrite, true);
  assert.equal(sbomDownload.with.name, sbomUpload.with.name);
  assert.match(stable, /Existing candidate tag does not match this run's built digest/u);
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
    assert.equal(vulnerabilities.env.TRIVY_SKIP_DB_UPDATE, "true");
    assert.equal(vulnerabilities.env.TRIVY_SKIP_JAVA_DB_UPDATE, "true");

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
    assert.equal(scannerPolicy.env.TRIVY_SKIP_DB_UPDATE, "true");
    assert.equal(scannerPolicy.env.TRIVY_SKIP_JAVA_DB_UPDATE, "true");

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
    assert.equal(vulnerabilities.env.TRIVY_SKIP_DB_UPDATE, "true");
    assert.equal(vulnerabilities.env.TRIVY_SKIP_JAVA_DB_UPDATE, "true");
    assert.equal(vulnerabilities.with.scanners, "vuln");
    assert.equal(vulnerabilities.with.severity, "HIGH,CRITICAL");
    assert.equal(vulnerabilities.with["ignore-unfixed"], "true");
    assert.equal(vulnerabilities.with.format, "table");

    const scannerPolicy = namedStep(scan.steps, "Enforce candidate secret and IaC policy");
    assert.equal(scannerPolicy.env.TRIVY_PLATFORM, "${{ matrix.target.platform }}");
    assert.equal(scannerPolicy.env.TRIVY_SKIP_DB_UPDATE, "true");
    assert.equal(scannerPolicy.env.TRIVY_SKIP_JAVA_DB_UPDATE, "true");
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

test("fixture integration makes real Authentik OIDC behavior a protected aggregate dependency", () => {
  const document = workflowDocument("integration.yml");
  const authentik = document.jobs.authentik;
  const gate = document.jobs.gate;

  assert.equal(authentik.name, "Authentik OIDC integration");
  assert.equal(authentik["timeout-minutes"], 45);
  assert.equal(JSON.stringify(authentik).includes("secrets."), false);
  assert.equal(JSON.stringify(authentik).includes("vars."), false);

  const browser = namedStep(authentik.steps, "Install isolated browser runtime");
  assert.equal(browser.run, "node scripts/ci/install-playwright.mjs chromium");
  const run = namedStep(authentik.steps, "Run isolated Authentik authorization-code gate");
  assert.match(run.run, /pnpm test:authentik/u);
  assert.match(run.run, /artifacts\/integration\/authentik\/report\.json/u);
  assert.equal(run["continue-on-error"], undefined);

  const upload = namedStep(authentik.steps, "Upload sanitized Authentik report");
  assert.equal(upload.with.path, "artifacts/integration/authentik/report.json");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.ok(gate.needs.includes("authentik"));
});

test("fixture integration makes standards-generic OIDC behavior a protected aggregate dependency", () => {
  const document = workflowDocument("integration.yml");
  const oidc = document.jobs["oidc-provider"];
  const gate = document.jobs.gate;

  assert.equal(oidc.name, "Standards-generic OIDC integration");
  assert.equal(oidc["timeout-minutes"], 25);
  assert.equal(JSON.stringify(oidc).includes("secrets."), false);
  assert.equal(JSON.stringify(oidc).includes("vars."), false);

  const browser = namedStep(oidc.steps, "Install isolated browser runtime");
  assert.equal(browser.run, "node scripts/ci/install-playwright.mjs chromium");
  const run = namedStep(oidc.steps, "Run isolated standards-generic authorization-code gate");
  assert.match(run.run, /pnpm test:oidc-provider/u);
  assert.match(run.run, /artifacts\/integration\/oidc-provider\/report\.json/u);
  assert.equal(run["continue-on-error"], undefined);

  const upload = namedStep(oidc.steps, "Upload sanitized generic OIDC report");
  assert.equal(upload.with.path, "artifacts/integration/oidc-provider/report.json");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.ok(gate.needs.includes("oidc-provider"));
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

test("release automation lets only the latest exact-SHA gate completion publish", () => {
  for (const [workflowName, mutationJob] of [
    ["edge.yml", "build-candidate"],
    ["release-please.yml", "release"],
  ]) {
    const document = workflowDocument(workflowName);
    const gate = document.jobs["verify-main-gates"];
    assert.equal(gate["timeout-minutes"], 10);
    assert.equal(gate.outputs.ready, "${{ steps.gates.outputs.ready }}");
    const verification = namedStep(
      gate.steps,
      "Require CI and Security for the exact current main SHA",
    );
    assert.equal(verification.id, "gates");
    assert.match(verification.run, /--require-main-tip/u);
    assert.match(
      verification.run,
      /--trigger-run-id "\$\{\{ github\.event\.workflow_run\.id \}\}"/u,
    );
    assert.doesNotMatch(verification.run, /--wait-seconds/u);
    assert.equal(document.jobs[mutationJob].if, "needs.verify-main-gates.outputs.ready == 'true'");
  }
});

test("duplicate exact-SHA edge handoffs serialize without cancellation", () => {
  const document = workflowDocument("edge.yml");

  assert.equal(document.concurrency.group, "edge-main-${{ github.event.workflow_run.head_sha }}");
  assert.equal(document.concurrency["cancel-in-progress"], false);
});

test("edge publication retriggers from either protected-main quality gate", () => {
  const document = workflowDocument("edge.yml");
  const source = namedStep(
    document.jobs.prerequisite.steps,
    "Accept only a successful protected-main quality gate",
  );

  assert.deepEqual(document.on.workflow_run.workflows, ["CI", "Security"]);
  assert.equal(source.env.SOURCE_WORKFLOW, "${{ github.event.workflow_run.name }}");
  assert.match(source.run, /CI\|Security/u);
  assert.match(source.run, /SOURCE_CONCLUSION.*success/su);
  assert.match(source.run, /SOURCE_EVENT.*push/su);
  assert.match(source.run, /SOURCE_BRANCH.*main/su);
  assert.match(source.run, /SOURCE_REPOSITORY.*GITHUB_REPOSITORY/su);
});

test("release preparation retriggers from either protected-main quality gate", () => {
  const document = workflowDocument("release-please.yml");
  const source = namedStep(
    document.jobs.prerequisite.steps,
    "Validate source and report automation status",
  );

  assert.deepEqual(document.on.workflow_run.workflows, ["CI", "Security"]);
  assert.equal(source.env.SOURCE_WORKFLOW, "${{ github.event.workflow_run.name }}");
  assert.match(source.run, /CI\|Security/u);
});

test("draft-aware release jobs receive narrowly scoped push access", () => {
  const document = workflowDocument("publish.yml");
  const metadata = document.jobs["validate-release-metadata"];
  const promotion = document.jobs["promote-stable"];
  const finalize = document.jobs.finalize;

  assert.deepEqual(metadata.permissions, { contents: "write" });
  assert.equal(metadata.environment, undefined);
  assert.equal(metadata.steps.length, 1);
  assert.equal(metadata.steps[0].name, "Bind release inputs to protected main");
  assert.match(metadata.steps[0].with.script, /repos\.listReleases/u);
  assert.doesNotMatch(JSON.stringify(metadata), /checkout|packages: write|secrets\./u);

  assert.deepEqual(promotion.permissions, { contents: "write", packages: "write" });
  assert.equal(promotion.environment, "release");
  assert.match(
    namedStep(promotion.steps, "Recheck draft and monotonic release order").with.script,
    /repos\.listReleases/u,
  );
  assert.deepEqual(finalize.permissions, { contents: "write" });

  const contentWriters = Object.entries(document.jobs)
    .filter(([, job]) => job.permissions?.contents === "write")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(contentWriters, ["finalize", "promote-stable", "validate-release-metadata"]);
});

test("stable publication crosses optional live coverage only through explicit successful gates", () => {
  const document = workflowDocument("publish.yml");
  const releaseChain = [
    "build-candidate",
    "publish-candidate",
    "attest-candidate",
    "scan-candidate",
    "verify-candidate",
    "verify-install-bundle",
    "promote-stable",
    "verify-stable",
    "finalize",
  ];

  assert.equal(
    document.jobs["validate-live-source"].if,
    "needs.release-coverage.outputs.live_required == 'true'",
  );
  assert.equal(document.jobs["source-gate"].if, "always()");

  for (const jobName of releaseChain) {
    const job = document.jobs[jobName];
    const dependencies = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.match(job.if, /^\$\{\{ always\(\) && /u, `${jobName} must override skip propagation`);
    for (const dependency of dependencies) {
      assert.match(
        job.if,
        new RegExp(`needs\\.${dependency}\\.result == 'success'`, "u"),
        `${jobName} must still fail closed when ${dependency} does not succeed`,
      );
    }
  }
});

test("CI builds Storybook before exercising stories", () => {
  const source = workflow("ci.yml");
  const build = source.indexOf("pnpm --filter @omnifin/web build:storybook");
  const testStories = source.indexOf("pnpm test:storybook");
  assert.ok(build >= 0 && build < testStories);
});

test("CI runs Storybook and accessibility as independent protected jobs", () => {
  const document = workflowDocument("ci.yml");
  const storybook = document.jobs.storybook;
  const accessibility = document.jobs.accessibility;
  const gateDependencies = Array.isArray(document.jobs.gate.needs)
    ? document.jobs.gate.needs
    : [document.jobs.gate.needs];

  assert.equal(storybook.name, "Storybook");
  assert.equal(accessibility.name, "Accessibility");
  assert.equal(storybook["timeout-minutes"], 40);
  assert.equal(accessibility["timeout-minutes"], 45);
  assert.equal(document.jobs.browser["timeout-minutes"], 45);
  assert.equal(document.jobs.visual["timeout-minutes"], 45);
  assert.equal(document.jobs.lighthouse["timeout-minutes"], 40);
  assert.ok(storybook.steps.some((step) => step.run === "pnpm test:storybook"));
  assert.ok(!storybook.steps.some((step) => step.run === "pnpm test:a11y"));
  assert.ok(accessibility.steps.some((step) => step.run === "pnpm test:a11y"));
  assert.ok(gateDependencies.includes("storybook"));
  assert.ok(gateDependencies.includes("accessibility"));
});

test("browser-backed CI builds workspace dependencies before the web application", () => {
  const document = workflowDocument("ci.yml");

  for (const jobName of ["browser", "storybook", "accessibility", "visual", "lighthouse"]) {
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
  const document = workflowDocument("ci.yml");
  const compose = source.indexOf("docker compose config --quiet");
  const build = source.indexOf("- name: Build immutable application image");
  assert.ok(compose >= 0 && compose < build);
  const validation = namedStep(
    document.jobs.container.steps,
    "Validate the Compose deployment model",
  );
  assert.equal(validation.run, "docker compose config --quiet");
  assert.match(validation.env.OMNIFIN_IMAGE, /^[^\s@]+@sha256:[a-f0-9]{64}$/u);
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
