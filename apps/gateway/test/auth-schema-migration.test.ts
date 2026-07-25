import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import * as authenticationSchema from "../src/db/schema.js";

const migrationDirectory = path.resolve(import.meta.dirname, "../drizzle");

function applyMigration(database: Database.Database, filename: string) {
  const migration = readFileSync(path.join(migrationDirectory, filename), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) database.exec(statement);
  }
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
          created_at,
          updated_at
        ) values (
          'oidc-home',
          'home',
          'Home identity',
          'https://id.example.test/application/o/omnifin/',
          'omnifin',
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
  it("loads the schema with connector-scoped links and no premature flow tables", () => {
    expect(authenticationSchema.connectorConfigs).toBeDefined();
    expect(authenticationSchema.serviceIdentityLinks).toBeDefined();

    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const tables = database.sqlite
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all() as { name: string }[];
      const names = tables.map(({ name }) => name);
      expect(names).not.toContain("quick_connect_transactions");
      expect(names).not.toContain("logout_transactions");

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
          id: "session-missing-link",
          serviceIdentityLinkId: null,
          tokenHash: "m".repeat(43),
        }),
      ).toThrow(/sessions_auth_attribution_check/);
      expect(() =>
        insertSession(database, {
          id: "session-mismatched-link",
          tokenHash: "x".repeat(43),
          userId: "user-2",
        }),
      ).toThrow(/foreign key/i);
      expect(() =>
        insertSession(database, {
          authMethod: "recovery",
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
