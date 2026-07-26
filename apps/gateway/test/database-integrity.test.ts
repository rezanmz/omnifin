import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";

function openSeededDatabase(): DatabaseHandle {
  const database = openDatabase(":memory:");
  database.migrate();
  database.sqlite.exec(`
    insert into users (id, display_name, role, status)
    values ('user-1', 'Riley', 'viewer', 'active');

    insert into oidc_providers (
      id,
      slug,
      display_name,
      issuer,
      client_id,
      claim_config_json,
      allow_jit_provisioning,
      enabled
    ) values (
      'oidc-home',
      'home',
      'Home identity',
      'https://id.example.test/application/o/omnifin/',
      'omnifin',
      '{}',
      1,
      1
    );
  `);
  return database;
}

function insertRecoverySession(
  database: DatabaseHandle,
  input: { csrfTokenHash: string; id: string; tokenHash: string },
) {
  database.sqlite
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
        1000,
        1000,
        1000,
        30000,
        40000
      )`,
    )
    .run(input);
}

const enumConstraintCases = [
  {
    constraint: "users_role_source_check",
    name: "user role sources",
    statement:
      "insert into users (id, display_name, role, role_source, status) values ('invalid-user-role-source', 'Invalid', 'viewer', 'saml', 'active')",
  },
  {
    constraint: "users_role_check",
    name: "user roles",
    statement:
      "insert into users (id, display_name, role, status) values ('invalid-user-role', 'Invalid', 'owner', 'active')",
  },
  {
    constraint: "users_status_check",
    name: "user statuses",
    statement:
      "insert into users (id, display_name, role, status) values ('invalid-user-status', 'Invalid', 'viewer', 'invited')",
  },
  {
    constraint: "oidc_providers_token_endpoint_auth_method_check",
    name: "OIDC token endpoint authentication methods",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, token_endpoint_auth_method) values ('invalid-token-auth', 'invalid-token-auth', 'Invalid', 'https://invalid-token-auth.example.test', 'omnifin', 'private_key_jwt')",
  },
  {
    constraint: "oidc_providers_id_token_signing_alg_check",
    name: "OIDC ID-token signing algorithms",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, id_token_signing_alg) values ('invalid-id-alg', 'invalid-id-alg', 'Invalid', 'https://invalid-id-alg.example.test', 'omnifin', 'none')",
  },
  {
    constraint: "oidc_providers_discovery_state_check",
    name: "OIDC discovery states",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, discovery_state) values ('invalid-discovery-state', 'invalid-discovery-state', 'Invalid', 'https://invalid-discovery-state.example.test', 'omnifin', 'trusted')",
  },
  {
    constraint: "role_mappings_operator_check",
    name: "role-mapping operators",
    statement:
      "insert into role_mappings (id, provider_id, claim_path_json, operator, values_json, role) values ('invalid-mapping-operator', 'oidc-home', '[\"groups\"]', 'starts_with', '[\"ops\"]', 'operator')",
  },
  {
    constraint: "role_mappings_role_check",
    name: "role-mapping target roles",
    statement:
      "insert into role_mappings (id, provider_id, claim_path_json, operator, values_json, role) values ('invalid-mapping-role', 'oidc-home', '[\"groups\"]', 'equals', '[\"ops\"]', 'owner')",
  },
  {
    constraint: "service_identity_links_service_check",
    name: "linked services",
    statement:
      "insert into service_identity_links (id, user_id, service, external_server_id, external_user_id, external_username, external_display_name, device_id, health_state) values ('invalid-service', 'user-1', 'plex', 'server-1', 'external-1', 'riley', 'Riley', 'device-1', 'relink_required')",
  },
  {
    constraint: "service_identity_links_health_state_check",
    name: "service-link health states",
    statement:
      "insert into service_identity_links (id, user_id, service, external_server_id, external_user_id, external_username, external_display_name, device_id, health_state) values ('invalid-link-health', 'user-1', 'jellyfin', 'server-1', 'external-1', 'riley', 'Riley', 'device-1', 'unknown')",
  },
  {
    constraint: "sessions_auth_method_check",
    name: "session authentication methods",
    statement: `insert into sessions (id, token_hash, auth_method, csrf_token_hash, encrypted_csrf_token, created_at, last_rotated_at, last_seen_at, expires_at, absolute_expires_at) values ('invalid-auth-method', '${"t".repeat(43)}', 'password', '${"c".repeat(43)}', 'encrypted', 1, 1, 1, 2, 3)`,
  },
  {
    constraint: "session_secret_reservations_purpose_check",
    name: "session secret reservation purposes",
    statement: `insert into session_secret_reservations (secret_hash, purpose, origin_session_id, reserved_at) values ('${"r".repeat(43)}', 'password', 'session-1', 1)`,
  },
  {
    constraint: "session_rotation_aliases_purpose_check",
    name: "session rotation alias purposes",
    statement: `insert into session_rotation_aliases (token_hash, purpose, state, session_id, valid_from, expires_at) values ('${"a".repeat(43)}', 'csrf', 'rotation_grace', 'session-1', 1, 2)`,
  },
  {
    constraint: "session_rotation_aliases_state_check",
    name: "session rotation alias states",
    statement: `insert into session_rotation_aliases (token_hash, purpose, state, session_id, valid_from, expires_at) values ('${"a".repeat(43)}', 'bearer', 'active', 'session-1', 1, 2)`,
  },
  {
    constraint: "connector_configs_type_check",
    name: "connector types",
    statement:
      "insert into connector_configs (id, type, display_name, base_url, encrypted_credentials) values ('invalid-connector-type', 'transmission', 'Invalid', 'https://service.example.test', 'encrypted')",
  },
  {
    constraint: "connector_configs_tls_policy_check",
    name: "connector TLS policies",
    statement:
      "insert into connector_configs (id, type, display_name, base_url, encrypted_credentials, tls_policy) values ('invalid-tls-policy', 'jellyfin', 'Invalid', 'https://service.example.test', 'encrypted', 'insecure')",
  },
  {
    constraint: "connector_configs_health_state_check",
    name: "connector health states",
    statement:
      "insert into connector_configs (id, type, display_name, base_url, encrypted_credentials, health_state) values ('invalid-connector-health', 'jellyfin', 'Invalid', 'https://service.example.test', 'encrypted', 'unreachable')",
  },
  {
    constraint: "audit_events_outcome_check",
    name: "audit outcomes",
    statement:
      "insert into audit_events (id, event_type, outcome) values ('invalid-audit-outcome', 'auth.login', 'unknown')",
  },
] as const;

const jsonConstraintCases = [
  {
    constraint: "oidc_providers_claim_config_json_check",
    name: "OIDC claim configuration",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, claim_config_json) values ('invalid-oidc-json', 'invalid-json', 'Invalid', 'https://invalid-json.example.test', 'omnifin', '{broken')",
  },
  {
    constraint: "oidc_providers_approved_endpoint_origins_json_check",
    name: "OIDC approved endpoint origins",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, approved_endpoint_origins_json) values ('invalid-origin-json', 'invalid-origin-json', 'Invalid', 'https://invalid-origin-json.example.test', 'omnifin', '{broken')",
  },
  {
    constraint: "oidc_providers_discovery_capabilities_json_check",
    name: "OIDC discovery capabilities",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, discovery_capabilities_json) values ('invalid-discovery-json', 'invalid-discovery-json', 'Invalid', 'https://invalid-discovery-json.example.test', 'omnifin', '[]')",
  },
  {
    constraint: "external_identities_display_claims_json_check",
    name: "external identity display claims",
    statement:
      "insert into external_identities (id, user_id, provider_id, issuer, subject, display_claims_json, last_login_at) values ('invalid-display-claims', 'user-1', 'oidc-home', 'https://id.example.test/application/o/omnifin/', 'invalid-json', '{broken', 1)",
  },
  {
    constraint: "role_mappings_claim_path_json_check",
    name: "role-mapping claim paths",
    statement:
      "insert into role_mappings (id, provider_id, claim_path_json, operator, values_json, role) values ('invalid-claim-path', 'oidc-home', '{broken', 'equals', '[\"ops\"]', 'operator')",
  },
  {
    constraint: "role_mappings_values_json_check",
    name: "role-mapping values",
    statement:
      "insert into role_mappings (id, provider_id, claim_path_json, operator, values_json, role) values ('invalid-values', 'oidc-home', '[\"groups\"]', 'equals', '{broken', 'operator')",
  },
  {
    constraint: "connector_configs_capability_snapshot_json_check",
    name: "connector capability snapshots",
    statement:
      "insert into connector_configs (id, type, display_name, base_url, encrypted_credentials, capability_snapshot_json) values ('invalid-capabilities', 'jellyfin', 'Invalid', 'https://service.example.test', 'encrypted', '{broken')",
  },
  {
    constraint: "audit_events_metadata_json_check",
    name: "audit metadata",
    statement:
      "insert into audit_events (id, event_type, outcome, metadata_json) values ('invalid-audit-json', 'auth.login', 'success', '{broken')",
  },
  {
    constraint: "operational_failures_context_json_check",
    name: "operational failure context",
    statement:
      "insert into operational_failures (id, component, operation, category, safe_message, context_json, first_seen_at, last_seen_at) values ('invalid-context', 'gateway', 'startup', 'configuration', 'Startup failed.', '{broken', 1, 1)",
  },
] as const;

const booleanConstraintCases = [
  {
    constraint: "oidc_providers_allow_jit_provisioning_check",
    name: "OIDC JIT provisioning flags",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, allow_jit_provisioning) values ('invalid-jit', 'invalid-jit', 'Invalid', 'https://invalid-jit.example.test', 'omnifin', 2)",
  },
  {
    constraint: "oidc_providers_enabled_check",
    name: "OIDC enabled flags",
    statement:
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, enabled) values ('invalid-oidc-enabled', 'invalid-enabled', 'Invalid', 'https://invalid-enabled.example.test', 'omnifin', -1)",
  },
  {
    constraint: "role_mappings_enabled_check",
    name: "role-mapping enabled flags",
    statement:
      "insert into role_mappings (id, provider_id, claim_path_json, operator, values_json, role, enabled) values ('invalid-mapping-enabled', 'oidc-home', '[\"groups\"]', 'equals', '[\"ops\"]', 'operator', 9)",
  },
  {
    constraint: "connector_configs_insecure_http_approved_check",
    name: "insecure HTTP approval flags",
    statement:
      "insert into connector_configs (id, type, display_name, base_url, encrypted_credentials, insecure_http_approved) values ('invalid-http-approved', 'jellyfin', 'Invalid', 'https://service.example.test', 'encrypted', 2)",
  },
  {
    constraint: "connector_configs_enabled_check",
    name: "connector enabled flags",
    statement:
      "insert into connector_configs (id, type, display_name, base_url, encrypted_credentials, enabled) values ('invalid-connector-enabled', 'jellyfin', 'Invalid', 'https://service.example.test', 'encrypted', -1)",
  },
] as const;

function expectConstraintFailure(statement: string, constraint: string) {
  const database = openSeededDatabase();
  try {
    expect(() => database.sqlite.exec(statement)).toThrow(new RegExp(constraint));
  } finally {
    database.close();
  }
}

describe("database integrity constraints", () => {
  it.each(enumConstraintCases)("rejects invalid $name", ({ constraint, statement }) => {
    expectConstraintFailure(statement, constraint);
  });

  it.each(jsonConstraintCases)("rejects malformed $name JSON", ({ constraint, statement }) => {
    expectConstraintFailure(statement, constraint);
  });

  it.each(booleanConstraintCases)("rejects non-boolean $name", ({ constraint, statement }) => {
    expectConstraintFailure(statement, constraint);
  });

  it("requires object-shaped JSON for object-bearing records", () => {
    expectConstraintFailure(
      "insert into audit_events (id, event_type, outcome, metadata_json) values ('invalid-audit-shape', 'auth.login', 'success', '[]')",
      "audit_events_metadata_json_check",
    );
  });

  it("rejects malformed reservation hashes and unsafe alias lifetimes", () => {
    expectConstraintFailure(
      "insert into session_secret_reservations (secret_hash, purpose, origin_session_id, reserved_at) values ('short', 'bearer', 'session-1', 1)",
      "session_secret_reservations_secret_hash_check",
    );
    expectConstraintFailure(
      `insert into session_secret_reservations (secret_hash, purpose, origin_session_id, reserved_at) values ('${"r".repeat(43)}', 'csrf', 'session-1', -1)`,
      "session_secret_reservations_reserved_at_check",
    );
    expectConstraintFailure(
      `insert into session_secret_reservations (secret_hash, purpose, origin_session_id, reserved_at) values ('${"s".repeat(43)}', 'csrf', 'unsafe/session', 1)`,
      "session_secret_reservations_origin_session_id_check",
    );
    expectConstraintFailure(
      `insert into session_secret_reservations (secret_hash, purpose, origin_session_id, reserved_at) values ('${"t".repeat(43)}', 'csrf', '${"s".repeat(129)}', 1)`,
      "session_secret_reservations_origin_session_id_check",
    );
    expectConstraintFailure(
      "insert into session_rotation_aliases (token_hash, session_id, valid_from, expires_at) values ('short', 'session-1', 1, 2)",
      "session_rotation_aliases_token_hash_check",
    );
    expectConstraintFailure(
      `insert into session_rotation_aliases (token_hash, session_id, valid_from, expires_at) values ('${"a".repeat(43)}', 'session-1', 1, 1)`,
      "session_rotation_aliases_timestamp_order_check",
    );
    expectConstraintFailure(
      `insert into session_rotation_aliases (token_hash, session_id, valid_from, expires_at) values ('${"a".repeat(43)}', 'session-1', 1, 10002)`,
      "session_rotation_aliases_timestamp_order_check",
    );
  });

  it("binds every rotation alias to a bearer reservation from the same session", () => {
    const database = openSeededDatabase();
    try {
      insertRecoverySession(database, {
        csrfTokenHash: "c".repeat(43),
        id: "session-one",
        tokenHash: "a".repeat(43),
      });
      insertRecoverySession(database, {
        csrfTokenHash: "d".repeat(43),
        id: "session-two",
        tokenHash: "b".repeat(43),
      });

      expect(() =>
        database.sqlite
          .prepare(
            `insert into session_rotation_aliases (
              token_hash, session_id, valid_from, expires_at
            ) values (?, 'session-two', 2000, 3000)`,
          )
          .run("a".repeat(43)),
      ).toThrow(/foreign key/i);
      expect(() =>
        database.sqlite
          .prepare(
            `insert into session_rotation_aliases (
              token_hash, session_id, valid_from, expires_at
            ) values (?, 'session-one', 2000, 3000)`,
          )
          .run("c".repeat(43)),
      ).toThrow(/foreign key/i);
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls session writes back with one exact reservation collision error", () => {
    const database = openSeededDatabase();
    try {
      insertRecoverySession(database, {
        csrfTokenHash: "c".repeat(43),
        id: "session-one",
        tokenHash: "a".repeat(43),
      });
      database.sqlite.exec(`
        insert into session_secret_reservations (
          secret_hash, purpose, origin_session_id, reserved_at
        ) values
          ('${"x".repeat(43)}', 'csrf', 'retired-session', 0),
          ('${"y".repeat(43)}', 'bearer', 'retired-session', 0),
          ('${"z".repeat(43)}', 'csrf', 'retired-session', 0);
      `);

      expect(() =>
        insertRecoverySession(database, {
          csrfTokenHash: "z".repeat(43),
          id: "session-two",
          tokenHash: "b".repeat(43),
        }),
      ).toThrow(/^session_secret_reservation_collision$/);
      expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
        count: 1,
      });
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from session_secret_reservations where secret_hash = ?",
          )
          .get("b".repeat(43)),
      ).toEqual({ count: 0 });

      expect(() =>
        database.sqlite
          .prepare(
            `update sessions
            set token_hash = ?, last_rotated_at = 2000, last_seen_at = 2000
            where id = 'session-one'`,
          )
          .run("x".repeat(43)),
      ).toThrow(/^session_secret_reservation_collision$/);
      expect(() =>
        database.sqlite
          .prepare("update sessions set csrf_token_hash = ? where id = 'session-one'")
          .run("y".repeat(43)),
      ).toThrow(/^session_secret_reservation_collision$/);

      expect(
        database.sqlite
          .prepare(
            `select token_hash as tokenHash, csrf_token_hash as csrfTokenHash
            from sessions where id = 'session-one'`,
          )
          .get(),
      ).toEqual({ csrfTokenHash: "c".repeat(43), tokenHash: "a".repeat(43) });
      expect(
        database.sqlite.prepare("select count(*) as count from session_rotation_aliases").get(),
      ).toEqual({ count: 0 });
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("binds OIDC client secrets to the configured token endpoint authentication method", () => {
    expectConstraintFailure(
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, encrypted_client_secret) values ('public-with-secret', 'public-with-secret', 'Invalid', 'https://public-with-secret.example.test', 'omnifin', 'encrypted')",
      "oidc_providers_client_secret_check",
    );
    expectConstraintFailure(
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, token_endpoint_auth_method) values ('confidential-without-secret', 'confidential-without-secret', 'Invalid', 'https://confidential-without-secret.example.test', 'omnifin', 'client_secret_basic')",
      "oidc_providers_client_secret_check",
    );
    expectConstraintFailure(
      "insert into oidc_providers (id, slug, display_name, issuer, client_id, token_endpoint_auth_method, encrypted_client_secret) values ('empty-secret', 'empty-secret', 'Invalid', 'https://empty-secret.example.test', 'omnifin', 'client_secret_post', '')",
      "oidc_providers_client_secret_check",
    );

    const database = openSeededDatabase();
    try {
      expect(() =>
        database.sqlite
          .prepare(
            "update oidc_providers set token_endpoint_auth_method = 'client_secret_basic' where id = 'oidc-home'",
          )
          .run(),
      ).toThrow(/oidc_providers_client_secret_check/);
      expect(() =>
        database.sqlite
          .prepare(
            "update oidc_providers set token_endpoint_auth_method = 'client_secret_post', encrypted_client_secret = ? where id = 'oidc-home'",
          )
          .run("x".repeat(8193)),
      ).toThrow(/oidc_providers_client_secret_check/);
      database.sqlite
        .prepare(
          "update oidc_providers set token_endpoint_auth_method = 'client_secret_post', encrypted_client_secret = ? where id = 'oidc-home'",
        )
        .run("v2.fixture-client-secret");
      expect(
        database.sqlite
          .prepare(
            "select token_endpoint_auth_method as method, encrypted_client_secret as secret from oidc_providers where id = 'oidc-home'",
          )
          .get(),
      ).toEqual({ method: "client_secret_post", secret: "v2.fixture-client-secret" });
    } finally {
      database.close();
    }
  });

  it("requires checked, bounded discovery data before a provider can be marked ready", () => {
    const oversizedCapabilities = JSON.stringify({ value: "x".repeat(8192) });
    const tooManyOrigins = JSON.stringify(
      Array.from({ length: 17 }, (_, index) => `https://id-${index}.example.test`),
    );
    const database = openSeededDatabase();
    try {
      expect(() =>
        database.sqlite
          .prepare(
            "update oidc_providers set discovery_capabilities_json = ? where id = 'oidc-home'",
          )
          .run(oversizedCapabilities),
      ).toThrow(/oidc_providers_discovery_capabilities_json_check/);
      expect(() =>
        database.sqlite
          .prepare(
            "update oidc_providers set approved_endpoint_origins_json = ? where id = 'oidc-home'",
          )
          .run(tooManyOrigins),
      ).toThrow(/oidc_providers_approved_endpoint_origins_json_check/);
      expect(() =>
        database.sqlite
          .prepare("update oidc_providers set discovery_state = 'ready' where id = 'oidc-home'")
          .run(),
      ).toThrow(/oidc_providers_discovery_attribution_check/);
      expect(() =>
        database.sqlite
          .prepare(
            "update oidc_providers set discovery_capabilities_json = '{\"frontChannelLogout\":true}' where id = 'oidc-home'",
          )
          .run(),
      ).toThrow(/oidc_providers_discovery_attribution_check/);

      database.sqlite.exec(`
        update oidc_providers
        set
          approved_endpoint_origins_json = '["https://id.example.test"]',
          discovery_capabilities_json = '{"frontChannelLogout":true}',
          discovery_checked_at = created_at,
          discovery_state = 'ready'
        where id = 'oidc-home'
      `);
      expect(
        database.sqlite
          .prepare(
            "select discovery_state as state, discovery_checked_at as checkedAt from oidc_providers where id = 'oidc-home'",
          )
          .get(),
      ).toMatchObject({ state: "ready" });
    } finally {
      database.close();
    }
  });

  it("scopes hashed logout-token JTIs to a provider and rejects unsafe receipt timestamps", () => {
    const database = openSeededDatabase();
    const jtiHash = "j".repeat(43);
    try {
      database.sqlite.exec(`
        insert into oidc_providers (id, slug, display_name, issuer, client_id)
        values ('oidc-work', 'work', 'Work identity', 'https://work-id.example.test', 'omnifin');
      `);
      const insertReceipt = (
        providerId: string,
        hash: string,
        issuedAt = 1000,
        receivedAt = 1100,
        expiresAt = 2000,
      ) =>
        database.sqlite
          .prepare(
            `insert into oidc_logout_receipts (
              provider_id, jti_hash, issued_at, received_at, expires_at
            ) values (?, ?, ?, ?, ?)`,
          )
          .run(providerId, hash, issuedAt, receivedAt, expiresAt);

      insertReceipt("oidc-home", jtiHash);
      expect(() => insertReceipt("oidc-home", jtiHash)).toThrow(/unique constraint/i);
      expect(() => insertReceipt("oidc-work", "short")).toThrow(
        /oidc_logout_receipts_jti_hash_check/,
      );
      expect(() => insertReceipt("oidc-work", "f".repeat(43), 301_101, 1100)).toThrow(
        /oidc_logout_receipts_timestamp_order_check/,
      );
      expect(() => insertReceipt("oidc-work", "a".repeat(43), 1, 301_002, 400_000)).toThrow(
        /oidc_logout_receipts_timestamp_order_check/,
      );
      expect(() => insertReceipt("oidc-work", "e".repeat(43), 1000, 1100, 1100)).toThrow(
        /oidc_logout_receipts_timestamp_order_check/,
      );
      insertReceipt("oidc-work", jtiHash);
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 2 });

      database.sqlite.exec("delete from oidc_providers where id = 'oidc-work'");
      expect(
        database.sqlite.prepare("select count(*) as count from oidc_logout_receipts").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("accepts valid constrained values and preserves intentional nullability", () => {
    const database = openSeededDatabase();
    try {
      database.sqlite.exec(`
        insert into external_identities (
          id,
          user_id,
          provider_id,
          issuer,
          subject,
          display_claims_json,
          last_login_at
        ) values (
          'identity-1',
          'user-1',
          'oidc-home',
          'https://id.example.test/application/o/omnifin/',
          'subject-1',
          '{"name":"Riley"}',
          1
        );

        insert into role_mappings (
          id,
          provider_id,
          claim_path_json,
          operator,
          values_json,
          role,
          enabled
        ) values (
          'operators',
          'oidc-home',
          '["groups"]',
          'contains_any',
          '["media-operators"]',
          'operator',
          1
        );

        insert into connector_configs (
          id,
          type,
          display_name,
          base_url,
          encrypted_credentials,
          tls_policy,
          insecure_http_approved,
          capability_snapshot_json,
          health_state,
          enabled
        ) values (
          'jellyfin',
          'jellyfin',
          'Jellyfin',
          'https://jellyfin.example.test',
          'encrypted',
          'strict',
          0,
          '{"version":"10.11.0"}',
          'healthy',
          1
        );

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
          last_verified_at,
          created_at,
          updated_at
        ) values (
          'jellyfin-link',
          'user-1',
          'jellyfin',
          'jellyfin',
          'jellyfin-server-1',
          'jellyfin-user-1',
          'riley',
          'Riley',
          'encrypted',
          'device-1',
          1,
          'linked',
          null,
          1,
          1
        );

        insert into sessions (
          id,
          token_hash,
          user_id,
          auth_method,
          csrf_token_hash,
          encrypted_csrf_token,
          created_at,
          last_rotated_at,
          last_seen_at,
          expires_at,
          absolute_expires_at
        ) values (
          'recovery-session',
          '${"r".repeat(43)}',
          null,
          'recovery',
          '${"c".repeat(43)}',
          'encrypted',
          1,
          1,
          1,
          2,
          3
        );

        insert into audit_events (
          id,
          actor_user_id,
          session_id,
          event_type,
          outcome,
          target_type,
          target_id,
          metadata_json
        ) values (
          'audit-1',
          null,
          null,
          'recovery.login',
          'success',
          null,
          null,
          '{"method":"recovery"}'
        );

        insert into operational_failures (
          id,
          component,
          operation,
          category,
          safe_message,
          context_json,
          first_seen_at,
          last_seen_at,
          resolved_at
        ) values (
          'failure-1',
          'gateway',
          'connector.health',
          'upstream',
          'The connector was unavailable.',
          '{"connectorId":"jellyfin"}',
          1,
          2,
          null
        );
      `);

      expect(
        database.sqlite
          .prepare(
            `select
              (select count(*) from external_identities) +
              (select count(*) from role_mappings) +
              (select count(*) from service_identity_links) +
              (select count(*) from sessions) +
              (select count(*) from connector_configs) +
              (select count(*) from audit_events) +
              (select count(*) from operational_failures) as constrained_rows`,
          )
          .get(),
      ).toEqual({ constrained_rows: 7 });
    } finally {
      database.close();
    }
  });
});
