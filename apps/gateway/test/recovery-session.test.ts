import { describe, expect, it } from "vitest";
import { revokeRecoverySessionsOnStartup } from "../src/auth/recovery-session.js";
import { openDatabase } from "../src/db/client.js";

describe("recovery-session lifecycle", () => {
  it("revokes and audits every active recovery session at process startup", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      database.sqlite.exec(`
        insert into sessions (
          id, token_hash, auth_method, csrf_token_hash, encrypted_csrf_token,
          created_at, last_rotated_at, last_seen_at, expires_at, absolute_expires_at
        ) values (
          'recovery-active', '${"t".repeat(43)}', 'recovery', '${"c".repeat(43)}',
          'v2.fixture-csrf', 1000, 1000, 1000, 3000, 4000
        )
      `);

      expect(revokeRecoverySessionsOnStartup(database, new Date(2000))).toBe(1);
      expect(
        database.sqlite
          .prepare("select revoked_at as revokedAt from sessions where id = 'recovery-active'")
          .get(),
      ).toEqual({ revokedAt: 2000 });
      expect(
        database.sqlite
          .prepare(
            `select
              session_id as sessionId,
              actor_session_id as actorSessionId,
              actor_auth_method as actorAuthMethod,
              event_type as eventType,
              metadata_json as metadataJson
             from audit_events`,
          )
          .get(),
      ).toEqual({
        actorAuthMethod: "recovery",
        actorSessionId: "recovery-active",
        eventType: "auth.recovery_session.revoked",
        metadataJson: '{"reason":"gateway_startup"}',
        sessionId: "recovery-active",
      });

      expect(revokeRecoverySessionsOnStartup(database, new Date(2500))).toBe(0);
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects an invalid revocation clock", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      expect(() => revokeRecoverySessionsOnStartup(database, new Date(Number.NaN))).toThrow(
        /valid time/i,
      );
    } finally {
      database.close();
    }
  });
});
