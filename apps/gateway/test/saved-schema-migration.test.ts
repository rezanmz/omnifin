import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/client.js";

const listA = `saved_list_${"a".repeat(22)}`;
const listB = `saved_list_${"b".repeat(22)}`;
const catalogA = `catalog_${"a".repeat(22)}`;
const catalogASecond = `catalog_${"c".repeat(22)}`;
const catalogB = `catalog_${"b".repeat(22)}`;

function insertUser(database: ReturnType<typeof openDatabase>, id: string) {
  database.sqlite
    .prepare(
      `insert into users (
         id, display_name, role, role_source, status, created_at, updated_at
       ) values (?, ?, 'viewer', 'default', 'active', 1000, 1000)`,
    )
    .run(id, `Private ${id}`);
}

function insertList(
  database: ReturnType<typeof openDatabase>,
  input: { id: string; kind: "custom" | "watch_later"; userId: string },
) {
  database.sqlite
    .prepare(
      `insert into saved_lists (
         id, user_id, kind, encrypted_name, revision, created_at, updated_at
       ) values (?, ?, ?, 'v2.private-name', 0, 1000, 1000)`,
    )
    .run(input.id, input.userId, input.kind);
}

function insertCatalog(
  database: ReturnType<typeof openDatabase>,
  input: { digest: string; id: string; userId: string },
) {
  database.sqlite
    .prepare(
      `insert into saved_catalog_items (
         id, user_id, identity_digest, encrypted_identity, encrypted_snapshot,
         created_at, updated_at
       ) values (?, ?, ?, 'v2.private-identity', 'v2.private-snapshot', 1000, 1000)`,
    )
    .run(input.id, input.userId, input.digest);
}

describe("saved-list storage migration", () => {
  it("enforces one Watch Later list and owner-scoped catalog membership", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      insertUser(database, "saved-user-a");
      insertUser(database, "saved-user-b");
      insertList(database, { id: listA, kind: "watch_later", userId: "saved-user-a" });
      insertCatalog(database, {
        digest: "a".repeat(22),
        id: catalogA,
        userId: "saved-user-a",
      });
      insertCatalog(database, {
        digest: "c".repeat(22),
        id: catalogASecond,
        userId: "saved-user-a",
      });
      insertCatalog(database, {
        digest: "b".repeat(22),
        id: catalogB,
        userId: "saved-user-b",
      });

      expect(() =>
        insertList(database, {
          id: listB,
          kind: "watch_later",
          userId: "saved-user-a",
        }),
      ).toThrow();
      expect(() =>
        database.sqlite
          .prepare(
            `insert into saved_list_items (
               id, user_id, list_id, catalog_item_id, position, created_at, updated_at
             ) values (?, 'saved-user-a', ?, ?, 0, 1000, 1000)`,
          )
          .run(`saved_item_${"b".repeat(22)}`, listA, catalogB),
      ).toThrow();

      database.sqlite
        .prepare(
          `insert into saved_list_items (
             id, user_id, list_id, catalog_item_id, position, created_at, updated_at
           ) values (?, 'saved-user-a', ?, ?, 0, 1000, 1000)`,
        )
        .run(`saved_item_${"a".repeat(22)}`, listA, catalogA);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into saved_list_items (
               id, user_id, list_id, catalog_item_id, position, created_at, updated_at
             ) values (?, 'saved-user-a', ?, ?, 0, 1000, 1000)`,
          )
          .run(`saved_item_${"c".repeat(22)}`, listA, catalogASecond),
      ).toThrow();
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps Watch Later undeletable and successful operation responses encrypted", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      insertUser(database, "saved-user-a");
      insertList(database, { id: listA, kind: "watch_later", userId: "saved-user-a" });

      expect(() =>
        database.sqlite
          .prepare(
            "update saved_lists set deleted_at = 1001, undo_expires_at = 2000, updated_at = 1001 where id = ?",
          )
          .run(listA),
      ).toThrow();
      expect(() =>
        database.sqlite
          .prepare(
            `insert into saved_list_operations (
               id, user_id, kind, idempotency_key_hash, fingerprint_hash,
               state, completed_at, created_at, updated_at
             ) values (?, 'saved-user-a', 'create_list', ?, ?, 'succeeded', 1001, 1000, 1001)`,
          )
          .run(`saved_operation_${"a".repeat(22)}`, "k".repeat(43), "f".repeat(22)),
      ).toThrow();

      database.sqlite
        .prepare(
          `insert into saved_list_operations (
             id, user_id, kind, idempotency_key_hash, fingerprint_hash,
             state, encrypted_response, completed_at, created_at, updated_at
           ) values (?, 'saved-user-a', 'create_list', ?, ?, 'succeeded',
             'v2.private-response', 1001, 1000, 1001)`,
        )
        .run(`saved_operation_${"a".repeat(22)}`, "k".repeat(43), "f".repeat(22));
      expect(
        database.sqlite
          .prepare(
            "select encrypted_response as encryptedResponse from saved_list_operations limit 1",
          )
          .get(),
      ).toEqual({ encryptedResponse: "v2.private-response" });
    } finally {
      database.close();
    }
  });
});
