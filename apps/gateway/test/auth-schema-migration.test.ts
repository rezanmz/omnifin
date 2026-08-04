import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import * as authenticationSchema from "../src/db/schema.js";

const migrationDirectory = path.resolve(import.meta.dirname, "../drizzle");
const expectedMigrationCount = readdirSync(migrationDirectory).filter((filename) =>
  /^\d{4}_.+\.sql$/u.test(filename),
).length;

function applyMigration(database: Database.Database, filename: string) {
  const migration = readFileSync(path.join(migrationDirectory, filename), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) database.exec(statement);
  }
}

function applyPreReservationMigrations(database: Database.Database) {
  applyMigration(database, "0000_foundation.sql");
  applyMigration(database, "0001_auth_security_foundation.sql");
  database.transaction(() => applyMigration(database, "0002_oidc_runtime_security.sql"))();
}

function insertPreReservationSession(
  database: Database.Database,
  input: {
    createdAt: number;
    csrfTokenHash: string;
    id: string;
    lastRotatedAt: number;
    tokenHash: string;
  },
) {
  database
    .prepare(
      `insert into sessions (
        id,
        token_hash,
        auth_method,
        csrf_token_hash,
        encrypted_csrf_token,
        created_at,
        last_rotated_at,
        last_seen_at,
        expires_at,
        absolute_expires_at
      ) values (
        @id,
        @tokenHash,
        'recovery',
        @csrfTokenHash,
        'v1.fixture-csrf-token',
        @createdAt,
        @lastRotatedAt,
        @lastRotatedAt,
        @expiresAt,
        @absoluteExpiresAt
      )`,
    )
    .run({
      ...input,
      absoluteExpiresAt: input.lastRotatedAt + 20_000,
      expiresAt: input.lastRotatedAt + 10_000,
    });
}

const sessionTokenHash = "t".repeat(43);
const csrfTokenHash = "c".repeat(43);

interface SessionFixture {
  absoluteExpiresAt: number;
  authMethod: "jellyfin" | "recovery";
  createdAt: number;
  csrfTokenHash: string;
  encryptedCsrfToken: string;
  expiresAt: number;
  id: string;
  lastRotatedAt: number;
  lastSeenAt: number;
  serviceIdentityLinkId: string | null;
  tokenHash: string;
  userId: string | null;
}

function insertSession(
  database: ReturnType<typeof openDatabase>,
  overrides: Partial<SessionFixture> = {},
) {
  const values: SessionFixture = {
    absoluteExpiresAt: 4000,
    authMethod: "jellyfin",
    createdAt: 1000,
    csrfTokenHash,
    encryptedCsrfToken: "v1.fixture-csrf-token",
    expiresAt: 3000,
    id: "session-valid",
    lastRotatedAt: 1500,
    lastSeenAt: 2000,
    serviceIdentityLinkId: "link-user-1",
    tokenHash: sessionTokenHash,
    userId: "user-1",
    ...overrides,
  };
  database.sqlite
    .prepare(
      `insert into sessions (
        id,
        token_hash,
        user_id,
        auth_method,
        service_identity_link_id,
        csrf_token_hash,
        encrypted_csrf_token,
        created_at,
        last_rotated_at,
        last_seen_at,
        expires_at,
        absolute_expires_at
      ) values (
        @id,
        @tokenHash,
        @userId,
        @authMethod,
        @serviceIdentityLinkId,
        @csrfTokenHash,
        @encryptedCsrfToken,
        @createdAt,
        @lastRotatedAt,
        @lastSeenAt,
        @expiresAt,
        @absoluteExpiresAt
      )`,
    )
    .run(values);
}

function seedUsersAndJellyfin(database: ReturnType<typeof openDatabase>) {
  database.sqlite.exec(`
    insert into users (id, display_name, role, role_source, status, created_at, updated_at)
    values
      ('user-1', 'Riley', 'viewer', 'default', 'active', 1000, 1000),
      ('user-2', 'Morgan', 'requester', 'manual', 'active', 1000, 1000),
      ('user-3', 'Casey', 'operator', 'oidc_mapping', 'active', 1000, 1000);

    insert into connector_configs (
      id,
      type,
      display_name,
      base_url,
      encrypted_credentials,
      created_at,
      updated_at
    ) values
      (
        'jellyfin-home',
        'jellyfin',
        'Home Jellyfin',
        'https://jellyfin.example.test',
        'v1.fixture-connector-secret',
        1000,
        1000
      ),
      (
        'radarr-automation',
        'radarr',
        'Radarr automation',
        'https://radarr.example.test',
        'v1.fixture-radarr-secret',
        1000,
        1000
      );
  `);
}

function insertLinkedIdentity(database: ReturnType<typeof openDatabase>) {
  database.sqlite.exec(`
    insert into service_identity_links (
      id,
      user_id,
      service,
      connector_id,
      external_server_id,
      external_user_id,
      external_username,
      external_display_name,
      encrypted_access_token,
      device_id,
      token_created_at,
      health_state,
      revision,
      created_at,
      updated_at
    ) values (
      'link-user-1',
      'user-1',
      'jellyfin',
      'jellyfin-home',
      'server-home',
      'external-user-1',
      'riley',
      'Riley',
      'v1.fixture-access-token',
      'device-user-1',
      1000,
      'linked',
      0,
      1000,
      1000
    );
  `);
}

describe("authentication schema upgrades", () => {
  it("preserves active Quick Connect sign-in transactions while adding pairing ownership", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = OFF");
      for (const migration of [
        "0000_foundation.sql",
        "0001_auth_security_foundation.sql",
        "0002_oidc_runtime_security.sql",
        "0003_session_secret_reservations.sql",
        "0004_oidc_failure_audit_budget.sql",
        "0005_session_issuance_indexes.sql",
        "0006_jellyfin_quick_connect.sql",
      ]) {
        applyMigration(database, migration);
      }
      database.pragma("foreign_keys = ON");
      database.exec(`
        insert into connector_configs (
          id, type, display_name, base_url, encrypted_credentials, created_at, updated_at
        ) values (
          'jellyfin-home',
          'jellyfin',
          'Home Jellyfin',
          'https://jellyfin.example.test',
          'v1.fixture-connector-secret',
          1000,
          1000
        );

        insert into jellyfin_quick_connect_transactions (
          id,
          connector_id,
          connector_type,
          browser_binding_hash,
          encrypted_payload,
          expires_at,
          next_poll_at,
          poll_count,
          consumed_at,
          created_at
        ) values (
          'quick-connect-before-pairing',
          'jellyfin-home',
          'jellyfin',
          '${"b".repeat(43)}',
          'v1.fixture-encrypted-payload',
          3000,
          2000,
          4,
          null,
          1000
        );
      `);

      applyMigration(database, "0007_jellyfin_quick_connect_pairing.sql");

      expect(
        database
          .prepare(
            `select
              id,
              purpose,
              pairing_session_id as pairingSessionId,
              browser_binding_hash as browserBindingHash,
              encrypted_payload as encryptedPayload,
              poll_count as pollCount
             from jellyfin_quick_connect_transactions`,
          )
          .get(),
      ).toEqual({
        browserBindingHash: "b".repeat(43),
        encryptedPayload: "v1.fixture-encrypted-payload",
        id: "quick-connect-before-pairing",
        pairingSessionId: null,
        pollCount: 4,
        purpose: "sign_in",
      });
      expect(
        database
          .prepare(
            `select name
             from sqlite_master
             where type = 'index'
               and name = 'jellyfin_quick_connect_transactions_pairing_session_idx'`,
          )
          .get(),
      ).toEqual({ name: "jellyfin_quick_connect_transactions_pairing_session_idx" });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("preserves Quick Connect transactions while adding recovery-bound bootstrap", () => {
    const database = new Database(":memory:");
    try {
      for (const migration of readdirSync(migrationDirectory)
        .filter((filename) => /^00(?:0\d|1[0-8])_.+\.sql$/u.test(filename))
        .sort()) {
        applyMigration(database, migration);
      }
      database.exec(`
        insert into connector_configs (
          id, type, display_name, base_url, encrypted_credentials, created_at, updated_at
        ) values (
          'jellyfin-home',
          'jellyfin',
          'Home Jellyfin',
          'https://jellyfin.example.test',
          'v1.fixture-connector-secret',
          1000,
          1000
        );

        insert into sessions (
          id, token_hash, auth_method, csrf_token_hash, encrypted_csrf_token,
          created_at, last_rotated_at, last_seen_at, expires_at, absolute_expires_at
        ) values (
          'recovery-bootstrap-session',
          '${"r".repeat(43)}',
          'recovery',
          '${"s".repeat(43)}',
          'v1.fixture-csrf-token',
          1000,
          1000,
          1000,
          3000,
          4000
        );

        insert into jellyfin_quick_connect_transactions (
          id, connector_id, purpose, pairing_session_id, browser_binding_hash,
          encrypted_payload, expires_at, next_poll_at, created_at
        ) values
          (
            'quick-connect-sign-in', 'jellyfin-home', 'sign_in', null,
            '${"a".repeat(43)}', 'v1.fixture-sign-in', 3000, 2000, 1000
          ),
          (
            'quick-connect-pairing', 'jellyfin-home', 'pairing',
            'recovery-bootstrap-session', '${"b".repeat(43)}',
            'v1.fixture-pairing', 3000, 2000, 1000
          );
      `);

      applyMigration(database, "0019_jellyfin_admin_bootstrap.sql");

      expect(
        database
          .prepare(
            `select id, purpose, pairing_session_id as pairingSessionId, encrypted_payload as payload
             from jellyfin_quick_connect_transactions
             order by id`,
          )
          .all(),
      ).toEqual([
        {
          id: "quick-connect-pairing",
          pairingSessionId: "recovery-bootstrap-session",
          payload: "v1.fixture-pairing",
          purpose: "pairing",
        },
        {
          id: "quick-connect-sign-in",
          pairingSessionId: null,
          payload: "v1.fixture-sign-in",
          purpose: "sign_in",
        },
      ]);
      expect(() =>
        database
          .prepare(
            `insert into jellyfin_quick_connect_transactions (
              id, connector_id, purpose, pairing_session_id, browser_binding_hash,
              encrypted_payload, expires_at, next_poll_at, created_at
            ) values (?, 'jellyfin-home', 'bootstrap', null, ?, 'v1.invalid', 3000, 2000, 1000)`,
          )
          .run("bootstrap-without-session", "c".repeat(43)),
      ).toThrow(/CHECK constraint failed/u);
      database
        .prepare(
          `insert into jellyfin_quick_connect_transactions (
            id, connector_id, purpose, pairing_session_id, browser_binding_hash,
            encrypted_payload, expires_at, next_poll_at, created_at
          ) values (?, 'jellyfin-home', 'bootstrap', 'recovery-bootstrap-session', ?, ?, 3000, 2000, 1000)`,
        )
        .run("quick-connect-bootstrap", "d".repeat(43), "v1.fixture-bootstrap");
      expect(
        database
          .prepare(
            "select purpose, pairing_session_id as pairingSessionId from jellyfin_quick_connect_transactions where id = ?",
          )
          .get("quick-connect-bootstrap"),
      ).toEqual({ pairingSessionId: "recovery-bootstrap-session", purpose: "bootstrap" });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("backfills every existing bearer and CSRF hash with immutable origin attribution", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      applyPreReservationMigrations(database);
      insertPreReservationSession(database, {
        createdAt: 1_000,
        csrfTokenHash: "c".repeat(43),
        id: "session-one",
        lastRotatedAt: 1_500,
        tokenHash: "a".repeat(43),
      });
      insertPreReservationSession(database, {
        createdAt: 2_000,
        csrfTokenHash: "d".repeat(43),
        id: "session-two",
        lastRotatedAt: 2_500,
        tokenHash: "b".repeat(43),
      });

      database.transaction(() =>
        applyMigration(database, "0003_session_secret_reservations.sql"),
      )();

      expect(
        database
          .prepare(
            `select
              secret_hash as secretHash,
              purpose,
              origin_session_id as originSessionId,
              reserved_at as reservedAt
            from session_secret_reservations
            order by origin_session_id, purpose`,
          )
          .all(),
      ).toEqual([
        {
          originSessionId: "session-one",
          purpose: "bearer",
          reservedAt: 1_500,
          secretHash: "a".repeat(43),
        },
        {
          originSessionId: "session-one",
          purpose: "csrf",
          reservedAt: 1_000,
          secretHash: "c".repeat(43),
        },
        {
          originSessionId: "session-two",
          purpose: "bearer",
          reservedAt: 2_500,
          secretHash: "b".repeat(43),
        },
        {
          originSessionId: "session-two",
          purpose: "csrf",
          reservedAt: 2_000,
          secretHash: "d".repeat(43),
        },
      ]);
      expect(
        database.prepare("select count(*) as count from session_rotation_aliases").get(),
      ).toEqual({ count: 0 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      configure: (database: Database.Database) => {
        insertPreReservationSession(database, {
          createdAt: 1_000,
          csrfTokenHash: "c".repeat(43),
          id: "session-one",
          lastRotatedAt: 1_000,
          tokenHash: "a".repeat(43),
        });
        insertPreReservationSession(database, {
          createdAt: 2_000,
          csrfTokenHash: "a".repeat(43),
          id: "session-two",
          lastRotatedAt: 2_000,
          tokenHash: "b".repeat(43),
        });
      },
      name: "cross-purpose reuse",
    },
    {
      configure: (database: Database.Database) => {
        insertPreReservationSession(database, {
          createdAt: 1_000,
          csrfTokenHash: "c".repeat(43),
          id: "session-one",
          lastRotatedAt: 1_000,
          tokenHash: "a".repeat(43),
        });
        insertPreReservationSession(database, {
          createdAt: 2_000,
          csrfTokenHash: "c".repeat(43),
          id: "session-two",
          lastRotatedAt: 2_000,
          tokenHash: "b".repeat(43),
        });
      },
      name: "duplicate CSRF hashes",
    },
    {
      configure: (database: Database.Database) => {
        database.exec("drop index sessions_token_hash_unique");
        insertPreReservationSession(database, {
          createdAt: 1_000,
          csrfTokenHash: "c".repeat(43),
          id: "session-one",
          lastRotatedAt: 1_000,
          tokenHash: "a".repeat(43),
        });
        insertPreReservationSession(database, {
          createdAt: 2_000,
          csrfTokenHash: "d".repeat(43),
          id: "session-two",
          lastRotatedAt: 2_000,
          tokenHash: "a".repeat(43),
        });
      },
      name: "duplicate bearer hashes in permissive legacy schemas",
    },
  ])("rolls the whole migration back for $name", ({ configure }) => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      applyPreReservationMigrations(database);
      configure(database);

      expect(() =>
        database.transaction(() =>
          applyMigration(database, "0003_session_secret_reservations.sql"),
        )(),
      ).toThrow(/UNIQUE constraint failed: session_secret_reservations\.secret_hash/);

      expect(
        database
          .prepare(
            `select name
            from sqlite_master
            where type = 'table'
              and name in ('session_secret_reservations', 'session_rotation_aliases')
            order by name`,
          )
          .all(),
      ).toEqual([]);
      expect(database.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 2,
      });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("invalidates legacy credentials while preserving identity and audit attribution", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      applyMigration(database, "0000_foundation.sql");
      database.exec(`
        insert into users (id, display_name, role, status, created_at, updated_at)
        values
          ('user-viewer', 'Riley', 'viewer', 'active', 1000, 1000),
          ('user-admin', 'Morgan', 'admin', 'active', 1000, 1000),
          ('user-oidc', 'Casey', 'requester', 'active', 1000, 1000),
          ('user-unlinked', 'Jordan', 'viewer', 'pending_link', 1000, 1000);

        insert into oidc_providers (
          id,
          slug,
          display_name,
          issuer,
          client_id,
          encrypted_client_secret,
          created_at,
          updated_at
        ) values
          (
            'oidc-home',
            'home',
            'Home identity',
            'https://id.example.test/application/o/omnifin/',
            'omnifin',
            null,
            1000,
            1000
          ),
          (
            'oidc-confidential',
            'confidential',
            'Confidential identity',
            'https://confidential-id.example.test/application/o/omnifin/',
            'omnifin-confidential',
            'v1.fixture-client-secret',
            1000,
            1000
          ),
          (
            'oidc-invalid-secret',
            'invalid-secret',
            'Invalid confidential identity',
            'https://invalid-secret.example.test/application/o/omnifin/',
            'omnifin-invalid-secret',
            '',
            1000,
            1000
          );

        insert into external_identities (
          id,
          user_id,
          provider_id,
          issuer,
          subject,
          display_claims_json,
          last_login_at,
          created_at,
          updated_at
        ) values (
          'identity-oidc',
          'user-oidc',
          'oidc-home',
          'https://id.example.test/application/o/omnifin/',
          'subject-oidc',
          '{"name":"Casey"}',
          1100,
          1000,
          1100
        );

        insert into service_identity_links (
          id,
          user_id,
          service,
          external_user_id,
          external_username,
          encrypted_access_token,
          health_state,
          last_verified_at,
          created_at,
          updated_at
        ) values
          (
            'link-alpha',
            'user-viewer',
            'jellyfin',
            'external-alpha',
            'riley',
            'legacy-token-alpha',
            'healthy',
            1100,
            1000,
            1100
          ),
          (
            'link-beta',
            'user-admin',
            'jellyfin',
            'external-beta',
            'morgan',
            'legacy-token-beta',
            'degraded',
            null,
            1000,
            1100
          );

        insert into sessions (
          id,
          token_hash,
          user_id,
          auth_method,
          oidc_provider_id,
          external_identity_id,
          oidc_session_id_hash,
          csrf_token_hash,
          last_seen_at,
          expires_at,
          absolute_expires_at,
          created_at
        ) values
          (
            'session-jellyfin',
            'legacy-jellyfin-token-hash',
            'user-viewer',
            'jellyfin',
            null,
            null,
            null,
            'legacy-jellyfin-csrf-hash',
            1100,
            2000,
            3000,
            1000
          ),
          (
            'session-recovery',
            'legacy-recovery-token-hash',
            'user-admin',
            'recovery',
            null,
            null,
            null,
            'legacy-recovery-csrf-hash',
            1100,
            2000,
            3000,
            1000
          ),
          (
            'session-oidc',
            'legacy-oidc-token-hash',
            'user-oidc',
            'oidc',
            'oidc-home',
            'identity-oidc',
            'legacy-oidc-session-hash',
            'legacy-oidc-csrf-hash',
            1100,
            2000,
            3000,
            1000
          ),
          (
            'session-jellyfin-unlinked',
            'legacy-unlinked-token-hash',
            'user-unlinked',
            'jellyfin',
            null,
            null,
            null,
            'legacy-unlinked-csrf-hash',
            1100,
            2000,
            3000,
            1000
          );

        insert into auth_transactions (
          id,
          state_hash,
          provider_id,
          encrypted_code_verifier,
          encrypted_nonce,
          return_path,
          expires_at,
          created_at
        ) values (
          'transaction-before-upgrade',
          'legacy-state-hash',
          'oidc-home',
          'legacy-verifier',
          'legacy-nonce',
          '/',
          2000,
          1000
        );

        insert into audit_events (
          id,
          actor_user_id,
          session_id,
          event_type,
          outcome,
          metadata_json,
          created_at
        ) values
          (
            'audit-before-upgrade',
            'user-admin',
            'session-jellyfin',
            'connector.updated',
            'success',
            '{}',
            1200
          ),
          (
            'audit-oidc',
            'user-oidc',
            'session-oidc',
            'auth.login',
            'success',
            '{}',
            1201
          ),
          (
            'audit-unlinked-jellyfin',
            'user-unlinked',
            'session-jellyfin-unlinked',
            'auth.login',
            'success',
            '{}',
            1202
          );
      `);

      applyMigration(database, "0001_auth_security_foundation.sql");
      database
        .prepare("update sessions set encrypted_id_token_hint = ? where id = 'session-oidc'")
        .run("");
      database.transaction(() => applyMigration(database, "0002_oidc_runtime_security.sql"))();

      expect(
        database
          .prepare(
            `select
              id,
              token_endpoint_auth_method as tokenEndpointAuthMethod,
              id_token_signing_alg as idTokenSigningAlg,
              approved_endpoint_origins_json as approvedEndpointOriginsJson,
              discovery_state as discoveryState,
              discovery_capabilities_json as discoveryCapabilitiesJson,
              discovery_checked_at as discoveryCheckedAt,
              encrypted_client_secret as encryptedClientSecret,
              enabled
            from oidc_providers
            order by id`,
          )
          .all(),
      ).toEqual([
        {
          approvedEndpointOriginsJson: "[]",
          discoveryCapabilitiesJson: "{}",
          discoveryCheckedAt: null,
          discoveryState: "unchecked",
          enabled: 0,
          encryptedClientSecret: "v1.fixture-client-secret",
          id: "oidc-confidential",
          idTokenSigningAlg: "RS256",
          tokenEndpointAuthMethod: "client_secret_basic",
        },
        {
          approvedEndpointOriginsJson: "[]",
          discoveryCapabilitiesJson: "{}",
          discoveryCheckedAt: null,
          discoveryState: "unchecked",
          enabled: 0,
          encryptedClientSecret: null,
          id: "oidc-home",
          idTokenSigningAlg: "RS256",
          tokenEndpointAuthMethod: "none",
        },
        {
          approvedEndpointOriginsJson: "[]",
          discoveryCapabilitiesJson: "{}",
          discoveryCheckedAt: null,
          discoveryState: "unchecked",
          enabled: 0,
          encryptedClientSecret: null,
          id: "oidc-invalid-secret",
          idTokenSigningAlg: "RS256",
          tokenEndpointAuthMethod: "none",
        },
      ]);
      expect(() =>
        database
          .prepare(
            "update oidc_providers set token_endpoint_auth_method = 'client_secret_post' where id = 'oidc-home'",
          )
          .run(),
      ).toThrow(/oidc_providers_client_secret_check/);
      expect(() =>
        database
          .prepare(
            "update oidc_providers set token_endpoint_auth_method = 'none' where id = 'oidc-confidential'",
          )
          .run(),
      ).toThrow(/oidc_providers_client_secret_check/);

      const links = database
        .prepare(
          `select
            id,
            user_id as userId,
            connector_id as connectorId,
            external_server_id as externalServerId,
            external_display_name as externalDisplayName,
            encrypted_access_token as encryptedAccessToken,
            health_state as healthState,
            device_id as deviceId,
            token_created_at as tokenCreatedAt,
            revoked_at as revokedAt,
            revision
          from service_identity_links
          order by id`,
        )
        .all() as {
        connectorId: string | null;
        deviceId: string;
        encryptedAccessToken: string | null;
        externalDisplayName: string;
        externalServerId: string;
        healthState: string;
        id: string;
        revision: number;
        revokedAt: number | null;
        tokenCreatedAt: number | null;
        userId: string;
      }[];

      expect(links).toHaveLength(2);
      expect(links.map(({ id, userId }) => ({ id, userId }))).toEqual([
        { id: "link-alpha", userId: "user-viewer" },
        { id: "link-beta", userId: "user-admin" },
      ]);
      expect(links.map(({ externalDisplayName }) => externalDisplayName)).toEqual([
        "riley",
        "morgan",
      ]);
      expect(
        links.every(
          ({
            connectorId,
            encryptedAccessToken,
            healthState,
            revision,
            revokedAt,
            tokenCreatedAt,
          }) =>
            connectorId === null &&
            encryptedAccessToken === null &&
            healthState === "relink_required" &&
            revision === 1 &&
            revokedAt === null &&
            tokenCreatedAt === null,
        ),
      ).toBe(true);
      expect(new Set(links.map(({ externalServerId }) => externalServerId)).size).toBe(2);
      expect(new Set(links.map(({ deviceId }) => deviceId)).size).toBe(2);
      expect(
        database.prepare("select id, role_source as roleSource from users order by id").all(),
      ).toEqual([
        { id: "user-admin", roleSource: "manual" },
        { id: "user-oidc", roleSource: "manual" },
        { id: "user-unlinked", roleSource: "manual" },
        { id: "user-viewer", roleSource: "manual" },
      ]);
      const migratedSessions = database
        .prepare(
          `select
            id,
            auth_method as authMethod,
            user_id as userId,
            oidc_provider_id as oidcProviderId,
            external_identity_id as externalIdentityId,
            oidc_session_id_hash as oidcSessionIdHash,
            service_identity_link_id as serviceIdentityLinkId,
          encrypted_csrf_token as encryptedCsrfToken,
            encrypted_id_token_hint as encryptedIdTokenHint,
            length(token_hash) as tokenHashLength,
            length(csrf_token_hash) as csrfHashLength,
            revoked_at as revokedAt
          from sessions
          order by id`,
        )
        .all() as {
        authMethod: string;
        csrfHashLength: number;
        encryptedCsrfToken: string;
        encryptedIdTokenHint: string | null;
        externalIdentityId: string | null;
        id: string;
        oidcProviderId: string | null;
        oidcSessionIdHash: string | null;
        revokedAt: number | null;
        serviceIdentityLinkId: string | null;
        tokenHashLength: number;
        userId: string | null;
      }[];
      expect(migratedSessions).toHaveLength(3);
      expect(migratedSessions).toEqual([
        expect.objectContaining({
          authMethod: "jellyfin",
          csrfHashLength: 43,
          encryptedCsrfToken: "legacy-revoked",
          id: "session-jellyfin",
          serviceIdentityLinkId: "link-alpha",
          tokenHashLength: 43,
          userId: "user-viewer",
        }),
        expect.objectContaining({
          authMethod: "oidc",
          csrfHashLength: 43,
          encryptedCsrfToken: "legacy-revoked",
          externalIdentityId: "identity-oidc",
          id: "session-oidc",
          encryptedIdTokenHint: null,
          oidcProviderId: "oidc-home",
          oidcSessionIdHash: null,
          serviceIdentityLinkId: null,
          tokenHashLength: 43,
          userId: "user-oidc",
        }),
        expect.objectContaining({
          authMethod: "recovery",
          csrfHashLength: 43,
          encryptedCsrfToken: "legacy-revoked",
          id: "session-recovery",
          serviceIdentityLinkId: null,
          tokenHashLength: 43,
          userId: null,
        }),
      ]);
      expect(migratedSessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
      expect(
        database
          .prepare(
            `select
              id,
              session_id as sessionId,
              actor_session_id as actorSessionId,
              actor_auth_method as actorAuthMethod
            from audit_events
            order by id`,
          )
          .all(),
      ).toEqual([
        {
          actorAuthMethod: "jellyfin",
          actorSessionId: "session-jellyfin",
          id: "audit-before-upgrade",
          sessionId: "session-jellyfin",
        },
        {
          actorAuthMethod: "oidc",
          actorSessionId: "session-oidc",
          id: "audit-oidc",
          sessionId: "session-oidc",
        },
        {
          actorAuthMethod: "jellyfin",
          actorSessionId: "session-jellyfin-unlinked",
          id: "audit-unlinked-jellyfin",
          sessionId: null,
        },
      ]);
      expect(
        database
          .prepare("select count(*) as count from sessions where id = ?")
          .get("session-jellyfin-unlinked"),
      ).toEqual({ count: 0 });
      expect(database.prepare("select count(*) as count from auth_transactions").get()).toEqual({
        count: 0,
      });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("authentication schema invariants", () => {
  it("loads the schema idempotently with connector-scoped links and logout replay receipts", () => {
    expect(authenticationSchema.connectorConfigs).toBeDefined();
    expect(authenticationSchema.auditBudgetEntries).toBeDefined();
    expect(authenticationSchema.auditBudgetScopes).toBeDefined();
    expect(authenticationSchema.oidcLogoutReceipts).toBeDefined();
    expect(authenticationSchema.mediaReferences).toBeDefined();
    expect(authenticationSchema.externalIssueReferences).toBeDefined();
    expect(authenticationSchema.mediaIssueOperations).toBeDefined();
    expect(authenticationSchema.playbackAssetHandles).toBeDefined();
    expect(authenticationSchema.playbackSessions).toBeDefined();
    expect(authenticationSchema.libraryArtworkSearches).toBeDefined();
    expect(authenticationSchema.libraryMutationOperations).toBeDefined();
    expect(authenticationSchema.libraryRemovalPreviews).toBeDefined();
    expect(authenticationSchema.userMediaStateOperations).toBeDefined();
    expect(authenticationSchema.subtitleDownloadOperations).toBeDefined();
    expect(authenticationSchema.subtitleSearches).toBeDefined();
    expect(authenticationSchema.sessionRotationAliases).toBeDefined();
    expect(authenticationSchema.sessionSecretReservations).toBeDefined();
    expect(authenticationSchema.serviceIdentityLinks).toBeDefined();

    const database = openDatabase(":memory:");
    try {
      database.migrate();
      database.migrate();
      const tables = database.sqlite
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all() as { name: string }[];
      const names = tables.map(({ name }) => name);
      expect(names).not.toContain("quick_connect_transactions");
      expect(names).not.toContain("logout_transactions");
      expect(names).toContain("audit_budget_entries");
      expect(names).toContain("audit_budget_scopes");
      expect(names).toContain("oidc_logout_receipts");
      expect(names).toContain("media_references");
      expect(names).toContain("external_issue_references");
      expect(names).toContain("media_issue_operations");
      expect(names).toContain("playback_asset_handles");
      expect(names).toContain("playback_sessions");
      expect(names).toContain("library_artwork_searches");
      expect(names).toContain("library_mutation_operations");
      expect(names).toContain("library_removal_previews");
      expect(names).toContain("user_media_state_operations");
      expect(names).toContain("download_queue_removal_operations");
      expect(names).toContain("download_queue_bulk_operations");
      expect(names).toContain("acquisition_queue_recovery_operations");
      expect(names).toContain("subtitle_download_operations");
      expect(names).toContain("subtitle_searches");
      expect(names).toContain("session_rotation_aliases");
      expect(names).toContain("session_secret_reservations");
      expect(
        database.sqlite.prepare("select count(*) as count from __drizzle_migrations").get(),
      ).toEqual({ count: expectedMigrationCount });
      expect(
        database.sqlite
          .prepare(
            `select name
             from sqlite_master
             where type = 'index'
               and name in (
                 'sessions_active_recovery_idx',
                 'sessions_recovery_created_idx',
                 'sessions_user_active_idx',
                 'sessions_user_created_idx'
               )
             order by name`,
          )
          .all(),
      ).toEqual([
        { name: "sessions_active_recovery_idx" },
        { name: "sessions_recovery_created_idx" },
        { name: "sessions_user_active_idx" },
        { name: "sessions_user_created_idx" },
      ]);
      const recoveryIssuancePlan = database.sqlite
        .prepare(
          `explain query plan
           select count(*)
           from (
             select 1
             from sessions
             where auth_method = 'recovery'
               and created_at > @windowCutoff
             limit 8
           )`,
        )
        .all({ windowCutoff: 0 }) as { detail: string }[];
      expect(recoveryIssuancePlan.map(({ detail }) => detail).join("\n")).toContain(
        "sessions_recovery_created_idx",
      );
      const activeRecoveryPlan = database.sqlite
        .prepare(
          `explain query plan
           update sessions
           set revoked_at = max(@now, created_at)
           where auth_method = 'recovery'
             and revoked_at is null
             and (@replacingSessionId is null or id <> @replacingSessionId)`,
        )
        .all({ now: 1, replacingSessionId: null }) as { detail: string }[];
      expect(activeRecoveryPlan.map(({ detail }) => detail).join("\n")).toContain(
        "sessions_active_recovery_idx",
      );
      expect(
        database.sqlite
          .prepare(
            `select name
            from sqlite_master
            where type = 'trigger'
              and name in (
                'oidc_providers_client_secret_insert_check',
                'oidc_providers_client_secret_update_check',
                'audit_budget_entries_current_generation_delete_protected',
                'audit_budget_entries_insert_current_generation',
                'audit_budget_entries_update_immutable',
                'audit_budget_scopes_delete_protected',
                'audit_budget_scopes_update_guarded',
                'session_rotation_aliases_update_immutable',
                'session_secret_reservations_delete_immutable',
                'session_secret_reservations_update_immutable',
                'sessions_rotation_aliases_revoke',
                'sessions_id_token_hint_insert_check',
                'sessions_id_token_hint_update_check',
                'sessions_secret_reservations_bearer_update',
                'sessions_secret_reservations_csrf_update',
                'sessions_secret_reservations_insert'
              )
            order by name`,
          )
          .all(),
      ).toEqual([
        { name: "audit_budget_entries_current_generation_delete_protected" },
        { name: "audit_budget_entries_insert_current_generation" },
        { name: "audit_budget_entries_update_immutable" },
        { name: "audit_budget_scopes_delete_protected" },
        { name: "audit_budget_scopes_update_guarded" },
        { name: "oidc_providers_client_secret_insert_check" },
        { name: "oidc_providers_client_secret_update_check" },
        { name: "session_rotation_aliases_update_immutable" },
        { name: "session_secret_reservations_delete_immutable" },
        { name: "session_secret_reservations_update_immutable" },
        { name: "sessions_id_token_hint_insert_check" },
        { name: "sessions_id_token_hint_update_check" },
        { name: "sessions_rotation_aliases_revoke" },
        { name: "sessions_secret_reservations_bearer_update" },
        { name: "sessions_secret_reservations_csrf_update" },
        { name: "sessions_secret_reservations_insert" },
      ]);

      database.sqlite.exec(`
        insert into users (id, display_name)
        values ('jit-default-user', 'New user')
      `);
      expect(
        database.sqlite
          .prepare("select role, role_source as roleSource, status from users where id = ?")
          .get("jit-default-user"),
      ).toEqual({ role: "viewer", roleSource: "default", status: "pending_link" });

      const serviceLinkForeignKeys = database.sqlite.pragma(
        "foreign_key_list(service_identity_links)",
      ) as {
        from: string;
        id: number;
        seq: number;
        table: string;
        to: string;
      }[];
      const connectorForeignKeyId = serviceLinkForeignKeys.find(
        ({ from, table }) => from === "connector_id" && table === "connector_configs",
      )?.id;
      expect(
        serviceLinkForeignKeys
          .filter(({ id }) => id === connectorForeignKeyId)
          .sort((left, right) => left.seq - right.seq)
          .map(({ from, table, to }) => ({ from, table, to })),
      ).toEqual([
        { from: "connector_id", table: "connector_configs", to: "id" },
        { from: "service", table: "connector_configs", to: "type" },
      ]);
      expect(
        (database.sqlite.pragma("index_list(connector_configs)") as { name: string }[]).map(
          ({ name }) => name,
        ),
      ).toContain("connector_configs_id_type_unique");

      const auditIndexes = database.sqlite.pragma("index_list(audit_events)") as {
        name: string;
      }[];
      expect(auditIndexes.map(({ name }) => name)).toContain("audit_events_request_idx");
      expect(auditIndexes.map(({ name }) => name)).toContain("audit_events_actor_session_idx");
      expect(
        (
          database.sqlite.pragma("index_info(audit_events_actor_session_idx)") as {
            name: string;
          }[]
        ).map(({ name }) => name),
      ).toEqual(["actor_session_id", "actor_auth_method"]);
      expect(() =>
        database.sqlite.exec(`
          insert into audit_events (id, event_type, outcome, request_id)
          values ('audit-empty-request', 'auth.login', 'success', '')
        `),
      ).toThrow(/audit_events_request_id_check/);
      expect(() =>
        database.sqlite.exec(`
          insert into audit_events (id, actor_session_id, event_type, outcome)
          values ('audit-unpaired-session', 'session-1', 'auth.login', 'success')
        `),
      ).toThrow(/audit_events_actor_session_check/);
      expect(() =>
        database.sqlite.exec(`
          insert into audit_events (id, actor_auth_method, event_type, outcome)
          values ('audit-unpaired-method', 'oidc', 'auth.login', 'success')
        `),
      ).toThrow(/audit_events_actor_session_check/);
      expect(() =>
        database.sqlite.exec(`
          insert into audit_events (
            id, actor_session_id, actor_auth_method, event_type, outcome
          ) values (
            'audit-invalid-method', 'session-1', 'password', 'auth.login', 'success'
          )
        `),
      ).toThrow(/audit_events_actor_session_check/);
      database.sqlite.exec(`
        insert into audit_events (
          id, actor_session_id, actor_auth_method, event_type, outcome
        ) values (
          'audit-snapshot', 'deleted-session', 'jellyfin', 'auth.logout', 'success'
        )
      `);
      database.sqlite.exec(`
        insert into sessions (
          id, token_hash, auth_method, csrf_token_hash, encrypted_csrf_token,
          created_at, last_rotated_at, last_seen_at, expires_at, absolute_expires_at
        ) values (
          'session-to-delete', '${"d".repeat(43)}', 'recovery', '${"e".repeat(43)}',
          'v1.fixture-csrf-token', 1000, 1000, 1000, 2000, 3000
        );
        insert into audit_events (
          id, session_id, actor_session_id, actor_auth_method, event_type, outcome
        ) values (
          'audit-retained-snapshot', 'session-to-delete', 'session-to-delete', 'recovery',
          'auth.logout', 'success'
        );
        delete from sessions where id = 'session-to-delete';
      `);
      expect(
        database.sqlite
          .prepare(
            `select
              session_id as sessionId,
              actor_session_id as actorSessionId,
              actor_auth_method as actorAuthMethod
            from audit_events
            where id = 'audit-retained-snapshot'`,
          )
          .get(),
      ).toEqual({
        actorAuthMethod: "recovery",
        actorSessionId: "session-to-delete",
        sessionId: null,
      });
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("makes audit budget generations monotonic and current entries persistent", () => {
    const database = openDatabase(":memory:");
    const scope = "auth.oidc.failure:v1";
    try {
      database.migrate();
      database.sqlite
        .prepare(
          `insert into audit_budget_scopes (
             scope, generation, window_started_at, clock_watermark_at,
             rollback_started_at, saturated, suppressed_count
           ) values (?, 1, 1000, 1000, null, 0, 0)`,
        )
        .run(scope);
      database.sqlite
        .prepare(
          `insert into audit_budget_entries (
             scope, generation, slot, bucket_hash, created_at
           ) values (?, 1, 0, ?, 1000)`,
        )
        .run(scope, "a".repeat(22));

      expect(() =>
        database.sqlite
          .prepare(
            `insert into audit_budget_entries (
               scope, generation, slot, bucket_hash, created_at
             ) values (?, 2, 0, ?, 1000)`,
          )
          .run(scope, "b".repeat(22)),
      ).toThrow(/audit_budget_entry_generation_is_not_current/);
      expect(() =>
        database.sqlite
          .prepare("update audit_budget_entries set created_at = 1001 where scope = ?")
          .run(scope),
      ).toThrow(/audit_budget_entry_is_immutable/);
      expect(() =>
        database.sqlite.prepare("delete from audit_budget_entries where scope = ?").run(scope),
      ).toThrow(/audit_budget_current_generation_is_persistent/);
      expect(() =>
        database.sqlite
          .prepare("update audit_budget_scopes set generation = 3 where scope = ?")
          .run(scope),
      ).toThrow(/audit_budget_scope_transition_is_invalid/);

      database.sqlite
        .prepare(
          `update audit_budget_scopes
           set generation = 2,
               window_started_at = 2000,
               clock_watermark_at = 2000,
               rollback_started_at = null,
               saturated = 0,
               suppressed_count = 0
           where scope = ?`,
        )
        .run(scope);
      expect(
        database.sqlite
          .prepare("delete from audit_budget_entries where scope = ? and generation = 1")
          .run(scope).changes,
      ).toBe(1);
      database.sqlite
        .prepare(
          `insert into audit_budget_entries (
             scope, generation, slot, bucket_hash, created_at
           ) values (?, 2, 0, ?, 2000)`,
        )
        .run(scope, "b".repeat(22));
      database.sqlite
        .prepare("update audit_budget_scopes set suppressed_count = 1 where scope = ?")
        .run(scope);
      expect(() =>
        database.sqlite
          .prepare("update audit_budget_scopes set suppressed_count = 0 where scope = ?")
          .run(scope),
      ).toThrow(/audit_budget_scope_transition_is_invalid/);
      database.sqlite
        .prepare("update audit_budget_scopes set saturated = 1 where scope = ?")
        .run(scope);
      expect(() =>
        database.sqlite
          .prepare("update audit_budget_scopes set saturated = 0 where scope = ?")
          .run(scope),
      ).toThrow(/audit_budget_scope_transition_is_invalid/);
      expect(() =>
        database.sqlite
          .prepare("update audit_budget_scopes set clock_watermark_at = 1999 where scope = ?")
          .run(scope),
      ).toThrow(/audit_budget_scope_transition_is_invalid/);
      expect(() =>
        database.sqlite.prepare("delete from audit_budget_scopes where scope = ?").run(scope),
      ).toThrow(/audit_budget_scope_is_persistent/);
      expect(() =>
        database.sqlite
          .prepare("update audit_budget_scopes set generation = 1 where scope = ?")
          .run(scope),
      ).toThrow(/audit_budget_scope_transition_is_invalid/);
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("durably reserves session secrets and maintains exact, capped rotation aliases", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      insertSession(database, {
        absoluteExpiresAt: 40_000,
        authMethod: "recovery",
        createdAt: 1_000,
        csrfTokenHash: "c".repeat(43),
        expiresAt: 30_000,
        id: "session-reserved",
        lastRotatedAt: 1_000,
        lastSeenAt: 1_000,
        serviceIdentityLinkId: null,
        tokenHash: "a".repeat(43),
        userId: null,
      });

      database.sqlite.exec(`
        update sessions
        set
          token_hash = '${"b".repeat(43)}',
          last_rotated_at = 5000,
          last_seen_at = 5000
        where id = 'session-reserved';

        update sessions
        set
          token_hash = '${"e".repeat(43)}',
          last_rotated_at = 25000,
          last_seen_at = 25000
        where id = 'session-reserved';

        update sessions
        set
          csrf_token_hash = '${"d".repeat(43)}',
          last_seen_at = 26000
        where id = 'session-reserved';
      `);

      expect(
        database.sqlite
          .prepare(
            `select
              token_hash as tokenHash,
              purpose,
              state,
              session_id as sessionId,
              valid_from as validFrom,
              expires_at as expiresAt
            from session_rotation_aliases
            order by valid_from`,
          )
          .all(),
      ).toEqual([
        {
          expiresAt: 15_000,
          purpose: "bearer",
          sessionId: "session-reserved",
          state: "rotation_grace",
          tokenHash: "a".repeat(43),
          validFrom: 5_000,
        },
        {
          expiresAt: 30_000,
          purpose: "bearer",
          sessionId: "session-reserved",
          state: "rotation_grace",
          tokenHash: "b".repeat(43),
          validFrom: 25_000,
        },
      ]);
      expect(
        database.sqlite
          .prepare(
            `select
              secret_hash as secretHash,
              purpose,
              origin_session_id as originSessionId,
              reserved_at as reservedAt
            from session_secret_reservations
            order by reserved_at, purpose, secret_hash`,
          )
          .all(),
      ).toEqual([
        {
          originSessionId: "session-reserved",
          purpose: "bearer",
          reservedAt: 1_000,
          secretHash: "a".repeat(43),
        },
        {
          originSessionId: "session-reserved",
          purpose: "csrf",
          reservedAt: 1_000,
          secretHash: "c".repeat(43),
        },
        {
          originSessionId: "session-reserved",
          purpose: "bearer",
          reservedAt: 5_000,
          secretHash: "b".repeat(43),
        },
        {
          originSessionId: "session-reserved",
          purpose: "bearer",
          reservedAt: 25_000,
          secretHash: "e".repeat(43),
        },
        {
          originSessionId: "session-reserved",
          purpose: "csrf",
          reservedAt: 26_000,
          secretHash: "d".repeat(43),
        },
      ]);

      expect(() =>
        database.sqlite
          .prepare(
            "update session_secret_reservations set reserved_at = 9999 where secret_hash = ?",
          )
          .run("a".repeat(43)),
      ).toThrow(/session_secret_reservations_immutable/);
      expect(() =>
        database.sqlite
          .prepare("delete from session_secret_reservations where secret_hash = ?")
          .run("a".repeat(43)),
      ).toThrow(/session_secret_reservations_immutable/);
      expect(() =>
        database.sqlite
          .prepare(
            "update session_rotation_aliases set expires_at = expires_at - 1 where token_hash = ?",
          )
          .run("a".repeat(43)),
      ).toThrow(/session_rotation_aliases_immutable/);

      database.sqlite.exec(`
        update sessions set revoked_at = 27000 where id = 'session-reserved';
      `);
      expect(
        database.sqlite.prepare("select count(*) as count from session_rotation_aliases").get(),
      ).toEqual({ count: 0 });

      database.sqlite.exec("delete from sessions where id = 'session-reserved'");
      expect(
        database.sqlite.prepare("select count(*) as count from session_secret_reservations").get(),
      ).toEqual({ count: 5 });
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("requires a direct Jellyfin session to identify the matching user's persistent link", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedUsersAndJellyfin(database);
      insertLinkedIdentity(database);

      insertSession(database);
      expect(
        database.sqlite
          .prepare(
            "select user_id as userId, service_identity_link_id as serviceIdentityLinkId from sessions",
          )
          .get(),
      ).toEqual({ serviceIdentityLinkId: "link-user-1", userId: "user-1" });

      expect(() =>
        insertSession(database, {
          csrfTokenHash: "n".repeat(43),
          id: "session-missing-link",
          serviceIdentityLinkId: null,
          tokenHash: "m".repeat(43),
        }),
      ).toThrow(/sessions_auth_attribution_check/);
      expect(() =>
        insertSession(database, {
          csrfTokenHash: "y".repeat(43),
          id: "session-mismatched-link",
          tokenHash: "x".repeat(43),
          userId: "user-2",
        }),
      ).toThrow(/foreign key/i);
      expect(() =>
        insertSession(database, {
          authMethod: "recovery",
          csrfTokenHash: "s".repeat(43),
          id: "session-attributed-recovery",
          serviceIdentityLinkId: null,
          tokenHash: "r".repeat(43),
          userId: "user-1",
        }),
      ).toThrow(/sessions_auth_attribution_check/);
    } finally {
      database.close();
    }
  });

  it("rejects malformed session hashes, missing CSRF ciphertext, and unsafe timestamp order", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedUsersAndJellyfin(database);
      insertLinkedIdentity(database);

      expect(() =>
        insertSession(database, { id: "session-short-hash", tokenHash: "short" }),
      ).toThrow(/sessions_token_hash_check/);
      expect(() =>
        insertSession(database, {
          encryptedCsrfToken: "",
          id: "session-empty-csrf-ciphertext",
          tokenHash: "e".repeat(43),
        }),
      ).toThrow(/sessions_csrf_hash_check/);
      expect(() =>
        insertSession(database, {
          expiresAt: 1900,
          id: "session-invalid-time-order",
          tokenHash: "o".repeat(43),
        }),
      ).toThrow(/sessions_timestamp_order_check/);
    } finally {
      database.close();
    }
  });

  it("scopes linked Jellyfin identities to one connector, server, and external user tuple", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedUsersAndJellyfin(database);
      insertLinkedIdentity(database);

      expect(() =>
        database.sqlite.exec(`
          insert into service_identity_links (
            id, user_id, service, connector_id, external_server_id, external_user_id,
            external_username, external_display_name, encrypted_access_token, device_id,
            token_created_at, health_state, created_at, updated_at
          ) values (
            'link-duplicate-external', 'user-2', 'jellyfin', 'jellyfin-home', 'server-home',
            'external-user-1', 'morgan', 'Morgan', 'v1.fixture-token', 'device-user-2', 1000,
            'linked', 1000, 1000
          )
        `),
      ).toThrow(/unique constraint/i);
      expect(() =>
        database.sqlite.exec(`
          insert into service_identity_links (
            id, user_id, service, connector_id, external_server_id, external_user_id,
            external_username, external_display_name, encrypted_access_token, device_id,
            token_created_at, health_state, created_at, updated_at
          ) values (
            'link-missing-connector', 'user-2', 'jellyfin', null, 'server-2',
            'external-user-2', 'morgan', 'Morgan', 'v1.fixture-token', 'device-user-2', 1000,
            'linked', 1000, 1000
          )
        `),
      ).toThrow(/service_identity_links_health_attribution_check/);
      expect(() =>
        database.sqlite.exec(`
          insert into service_identity_links (
            id, user_id, service, connector_id, external_server_id, external_user_id,
            external_username, external_display_name, encrypted_access_token, device_id,
            token_created_at, health_state, created_at, updated_at
          ) values (
            'link-wrong-connector-type', 'user-2', 'jellyfin', 'radarr-automation',
            'server-2', 'external-user-2', 'morgan', 'Morgan', 'v1.fixture-token',
            'device-user-2', 1000, 'linked', 1000, 1000
          )
        `),
      ).toThrow(/foreign key/i);

      database.sqlite.exec(`
        insert into service_identity_links (
          id, user_id, service, connector_id, external_server_id, external_user_id,
          external_username, external_display_name, encrypted_access_token, device_id,
          token_created_at, health_state, created_at, updated_at
        ) values (
          'link-user-2', 'user-2', 'jellyfin', 'jellyfin-home', 'server-home',
          'external-user-2', 'morgan', 'Morgan', 'v1.fixture-token', 'device-user-2', 1000,
          'linked', 1000, 1000
        )
      `);
      expect(() =>
        database.sqlite.exec(`
          insert into service_identity_links (
            id, user_id, service, connector_id, external_server_id, external_user_id,
            external_username, external_display_name, device_id, health_state, created_at, updated_at
          ) values (
            'link-user-2-again', 'user-2', 'jellyfin', null, 'legacy-server',
            'legacy-user', 'morgan', 'Morgan', 'legacy-device', 'relink_required', 1000, 1000
          )
        `),
      ).toThrow(/unique constraint/i);
    } finally {
      database.close();
    }
  });

  it("binds OIDC transactions to a browser and exact safe redirect context", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      database.sqlite.exec(`
        insert into oidc_providers (
          id, slug, display_name, issuer, client_id, created_at, updated_at
        ) values (
          'oidc-home', 'home', 'Home identity',
          'https://id.example.test/application/o/omnifin/', 'omnifin', 1000, 1000
        );
      `);
      const insertTransaction = (
        id: string,
        overrides: Partial<{
          browserBindingHash: string;
          consumedAt: number | null;
          expiresAt: number;
          redirectUri: string;
          returnPath: string;
          stateHash: string;
        }> = {},
      ) =>
        database.sqlite
          .prepare(
            `insert into auth_transactions (
              id, state_hash, provider_id, browser_binding_hash, encrypted_code_verifier,
              encrypted_nonce, redirect_uri, return_path, expires_at, consumed_at, created_at
            ) values (
              @id, @stateHash, 'oidc-home', @browserBindingHash, 'v1.fixture-verifier',
              'v1.fixture-nonce', @redirectUri, @returnPath, @expiresAt, @consumedAt, 1000
            )`,
          )
          .run({
            browserBindingHash: "b".repeat(43),
            consumedAt: null,
            expiresAt: 2000,
            id,
            redirectUri: "https://omnifin.example.test/api/v1/auth/oidc/callback",
            returnPath: "/library",
            stateHash: id.at(-1)?.repeat(43) ?? "s".repeat(43),
            ...overrides,
          });

      insertTransaction("transaction-1", { stateHash: "s".repeat(43) });
      expect(() => insertTransaction("transaction-2", { browserBindingHash: "short" })).toThrow(
        /auth_transactions_hashes_check/,
      );
      expect(() =>
        insertTransaction("transaction-3", {
          redirectUri: "https://omnifin.example.test/callback#fragment",
        }),
      ).toThrow(/auth_transactions_redirect_uri_check/);
      expect(() =>
        insertTransaction("transaction-4", { returnPath: "//attacker.example.test" }),
      ).toThrow(/auth_transactions_return_path_check/);
      expect(() => insertTransaction("transaction-5", { consumedAt: 2001 })).toThrow(
        /auth_transactions_timestamp_order_check/,
      );
    } finally {
      database.close();
    }
  });
});
