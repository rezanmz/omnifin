import Database from "better-sqlite3";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  deterministicV012FixtureEnvelope,
  existingV012FixtureProvenance,
  generateV012FixtureFromSource,
  imageFixtureDockerCommands,
  publishV012FixtureAtomically,
  runImageFixtureDockerLifecycle,
  stableV012FixtureJson,
  v012FixtureSha256,
  v012HostSqliteMetadata,
  validateGeneratedV012FixtureDatabase,
  validateV012FixtureWithCandidate,
} from "../scripts/generate-v012-fixture.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const directories: string[] = [];
const fixtureKey = Buffer.alloc(32, 0x31);
const readyMarker = "OMNIFIN_V012_FIXTURE_READY_44444444-4444-4444-8444-444444444444";
const imageReference = `ghcr.io/rezanmz/omnifin@sha256:${"4".repeat(64)}`;
const repositoryDirectory = path.resolve(import.meta.dirname, "../../..");

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "omnifin-v012-generator-test-"));
  directories.push(directory);
  return directory;
}

function commands(directory = temporaryDirectory()) {
  return imageFixtureDockerCommands({
    artifactOutputPath: path.join(directory, "fixture.sqlite"),
    containerName: "fixture-lifecycle-test",
    imageReference,
    metadataOutputPath: path.join(directory, "metadata.json"),
    readyMarker,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v0.12 fixture generator tooling", () => {
  it("generates, validates, hashes, and upgrades exact source evidence", async () => {
    const directory = temporaryDirectory();
    const generated = path.join(directory, "generated.sqlite");
    generateV012FixtureFromSource(generated);

    const sqlite = new Database(generated, { readonly: true });
    try {
      expect(() => validateGeneratedV012FixtureDatabase(sqlite)).not.toThrow();
      const encrypted = sqlite
        .prepare("select encrypted_credentials as encrypted from connector_configs")
        .get() as { encrypted: string };
      expect(
        new EnvelopeCipher(fixtureKey).decrypt(
          encrypted.encrypted,
          "connector_credentials:jellyfin:jellyfin-fixture",
        ),
      ).toBe(JSON.stringify({ accessToken: "fixture-only" }));
    } finally {
      sqlite.close();
    }

    expect(v012FixtureSha256(generated)).toMatch(/^[0-9a-f]{64}$/u);
    expect(v012HostSqliteMetadata()).toEqual({
      sqliteSourceId: expect.any(String),
      sqliteVersion: expect.any(String),
    });
    const candidate = path.join(directory, "candidate.sqlite");
    copyFileSync(generated, candidate);
    chmodSync(candidate, 0o600);
    await expect(validateV012FixtureWithCandidate(candidate)).resolves.toBeUndefined();

    const envelope = deterministicV012FixtureEnvelope("fixture", "fixture-context");
    expect(new EnvelopeCipher(fixtureKey).decrypt(envelope, "fixture-context")).toBe("fixture");
  });

  it("uses only a digest-pinned released prefix when the source Git object is unavailable", () => {
    const directory = temporaryDirectory();
    const generated = path.join(directory, "shallow-generated.sqlite");
    generateV012FixtureFromSource(generated, {
      readGitFile: () => {
        throw new Error("source commit unavailable in shallow checkout");
      },
    });
    const sqlite = new Database(generated, { readonly: true });
    try {
      expect(() => validateGeneratedV012FixtureDatabase(sqlite)).not.toThrow();
      expect(sqlite.prepare("select count(*) as count from __drizzle_migrations").get()).toEqual({
        count: 32,
      });
    } finally {
      sqlite.close();
    }

    expect(() =>
      generateV012FixtureFromSource(path.join(directory, "tampered.sqlite"), {
        readGitFile: () => {
          throw new Error("source commit unavailable in shallow checkout");
        },
        readLocalFile: (filePath) => {
          const contents = readFileSync(path.join(repositoryDirectory, filePath), "utf8");
          return filePath.endsWith("/0000_foundation.sql")
            ? `${contents}\n-- mutable migration`
            : contents;
        },
      }),
    ).toThrow(/does not match the fixed source commit/u);
  });

  it("rejects incorrect migration counts and foreign-key violations", () => {
    const directory = temporaryDirectory();
    const generated = path.join(directory, "generated.sqlite");
    generateV012FixtureFromSource(generated);
    const wrongCount = path.join(directory, "wrong-count.sqlite");
    copyFileSync(generated, wrongCount);
    const countDatabase = new Database(wrongCount);
    try {
      countDatabase
        .prepare(
          "delete from __drizzle_migrations where rowid = (select max(rowid) from __drizzle_migrations)",
        )
        .run();
      expect(() => validateGeneratedV012FixtureDatabase(countDatabase)).toThrow(
        /31 migrations instead of 32/u,
      );
    } finally {
      countDatabase.close();
    }

    const foreignKey = path.join(directory, "foreign-key.sqlite");
    copyFileSync(generated, foreignKey);
    const foreignKeyDatabase = new Database(foreignKey);
    try {
      foreignKeyDatabase.pragma("foreign_keys = off");
      foreignKeyDatabase.exec(`
        create table fixture_parent (id integer primary key);
        create table fixture_child (
          id integer primary key,
          parent_id integer not null references fixture_parent(id)
        );
        insert into fixture_child (id, parent_id) values (1, 404);
      `);
      expect(() => validateGeneratedV012FixtureDatabase(foreignKeyDatabase)).toThrow(
        /foreign_key_check/u,
      );
    } finally {
      foreignKeyDatabase.close();
    }
  });

  it("publishes complete evidence atomically and detects incomplete prior evidence", () => {
    const directory = temporaryDirectory();
    const artifact = path.join(directory, "source.sqlite");
    const published = path.join(directory, "published");
    writeFileSync(artifact, "first fixture", { mode: 0o600 });

    publishV012FixtureAtomically(artifact, "first checksum\n", { provisional: true }, published);
    expect(readFileSync(path.join(published, "v0.12.0.sqlite"), "utf8")).toBe("first fixture");
    expect(readFileSync(path.join(published, "SHA256SUMS"), "utf8")).toBe("first checksum\n");
    expect(existingV012FixtureProvenance(published)).toEqual({ provisional: true });
    expect(readdirSync(published).sort()).toEqual([
      "SHA256SUMS",
      "provenance.json",
      "v0.12.0.sqlite",
    ]);

    writeFileSync(artifact, "replacement fixture", { mode: 0o600 });
    publishV012FixtureAtomically(
      artifact,
      "replacement checksum\n",
      { provisional: false },
      published,
    );
    expect(readFileSync(path.join(published, "v0.12.0.sqlite"), "utf8")).toBe(
      "replacement fixture",
    );
    expect(existingV012FixtureProvenance(published)).toEqual({ provisional: false });

    unlinkSync(path.join(published, "SHA256SUMS"));
    expect(() =>
      publishV012FixtureAtomically(artifact, "third checksum\n", { provisional: true }, published),
    ).toThrow(/evidence is incomplete/u);
    expect(readdirSync(published).every((name) => !name.endsWith(".partial"))).toBe(true);

    writeFileSync(path.join(published, "provenance.json"), "not-json", { mode: 0o600 });
    expect(existingV012FixtureProvenance(published)).toBeUndefined();
    expect(existingV012FixtureProvenance(path.join(directory, "missing"))).toBeUndefined();
    expect(stableV012FixtureJson({ z: true })).toBe('{\n  "z": true\n}\n');
  });

  it("rejects invalid image commands and readiness policies before Docker work", () => {
    expect(() =>
      imageFixtureDockerCommands({
        artifactOutputPath: "/tmp/artifact",
        containerName: "fixture",
        imageReference,
        metadataOutputPath: "/tmp/metadata",
        readyMarker: "not-a-ready-marker",
      }),
    ).toThrow(/immutable image/u);

    const lifecycleCommands = commands();
    for (const dependencies of [
      { pollIntervalMs: 0, readyTimeoutMs: 10 },
      { pollIntervalMs: 10, readyTimeoutMs: 5 },
      { pollIntervalMs: Number.NaN, readyTimeoutMs: 10 },
    ]) {
      let executions = 0;
      expect(() =>
        runImageFixtureDockerLifecycle(lifecycleCommands, readyMarker, {
          execute: () => {
            executions += 1;
            return "";
          },
          ...dependencies,
        }),
      ).toThrow(/readiness policy/u);
      expect(executions).toBe(0);
    }
  });

  it("removes only created containers across readiness and creation failures", () => {
    const lifecycleCommands = commands();
    const events: string[] = [];
    expect(() =>
      runImageFixtureDockerLifecycle(lifecycleCommands, readyMarker, {
        execute: (arguments_) => {
          events.push(arguments_[0]!);
          if (arguments_[0] === "create") throw new Error("docker unavailable");
          return "";
        },
      }),
    ).toThrow(/docker unavailable/u);
    expect(events).toEqual(["create"]);

    const readyExitEvents: string[] = [];
    expect(() =>
      runImageFixtureDockerLifecycle(lifecycleCommands, readyMarker, {
        execute: (arguments_) => {
          readyExitEvents.push(arguments_[0]!);
          if (arguments_[0] === "image") return "{}";
          if (arguments_[0] === "logs") return `${readyMarker}\n`;
          if (arguments_[0] === "inspect") return JSON.stringify({ ExitCode: 0, Running: false });
          return "";
        },
        now: () => 0,
        wait: () => undefined,
      }),
    ).toThrow(/exited after readiness/u);
    expect(readyExitEvents.at(-1)).toBe("rm");

    expect(() =>
      runImageFixtureDockerLifecycle(lifecycleCommands, readyMarker, {
        execute: (arguments_) => {
          if (arguments_[0] === "image") return "{}";
          if (arguments_[0] === "logs") return "not ready";
          if (arguments_[0] === "inspect") return JSON.stringify({ Running: false });
          return "";
        },
        now: () => 0,
        wait: () => undefined,
      }),
    ).toThrow(/exit unknown/u);
  });
});
