import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/client.js";
import { purgeExpiredSavedState, SAVED_OPERATION_RETENTION_MS } from "../src/saved/maintenance.js";

const now = 20 * 24 * 60 * 60 * 1_000;

describe("saved-state maintenance", () => {
  it("rejects an invalid clock or batch size before touching the database", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      expect(() => purgeExpiredSavedState(database, -1)).toThrow(TypeError);
      expect(() => purgeExpiredSavedState(database, Number.NaN)).toThrow(TypeError);
      expect(() => purgeExpiredSavedState(database, now, 0)).toThrow(TypeError);
    } finally {
      database.close();
    }
  });

  it("purges every expired category in independent bounded batches", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      database.sqlite
        .prepare(
          `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
           values ('maintenance-user', 'Maintenance user', 'viewer', 'default', 'active', 1000, 1000)`,
        )
        .run();
      database.sqlite
        .prepare(
          `insert into connector_configs (
             id, type, display_name, base_url, encrypted_credentials, tls_policy,
             insecure_http_approved, capability_snapshot_json, health_state, enabled,
             created_at, updated_at
           ) values ('maintenance-jellyfin', 'jellyfin', 'Jellyfin', 'https://example.test/',
             'sealed', 'strict', 0, '{}', 'healthy', 1, 1000, 1000)`,
        )
        .run();
      database.sqlite
        .prepare(
          `insert into service_identity_links (
             id, user_id, service, connector_id, external_server_id, external_user_id,
             external_username, external_display_name, encrypted_access_token, device_id,
             token_created_at, health_state, revision, created_at, updated_at
           ) values ('maintenance-link', 'maintenance-user', 'jellyfin', 'maintenance-jellyfin',
             'server', 'external-user', 'viewer', 'Viewer', 'sealed', 'device', 1000,
             'linked', 1, 1000, 1000)`,
        )
        .run();
      database.sqlite
        .prepare(
          `insert into saved_lists (
             id, user_id, kind, encrypted_name, revision, deleted_at, undo_expires_at,
             created_at, updated_at
           ) values (?, 'maintenance-user', 'custom', 'sealed', 1, 1001, 2000, 1000, 1001)`,
        )
        .run(`saved_list_${"l".repeat(22)}`);
      database.sqlite
        .prepare(
          `insert into saved_targets (
             id, user_id, service_identity_link_id, link_revision, identity_digest,
             encrypted_payload, last_used_at, expires_at, created_at, updated_at
           ) values (?, 'maintenance-user', 'maintenance-link', 1, ?, 'sealed',
             1000, 2000, 1000, 1000)`,
        )
        .run(`save_target_${"t".repeat(22)}`, "t".repeat(22));
      for (const token of ["a", "b"]) {
        database.sqlite
          .prepare(
            `insert into saved_list_operations (
               id, user_id, kind, idempotency_key_hash, fingerprint_hash, state,
               encrypted_response, completed_at, created_at, updated_at
             ) values (?, 'maintenance-user', 'create_list', ?, ?, 'succeeded',
               'sealed', 1001, 1000, 1001)`,
          )
          .run(`saved_operation_${token.repeat(22)}`, token.repeat(43), token.repeat(22));
      }
      database.sqlite
        .prepare(
          `insert into saved_catalog_items (
             id, user_id, identity_digest, encrypted_identity, encrypted_snapshot,
             created_at, updated_at
           ) values (?, 'maintenance-user', ?, 'sealed', 'sealed', 1000, 1000)`,
        )
        .run(`catalog_${"c".repeat(22)}`, "c".repeat(22));

      expect(now - SAVED_OPERATION_RETENTION_MS).toBeGreaterThan(1001);
      const first = purgeExpiredSavedState(database, now, 1);
      expect(first).toEqual({
        catalogItems: 1,
        lifecycleMismatches: 0,
        lists: 1,
        operations: 1,
        targets: 1,
      });
      expect(purgeExpiredSavedState(database, now, 1).operations).toBe(1);
      expect(purgeExpiredSavedState(database, now, 1)).toEqual({
        catalogItems: 0,
        lifecycleMismatches: 0,
        lists: 0,
        operations: 0,
        targets: 0,
      });
    } finally {
      database.close();
    }
  });
});
