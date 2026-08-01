import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  createReleaseInstallBundle,
  immutableReleaseImage,
  stableReleaseVersion,
} from "../release/install-bundle.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = `sha256:${"a".repeat(64)}`;

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "omnifin-release-install-"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("accepts only stable versions and immutable public Omnifin digests", () => {
  assert.equal(stableReleaseVersion("0.5.0"), "0.5.0");
  assert.equal(immutableReleaseImage(digest), `ghcr.io/rezanmz/omnifin@${digest}`);

  for (const version of ["v0.5.0", "0.5", "0.5.0-rc.1", "01.2.3", "latest"]) {
    assert.throws(() => stableReleaseVersion(version), /release_version_invalid/u);
  }
  for (const candidate of [
    "latest",
    "sha256:abc",
    `sha512:${"a".repeat(64)}`,
    `ghcr.io/example/omnifin@sha256:${"a".repeat(64)}`,
  ]) {
    assert.throws(() => immutableReleaseImage(candidate), /image_digest_invalid/u);
  }
});

test("creates a deterministic runtime-only installation bundle", () => {
  const outputDirectory = temporaryDirectory();
  try {
    const result = createReleaseInstallBundle({
      digest,
      outputDirectory,
      repositoryRoot,
      version: "0.5.0",
    });

    assert.deepEqual(result, {
      files: ["compose.yaml", "omnifin.env.example", "SHA256SUMS"],
      image: `ghcr.io/rezanmz/omnifin@${digest}`,
      version: "0.5.0",
    });

    const composeSource = readFileSync(path.join(outputDirectory, "compose.yaml"), "utf8");
    const environmentSource = readFileSync(
      path.join(outputDirectory, "omnifin.env.example"),
      "utf8",
    );
    const checksums = readFileSync(path.join(outputDirectory, "SHA256SUMS"), "utf8");
    const compose = parse(composeSource, { merge: true });

    assert.deepEqual(Object.keys(compose.services).sort(), ["gateway", "maintenance", "web"]);
    for (const service of Object.values(compose.services)) {
      assert.equal(service.build, undefined);
      assert.equal(
        service.image,
        "${OMNIFIN_IMAGE:?Set OMNIFIN_IMAGE from the release environment file}",
      );
      assert.equal(service.read_only, true);
      assert.ok(service.cap_drop.includes("ALL"));
      assert.ok(service.security_opt.includes("no-new-privileges:true"));
    }
    assert.equal(compose.services.gateway.ports, undefined);
    assert.ok(compose.services.web.ports.every((entry) => String(entry).startsWith("127.0.0.1:")));
    assert.equal(
      compose.secrets.omnifin_encryption_key.file,
      "${OMNIFIN_ENCRYPTION_KEY_FILE:-./secrets/omnifin_encryption_key}",
    );
    assert.equal(
      compose.secrets.omnifin_recovery_secret.file,
      "${OMNIFIN_RECOVERY_SECRET_FILE:-./secrets/omnifin_recovery_secret}",
    );
    assert.equal(compose.secrets.omnifin_encryption_key.environment, undefined);
    assert.equal(compose.secrets.omnifin_recovery_secret.environment, undefined);
    assert.doesNotMatch(composeSource, /^\s+build:/mu);

    assert.match(environmentSource, /^# Omnifin 0\.5\.0$/mu);
    assert.match(
      environmentSource,
      new RegExp(`^OMNIFIN_IMAGE=ghcr\\.io/rezanmz/omnifin@${digest}$`, "mu"),
    );
    assert.match(environmentSource, /^OMNIFIN_BASE_URL=https:\/\/omnifin\.example\.net$/mu);
    assert.match(environmentSource, /^OMNIFIN_SECURE_COOKIES=true$/mu);
    assert.match(environmentSource, /^OMNIFIN_INSECURE_LOOPBACK_PREVIEW=false$/mu);
    assert.match(
      environmentSource,
      /^OMNIFIN_ENCRYPTION_KEY_FILE=\.\/secrets\/omnifin_encryption_key$/mu,
    );
    assert.match(
      environmentSource,
      /^OMNIFIN_RECOVERY_SECRET_FILE=\.\/secrets\/omnifin_recovery_secret$/mu,
    );
    assert.doesNotMatch(environmentSource, /^OMNIFIN_ENCRYPTION_KEY=/mu);
    assert.doesNotMatch(environmentSource, /^OMNIFIN_RECOVERY_SECRET=/mu);
    assert.doesNotMatch(environmentSource, /__OMNIFIN_|OMNIFIN_GATEWAY_URL|NEXT_TELEMETRY/u);

    const expectedChecksums = [
      `${sha256(composeSource)}  compose.yaml`,
      `${sha256(environmentSource)}  omnifin.env.example`,
    ];
    assert.deepEqual(checksums.trim().split("\n"), expectedChecksums);
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});

test("refuses to replace any existing release asset", () => {
  const outputDirectory = temporaryDirectory();
  try {
    writeFileSync(path.join(outputDirectory, "compose.yaml"), "existing\n", { mode: 0o600 });
    assert.throws(
      () =>
        createReleaseInstallBundle({
          digest,
          outputDirectory,
          repositoryRoot,
          version: "0.5.0",
        }),
      /release_asset_exists/u,
    );
    assert.equal(readFileSync(path.join(outputDirectory, "compose.yaml"), "utf8"), "existing\n");
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});

test("gates stable promotion on the generated Compose bundle", () => {
  const workflow = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8"),
  );
  const verification = workflow.jobs["verify-install-bundle"];
  assert.equal(verification.name, "Verify digest-pinned Compose installation");
  assert.deepEqual(verification.needs, ["publish-candidate", "verify-candidate"]);
  assert.deepEqual(verification.permissions, { contents: "read" });
  assert.equal(JSON.stringify(verification).includes("secrets."), false);

  const generate = verification.steps.find(
    (step) => step.name === "Generate the release installation bundle",
  );
  assert.match(generate.run, /scripts\/release\/install-bundle\.mjs/u);
  assert.equal(generate.env.IMAGE_DIGEST, "${{ needs.publish-candidate.outputs.digest }}");
  assert.match(generate.run, /--digest "\$IMAGE_DIGEST"/u);
  const credentials = verification.steps.find(
    (step) => step.name === "Generate isolated deployment credentials",
  );
  assert.match(credentials.run, /omnifin-install-secrets/u);
  assert.match(credentials.run, /OMNIFIN_ENCRYPTION_KEY_FILE/u);
  assert.match(credentials.run, /OMNIFIN_RECOVERY_SECRET_FILE/u);
  assert.match(credentials.run, /install --directory --mode 0700/u);
  assert.match(credentials.run, /chmod 0444/u);
  assert.doesNotMatch(credentials.run, /chmod 0600/u);
  assert.doesNotMatch(credentials.run, /OMNIFIN_ENCRYPTION_KEY=\$encryption_key/u);
  assert.doesNotMatch(credentials.run, /OMNIFIN_RECOVERY_SECRET=\$recovery_secret/u);
  const exercise = verification.steps.find(
    (step) => step.name === "Start, inspect, back up, and verify the release",
  );
  assert.match(exercise.run, /docker compose/u);
  assert.match(exercise.run, /config --quiet/u);
  assert.match(exercise.run, /up --detach --wait/u);
  assert.match(exercise.run, /\/recovery/u);
  assert.match(exercise.run, /maintenance backup/u);
  assert.match(exercise.run, /maintenance verify/u);
  assert.ok(workflow.jobs["promote-stable"].needs.includes("verify-install-bundle"));
  assert.match(
    workflow.jobs["promote-stable"].if,
    /needs\.verify-install-bundle\.result == 'success'/u,
  );
});

test("documents the private-directory permission contract for rootless Compose secrets", () => {
  for (const relativePath of ["README.md", "docs/first-run.md"]) {
    const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    assert.match(source, /install -d -m 0700 secrets/u);
    assert.match(
      source,
      /chmod 0444 secrets\/omnifin_encryption_key secrets\/omnifin_recovery_secret/u,
    );
    assert.match(source, /cannot traverse the `0700` directory/u);
  }
});

test("uploads an unmodified bundle before publishing the GitHub Release", () => {
  const workflow = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/publish.yml"), "utf8"),
  );
  const finalize = workflow.jobs.finalize;
  const checkout = finalize.steps.find(
    (step) => step.name === "Check out immutable release source",
  );
  assert.equal(checkout.with.ref, "${{ inputs.release_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);

  const generate = finalize.steps.find((step) => step.name === "Generate release install assets");
  const upload = finalize.steps.find((step) => step.name === "Attach install assets to the draft");
  const publish = finalize.steps.find(
    (step) => step.name === "Publish draft after stable digest verification",
  );
  assert.match(generate.run, /scripts\/release\/install-bundle\.mjs/u);
  assert.match(upload.with.script, /repos\.listReleaseAssets/u);
  assert.match(upload.with.script, /Refusing to overwrite release asset/u);
  assert.match(upload.with.script, /repos\.uploadReleaseAsset/u);
  assert.match(upload.with.script, /"content-length": data\.length/u);
  assert.match(upload.with.script, /"content-type": "application\/octet-stream"/u);
  assert.ok(finalize.steps.indexOf(generate) < finalize.steps.indexOf(upload));
  assert.ok(finalize.steps.indexOf(upload) < finalize.steps.indexOf(publish));
});
