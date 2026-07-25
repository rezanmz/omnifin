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

const enumConstraintCases = [
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
      "insert into service_identity_links (id, user_id, service, external_user_id, external_username, encrypted_access_token, health_state) values ('invalid-service', 'user-1', 'plex', 'external-1', 'riley', 'encrypted', 'healthy')",
  },
  {
    constraint: "service_identity_links_health_state_check",
    name: "service-link health states",
    statement:
      "insert into service_identity_links (id, user_id, service, external_user_id, external_username, encrypted_access_token, health_state) values ('invalid-link-health', 'user-1', 'jellyfin', 'external-1', 'riley', 'encrypted', 'unknown')",
  },
  {
    constraint: "sessions_auth_method_check",
    name: "session authentication methods",
    statement:
      "insert into sessions (id, token_hash, auth_method, csrf_token_hash, last_seen_at, expires_at, absolute_expires_at) values ('invalid-auth-method', 'token-hash', 'password', 'csrf-hash', 1, 2, 3)",
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

        insert into service_identity_links (
          id,
          user_id,
          service,
          external_user_id,
          external_username,
          encrypted_access_token,
          health_state,
          last_verified_at
        ) values (
          'jellyfin-link',
          'user-1',
          'jellyfin',
          'jellyfin-user-1',
          'riley',
          'encrypted',
          'healthy',
          null
        );

        insert into sessions (
          id,
          token_hash,
          user_id,
          auth_method,
          csrf_token_hash,
          last_seen_at,
          expires_at,
          absolute_expires_at
        ) values (
          'recovery-session',
          'recovery-token-hash',
          null,
          'recovery',
          'csrf-hash',
          1,
          2,
          3
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
