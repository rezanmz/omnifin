#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire("/app/package.json");
const sqlite3 = require("sqlite3");
const DATABASE_PATH = "/app/config/db/db.sqlite3";
const EXPECTED_COLUMNS = new Set([
  "avatar",
  "email",
  "id",
  "jellyfinUserId",
  "jellyfinUsername",
  "permissions",
  "userType",
]);

function openDatabase() {
  return new Promise((resolvePromise, reject) => {
    const database = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READWRITE, (error) =>
      error ? reject(error) : resolvePromise(database),
    );
  });
}

function all(database, sql, parameters = []) {
  return new Promise((resolvePromise, reject) => {
    database.all(sql, parameters, (error, rows) => (error ? reject(error) : resolvePromise(rows)));
  });
}

function run(database, sql, parameters = []) {
  return new Promise((resolvePromise, reject) => {
    database.run(sql, parameters, (error) => (error ? reject(error) : resolvePromise()));
  });
}

function close(database) {
  return new Promise((resolvePromise, reject) => {
    database.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

let database;
try {
  database = await openDatabase();
  const columns = await all(database, 'PRAGMA table_info("user")');
  const names = new Set(columns.map((column) => column.name));
  if (
    columns.length < EXPECTED_COLUMNS.size ||
    [...EXPECTED_COLUMNS].some((name) => !names.has(name))
  ) {
    throw new Error("schema_invalid");
  }
  const existing = await all(database, 'SELECT COUNT(*) AS count FROM "user"');
  if (existing.length !== 1 || existing[0]?.count !== 0) throw new Error("database_not_empty");

  await run(database, "BEGIN IMMEDIATE");
  await run(
    database,
    'INSERT INTO "user" (id, email, jellyfinUsername, jellyfinUserId, permissions, avatar, userType) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [1, "admin@fixture.invalid", "fixture-admin", "fixture-admin-id", 2, "/logo_full.svg", 3],
  );
  await run(
    database,
    'INSERT INTO "user" (id, email, jellyfinUsername, jellyfinUserId, permissions, avatar, userType) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      2,
      "requester@fixture.invalid",
      "fixture-requester",
      "fixture-requester-id",
      262_176,
      "/logo_full.svg",
      3,
    ],
  );
  await run(database, "COMMIT");
  const seeded = await all(database, 'SELECT COUNT(*) AS count FROM "user"');
  if (seeded.length !== 1 || seeded[0]?.count !== 2) throw new Error("seed_invalid");
  await close(database);
  database = undefined;
  process.stdout.write('{"status":"ok"}\n');
} catch {
  if (database) {
    await run(database, "ROLLBACK").catch(() => undefined);
    await close(database).catch(() => undefined);
  }
  process.stderr.write('{"code":"database_seed_failed","status":"failed"}\n');
  process.exitCode = 1;
}
