import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db/client.js";

interface RecoverySessionRow {
  createdAt: number;
  id: string;
}

export function revokeRecoverySessionsOnStartup(database: DatabaseHandle, now: Date = new Date()) {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) throw new TypeError("Recovery revocation requires a valid time.");

  return database.sqlite
    .transaction(() => {
      const sessions = database.sqlite
        .prepare(
          `select id, created_at as createdAt
           from sessions
           where auth_method = 'recovery' and revoked_at is null`,
        )
        .all() as RecoverySessionRow[];
      const revoke = database.sqlite.prepare(
        "update sessions set revoked_at = ? where id = ? and revoked_at is null",
      );
      const audit = database.sqlite.prepare(
        `insert into audit_events (
          id,
          session_id,
          actor_session_id,
          actor_auth_method,
          event_type,
          outcome,
          target_type,
          target_id,
          metadata_json,
          created_at
        ) values (?, ?, ?, 'recovery', 'auth.recovery_session.revoked', 'success', 'session', ?, ?, ?)`,
      );

      for (const session of sessions) {
        const revokedAt = Math.max(nowTime, session.createdAt);
        const result = revoke.run(revokedAt, session.id);
        if (result.changes !== 1) continue;
        audit.run(
          randomUUID(),
          session.id,
          session.id,
          session.id,
          JSON.stringify({ reason: "gateway_startup" }),
          revokedAt,
        );
      }
      return sessions.length;
    })
    .immediate();
}
