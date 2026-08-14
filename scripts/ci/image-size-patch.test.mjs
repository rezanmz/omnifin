import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const store = path.join(root, "node_modules/.pnpm");
const lockfile = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
const patchHash = lockfile.match(/^  image-size@2\.0\.2: ([a-f0-9]{64})$/mu)?.[1];

assert.ok(patchHash, "pnpm-lock.yaml must pin the image-size@2.0.2 patch.");

const packageDirectory = `image-size@2.0.2_patch_hash=${patchHash}`;
const packageRoot = path.join(store, packageDirectory, "node_modules/image-size");
const require = createRequire(import.meta.url);

async function loadModule(module) {
  return import(pathToFileURL(path.join(packageRoot, "dist", `${module}.mjs`)).href);
}

const { HEIF } = await loadModule("types/heif");
const { ICNS } = await loadModule("types/icns");
const { JXL } = await loadModule("types/jxl");
const { imageSizeFromFile } = await loadModule("fromFile");
const { imageSizeFromFile: imageSizeFromFileCjs } = require(
  path.join(packageRoot, "dist/fromFile.cjs"),
);

const encoder = new TextEncoder();

function box(type, brand) {
  const input = new Uint8Array(12);
  input.set(encoder.encode(type), 4);
  input.set(encoder.encode(brand), 8);
  return input;
}

test("image-size rejects zero-sized ICNS entries", () => {
  const input = new Uint8Array(16);
  input.set(encoder.encode("icns"), 0);
  input.set(encoder.encode("ic07"), 8);
  const view = new DataView(input.buffer);
  view.setUint32(4, input.length);

  assert.throws(() => ICNS.calculate(input), /Invalid ICNS entry size/u);
});

test("image-size/fromFile rejects zero-sized ICNS entries for ESM and CommonJS", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-image-size-"));
  const imagePath = path.join(directory, "malformed.icns");
  const input = new Uint8Array(16);
  input.set(encoder.encode("icns"), 0);
  input.set(encoder.encode("ic07"), 8);
  new DataView(input.buffer).setUint32(4, input.length);

  try {
    await writeFile(imagePath, input);
    await assert.rejects(imageSizeFromFile(imagePath), /Invalid ICNS entry size/u);
    await assert.rejects(imageSizeFromFileCjs(imagePath), /Invalid ICNS entry size/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("image-size rejects zero-sized HEIF and JXL boxes", () => {
  assert.equal(HEIF.validate(box("ftyp", "avif")), false);
  assert.equal(JXL.validate(box("ftyp", "jxl ")), false);
});
