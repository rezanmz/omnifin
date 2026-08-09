import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/client.js";

describe("invitation schema migration", () => {
  it("creates the hashed, recipient-free invitation foundation", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const columns = (database.sqlite.pragma("table_info(invitations)") as { name: string }[]).map(
        ({ name }) => name,
      );
      expect(columns).toEqual([
        "id",
        "token_hash",
        "expires_at",
        "consumed_at",
        "revoked_at",
        "registration_handoff_hash",
        "registration_handoff_expires_at",
        "created_at",
      ]);
      expect(columns).not.toContain("role");
      expect(columns).not.toContain("recipient");
      expect(columns).not.toContain("token");
      expect(database.sqlite.pragma("index_list(invitations)")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "invitations_token_hash_unique" }),
          expect.objectContaining({ name: "invitations_created_idx" }),
          expect.objectContaining({ name: "invitations_expiry_idx" }),
          expect.objectContaining({ name: "invitations_registration_handoff_hash_unique" }),
        ]),
      );
      const tableSql = (
        database.sqlite
          .prepare("select sql from sqlite_master where type = 'table' and name = 'invitations'")
          .get() as { sql: string }
      ).sql;
      for (const constraint of [
        "invitations_id_check",
        "invitations_token_hash_check",
        "invitations_registration_handoff_hash_check",
        "invitations_timestamp_check",
      ]) {
        expect(tableSql).toContain(`CONSTRAINT "${constraint}"`);
      }
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces identifiers, hashes, handoff fields, terminal clearing, expiry bounds, and uniqueness", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const hash = "h".repeat(43);
      const base = {
        created_at: 1_000,
        expires_at: 10_000,
        token_hash: "t".repeat(43),
      };
      expect(() =>
        database.sqlite
          .prepare(
            "insert into invitations (id, token_hash, expires_at, created_at) values (?, ?, ?, ?)",
          )
          .run("invalid_invitation", base.token_hash, base.expires_at, base.created_at),
      ).toThrow(/invitations_id_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            "insert into invitations (id, token_hash, expires_at, created_at) values (?, ?, ?, ?)",
          )
          .run("invite_invalid_token", "t".repeat(42), base.expires_at, base.created_at),
      ).toThrow(/invitations_token_hash_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (id, token_hash, expires_at, registration_handoff_hash,
             registration_handoff_expires_at, created_at) values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "invite_invalid_handoff",
            "i".repeat(43),
            base.expires_at,
            "h".repeat(42),
            3_000,
            base.created_at,
          ),
      ).toThrow(/invitations_registration_handoff_hash_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (id, token_hash, expires_at, registration_handoff_hash, created_at)
             values (?, ?, ?, ?, ?)`,
          )
          .run("invite_hash_only", base.token_hash, base.expires_at, hash, base.created_at),
      ).toThrow(/invitations_timestamp_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            "insert into invitations (id, token_hash, expires_at, consumed_at, created_at) values (?, ?, ?, ?, ?)",
          )
          .run(
            "invite_consumed_before_created",
            "b".repeat(43),
            base.expires_at,
            999,
            base.created_at,
          ),
      ).toThrow(/invitations_timestamp_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            "insert into invitations (id, token_hash, expires_at, consumed_at, revoked_at, created_at) values (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "invite_consumed_revoked",
            "v".repeat(43),
            base.expires_at,
            2_000,
            3_000,
            base.created_at,
          ),
      ).toThrow(/invitations_timestamp_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (id, token_hash, expires_at, registration_handoff_expires_at, created_at)
             values (?, ?, ?, ?, ?)`,
          )
          .run("invite_expiry_only", "e".repeat(43), base.expires_at, 2_000, base.created_at),
      ).toThrow(/invitations_timestamp_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (
               id, token_hash, expires_at, consumed_at, registration_handoff_hash,
               registration_handoff_expires_at, created_at
             ) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "invite_terminal_handoff",
            "c".repeat(43),
            base.expires_at,
            2_000,
            hash,
            3_000,
            base.created_at,
          ),
      ).toThrow(/invitations_timestamp_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (
               id, token_hash, expires_at, registration_handoff_hash,
               registration_handoff_expires_at, created_at
             ) values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "invite_late_handoff",
            "l".repeat(43),
            base.expires_at,
            hash,
            10_001,
            base.created_at,
          ),
      ).toThrow(/invitations_timestamp_check/u);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (id, token_hash, expires_at, revoked_at, created_at)
             values (?, ?, ?, ?, ?)`,
          )
          .run(
            "invite_expired_revoke",
            "r".repeat(43),
            base.expires_at,
            base.expires_at,
            base.created_at,
          ),
      ).toThrow(/invitations_timestamp_check/u);

      database.sqlite
        .prepare(
          `insert into invitations (
             id, token_hash, expires_at, registration_handoff_hash,
             registration_handoff_expires_at, created_at
           ) values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "invite_unique_handoff",
          "u".repeat(43),
          base.expires_at,
          hash,
          3_000,
          base.created_at,
        );
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (id, token_hash, expires_at, registration_handoff_hash,
             registration_handoff_expires_at, created_at) values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "invite_duplicate_handoff",
            "d".repeat(43),
            base.expires_at,
            hash,
            3_000,
            base.created_at,
          ),
      ).toThrow(/UNIQUE/u);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into invitations (id, token_hash, expires_at, created_at)
             values (?, ?, ?, ?)`,
          )
          .run("invite_duplicate_token", "u".repeat(43), base.expires_at, base.created_at),
      ).toThrow(/UNIQUE/u);
    } finally {
      database.close();
    }
  });
});
