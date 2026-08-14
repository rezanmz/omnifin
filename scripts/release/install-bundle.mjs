import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicImage = "ghcr.io/rezanmz/omnifin";
const outputNames = ["compose.yaml", "omnifin.env.example", "SHA256SUMS", "release-manifest.json"];
const releaseImage = "image: ${OMNIFIN_IMAGE:?Set OMNIFIN_IMAGE from the release environment file}";
const releaseImageReference =
  "OMNIFIN_IMAGE_REF: ${OMNIFIN_IMAGE:?Set OMNIFIN_IMAGE from the release environment file}";

export function stableReleaseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value ?? "")) {
    throw new Error("release_version_invalid");
  }
  return value;
}

export function releaseSourceSha(value) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? "")) {
    throw new Error("release_source_sha_invalid");
  }
  return value;
}

export function immutableReleaseImage(value) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value ?? "")) {
    throw new Error("image_digest_invalid");
  }
  return `${publicImage}@${value}`;
}

function replaceExactlyOnce(source, search, replacement, errorCode) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(errorCode);
  }
  return source.replace(search, replacement);
}

function runtimeCompose(source) {
  const buildBlock = /^  build:\n(?:    .+\n)+/gmu;
  const matches = [...source.matchAll(buildBlock)];
  if (matches.length !== 1) throw new Error("compose_build_boundary_invalid");
  const withoutBuild = source.replace(buildBlock, "");
  if (withoutBuild.split(releaseImage).length !== 2) {
    throw new Error("compose_image_boundary_invalid");
  }
  if (withoutBuild.split(releaseImageReference).length !== 3) {
    throw new Error("compose_image_reference_boundary_invalid");
  }
  const maintenanceStart = withoutBuild.indexOf("\n  maintenance:");
  const maintenanceEnd = withoutBuild.indexOf("\nsecrets:", maintenanceStart);
  const maintenance = withoutBuild.slice(maintenanceStart, maintenanceEnd);
  if (
    maintenanceStart < 0 ||
    maintenanceEnd < 0 ||
    !maintenance.includes("OMNIFIN_ENCRYPTION_KEY_FILE: /run/secrets/omnifin_encryption_key") ||
    !maintenance.includes("\n    secrets:\n      - omnifin_encryption_key") ||
    maintenance.includes("OMNIFIN_RECOVERY_SECRET_FILE") ||
    maintenance.includes("- omnifin_recovery_secret")
  ) {
    throw new Error("compose_maintenance_secret_boundary_invalid");
  }
  if (/^\s+build:/mu.test(withoutBuild)) {
    throw new Error("compose_build_boundary_invalid");
  }
  return withoutBuild;
}

function environmentTemplate(source, version, image) {
  const withVersion = replaceExactlyOnce(
    source,
    "__OMNIFIN_RELEASE_VERSION__",
    version,
    "environment_version_boundary_invalid",
  );
  const rendered = replaceExactlyOnce(
    withVersion,
    "__OMNIFIN_IMAGE_REFERENCE__",
    image,
    "environment_image_boundary_invalid",
  );
  if (rendered.includes("__OMNIFIN_")) throw new Error("environment_placeholder_unresolved");
  return rendered;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function createReleaseInstallBundle(options) {
  const version = stableReleaseVersion(options.version);
  const sourceSha = releaseSourceSha(options.sourceSha);
  const image = immutableReleaseImage(options.digest);
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const outputDirectory = path.resolve(options.outputDirectory);
  const targets = outputNames.map((name) => path.join(outputDirectory, name));

  mkdirSync(outputDirectory, { mode: 0o755, recursive: true });
  if (targets.some((target) => existsSync(target))) throw new Error("release_asset_exists");

  const compose = runtimeCompose(readFileSync(path.join(repositoryRoot, "compose.yaml"), "utf8"));
  const environment = environmentTemplate(
    readFileSync(path.join(repositoryRoot, "deploy/omnifin.env.example"), "utf8"),
    version,
    image,
  );
  const checksums = [
    `${sha256(compose)}  compose.yaml`,
    `${sha256(environment)}  omnifin.env.example`,
    "",
  ].join("\n");
  const manifest = `${JSON.stringify(
    {
      assets: {
        SHA256SUMS: sha256(checksums),
        "compose.yaml": sha256(compose),
        "omnifin.env.example": sha256(environment),
      },
      image,
      sourceSha,
      tag: `v${version}`,
      version,
    },
    null,
    2,
  )}\n`;

  for (const [target, source] of [
    [targets[0], compose],
    [targets[1], environment],
    [targets[2], checksums],
    [targets[3], manifest],
  ]) {
    writeFileSync(target, source, { encoding: "utf8", flag: "wx", mode: 0o644 });
    chmodSync(target, 0o644);
  }

  return { files: [...outputNames], image, version };
}

function commandOptions(arguments_) {
  if (arguments_.length !== 8) throw new Error("install_bundle_arguments_invalid");
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--digest", "--output", "--source-sha", "--version"].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error("install_bundle_arguments_invalid");
    }
    values.set(name, value);
  }
  if (values.size !== 4) throw new Error("install_bundle_arguments_invalid");
  return {
    digest: values.get("--digest"),
    outputDirectory: path.resolve(values.get("--output")),
    repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    sourceSha: values.get("--source-sha"),
    version: values.get("--version"),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = createReleaseInstallBundle(commandOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "install_bundle_failed"}\n`);
    process.exitCode = 1;
  }
}
