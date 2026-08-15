import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const store = path.join(root, "node_modules/.pnpm");
const lockfile = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
const patchHash = lockfile.match(/^  extract-zip@2\.0\.1: ([a-f0-9]{64})$/mu)?.[1];

assert.ok(patchHash, "pnpm-lock.yaml must pin the extract-zip@2.0.1 patch.");

const packageRoot = path.join(
  store,
  `extract-zip@2.0.1_patch_hash=${patchHash}`,
  "node_modules/extract-zip",
);
const require = createRequire(import.meta.url);
const extractZip = require(packageRoot);

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value);
  return output;
}

function writeUInt32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value >>> 0);
  return output;
}

function symlinkArchive(name, target) {
  const fileName = Buffer.from(name);
  const linkTarget = Buffer.from(target);
  const checksum = crc32(linkTarget);
  const local = Buffer.concat([
    writeUInt32(0x04034b50),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(checksum),
    writeUInt32(linkTarget.length),
    writeUInt32(linkTarget.length),
    writeUInt16(fileName.length),
    writeUInt16(0),
    fileName,
    linkTarget,
  ]);
  const central = Buffer.concat([
    writeUInt32(0x02014b50),
    writeUInt16((3 << 8) | 20),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(checksum),
    writeUInt32(linkTarget.length),
    writeUInt32(linkTarget.length),
    writeUInt16(fileName.length),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0o120777 << 16),
    writeUInt32(0),
    fileName,
  ]);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(1),
    writeUInt16(1),
    writeUInt32(central.length),
    writeUInt32(local.length),
    writeUInt16(0),
  ]);

  return Buffer.concat([local, central, end]);
}

test("extract-zip rejects symlinks that escape the extraction directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omnifin-extract-zip-"));
  const archive = path.join(directory, "malicious.zip");
  const destination = path.join(directory, "destination");

  try {
    await writeFile(archive, symlinkArchive("link", "../../outside"));
    await assert.rejects(extractZip(archive, { dir: destination }), /Out of bound symlink/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
