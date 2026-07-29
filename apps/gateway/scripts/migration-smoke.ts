import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate as migrateWithDrizzle } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "omnifin-migration-"));
const freshDatabasePath = path.join(temporaryDirectory, "fresh.db");
const upgradeDatabasePath = path.join(temporaryDirectory, "upgrade.db");
const collisionDatabasePath = path.join(temporaryDirectory, "collision.db");
const currentMigrationDirectory = path.resolve(import.meta.dirname, "../drizzle");
const historicalMigrationDirectory = path.join(temporaryDirectory, "migrations-through-0002");
const requiredTables = [
  "acquisition_grab_operations",
  "acquisition_search_operations",
  "audit_budget_entries",
  "audit_budget_scopes",
  "audit_events",
  "auth_transactions",
  "connector_configs",
  "download_queue_removal_operations",
  "external_issue_references",
  "external_identities",
  "jellyfin_quick_connect_transactions",
  "library_artwork_searches",
  "library_mutation_operations",
  "media_issues",
  "media_issue_operations",
  "media_references",
  "media_request_operations",
  "oidc_logout_receipts",
  "oidc_providers",
  "operational_failures",
  "playback_sessions",
  "role_mappings",
  "service_identity_links",
  "session_rotation_aliases",
  "session_secret_reservations",
  "sessions",
  "subtitle_download_operations",
  "subtitle_searches",
  "users",
] as const;
const requiredColumns = {
  acquisition_grab_operations: [
    "completed_at",
    "failure_code",
    "fingerprint_hash",
    "idempotency_key_hash",
    "response_json",
    "state",
    "user_id",
  ],
  acquisition_search_operations: [
    "completed_at",
    "failure_code",
    "fingerprint_hash",
    "idempotency_key_hash",
    "response_json",
    "state",
    "user_id",
  ],
  audit_budget_entries: ["bucket_hash", "created_at", "generation", "scope", "slot"],
  audit_budget_scopes: [
    "clock_watermark_at",
    "generation",
    "rollback_started_at",
    "saturated",
    "scope",
    "suppressed_count",
    "window_started_at",
  ],
  audit_events: ["actor_auth_method", "actor_session_id", "request_id"],
  auth_transactions: ["browser_binding_hash", "redirect_uri"],
  download_queue_removal_operations: [
    "completed_at",
    "connector_id",
    "failure_code",
    "fingerprint_hash",
    "idempotency_key_hash",
    "item_id",
    "item_snapshot_json",
    "mutation_started_at",
    "response_json",
    "state",
    "user_id",
  ],
  external_issue_references: [
    "connector_id",
    "encrypted_upstream_id",
    "expires_at",
    "last_used_at",
    "upstream_id_digest",
  ],
  jellyfin_quick_connect_transactions: [
    "browser_binding_hash",
    "connector_id",
    "connector_type",
    "consumed_at",
    "encrypted_payload",
    "expires_at",
    "next_poll_at",
    "pairing_session_id",
    "poll_count",
    "purpose",
  ],
  library_artwork_searches: [
    "encrypted_payload",
    "expires_at",
    "link_revision",
    "media_reference_id",
    "service_identity_link_id",
    "user_id",
  ],
  library_mutation_operations: [
    "completed_at",
    "failure_code",
    "fingerprint_hash",
    "idempotency_key_hash",
    "reference_id",
    "response_json",
    "state",
    "user_id",
  ],
  media_references: [
    "encrypted_payload",
    "expires_at",
    "item_digest",
    "last_used_at",
    "link_revision",
    "service_identity_link_id",
    "user_id",
  ],
  media_issues: [
    "category",
    "encrypted_description",
    "encrypted_resolution",
    "media_reference_id",
    "playback_session_id",
    "position_seconds",
    "resolved_at",
    "resolved_by_user_id",
    "service_identity_link_id",
    "state",
    "user_id",
  ],
  media_issue_operations: [
    "completed_at",
    "desired_status",
    "failure_code",
    "fingerprint_hash",
    "idempotency_key_hash",
    "issue_id",
    "response_json",
    "source",
    "state",
    "user_id",
  ],
  media_request_operations: [
    "completed_at",
    "failure_code",
    "fingerprint_hash",
    "idempotency_key_hash",
    "response_json",
    "state",
    "user_id",
  ],
  playback_sessions: [
    "encrypted_payload",
    "expires_at",
    "last_reported_at",
    "link_revision",
    "media_reference_id",
    "position_seconds",
    "revision",
    "service_identity_link_id",
    "state",
    "user_id",
  ],
  oidc_logout_receipts: ["expires_at", "issued_at", "jti_hash", "provider_id", "received_at"],
  oidc_providers: [
    "approved_endpoint_origins_json",
    "discovery_capabilities_json",
    "discovery_checked_at",
    "discovery_state",
    "id_token_signing_alg",
    "token_endpoint_auth_method",
  ],
  service_identity_links: [
    "connector_id",
    "device_id",
    "encrypted_access_token",
    "external_display_name",
    "external_server_id",
    "revision",
    "revoked_at",
    "token_created_at",
  ],
  session_rotation_aliases: [
    "expires_at",
    "purpose",
    "session_id",
    "state",
    "token_hash",
    "valid_from",
  ],
  session_secret_reservations: ["origin_session_id", "purpose", "reserved_at", "secret_hash"],
  sessions: [
    "encrypted_csrf_token",
    "encrypted_id_token_hint",
    "last_rotated_at",
    "service_identity_link_id",
  ],
  subtitle_download_operations: [
    "completed_at",
    "failure_code",
    "fingerprint_hash",
    "idempotency_key_hash",
    "response_json",
    "result_id",
    "search_id",
    "state",
    "user_id",
  ],
  subtitle_searches: [
    "connector_id",
    "encrypted_payload",
    "expires_at",
    "link_revision",
    "media_reference_id",
    "service_identity_link_id",
    "user_id",
  ],
  users: ["role_source"],
} as const;
const requiredIndexes = {
  acquisition_grab_operations: [
    "acquisition_grab_operations_state_created_idx",
    "acquisition_grab_operations_user_key_unique",
  ],
  acquisition_search_operations: [
    "acquisition_search_operations_state_created_idx",
    "acquisition_search_operations_user_key_unique",
  ],
  audit_budget_entries: ["audit_budget_entries_bucket_unique"],
  audit_budget_scopes: ["audit_budget_scopes_scope_generation_unique"],
  audit_events: ["audit_events_actor_session_idx", "audit_events_request_idx"],
  connector_configs: ["connector_configs_id_type_unique"],
  download_queue_removal_operations: [
    "download_queue_removal_operations_item_idx",
    "download_queue_removal_operations_state_created_idx",
    "download_queue_removal_operations_user_key_unique",
  ],
  external_issue_references: [
    "external_issue_references_connector_digest_unique",
    "external_issue_references_expiry_idx",
  ],
  jellyfin_quick_connect_transactions: [
    "jellyfin_quick_connect_transactions_browser_expiry_idx",
    "jellyfin_quick_connect_transactions_expiry_idx",
    "jellyfin_quick_connect_transactions_pairing_session_idx",
  ],
  library_artwork_searches: [
    "library_artwork_searches_expiry_idx",
    "library_artwork_searches_media_idx",
    "library_artwork_searches_user_created_idx",
  ],
  library_mutation_operations: [
    "library_mutation_operations_reference_idx",
    "library_mutation_operations_state_created_idx",
    "library_mutation_operations_user_key_unique",
  ],
  media_references: [
    "media_references_expiry_idx",
    "media_references_link_item_unique",
    "media_references_user_last_used_idx",
  ],
  media_issues: [
    "media_issues_media_created_idx",
    "media_issues_state_created_idx",
    "media_issues_user_created_idx",
  ],
  media_issue_operations: [
    "media_issue_operations_issue_created_idx",
    "media_issue_operations_state_created_idx",
    "media_issue_operations_user_key_unique",
  ],
  media_request_operations: [
    "media_request_operations_state_created_idx",
    "media_request_operations_user_key_unique",
  ],
  oidc_logout_receipts: [
    "oidc_logout_receipts_expiry_idx",
    "oidc_logout_receipts_provider_jti_unique",
  ],
  playback_sessions: ["playback_sessions_expiry_idx", "playback_sessions_user_updated_idx"],
  service_identity_links: ["service_identity_links_connector_idx"],
  session_rotation_aliases: [
    "session_rotation_aliases_expiry_idx",
    "session_rotation_aliases_session_idx",
  ],
  session_secret_reservations: [
    "session_secret_reservations_attribution_unique",
    "session_secret_reservations_origin_idx",
  ],
  sessions: [
    "sessions_active_recovery_idx",
    "sessions_recovery_created_idx",
    "sessions_user_active_idx",
    "sessions_user_created_idx",
  ],
  subtitle_download_operations: [
    "subtitle_download_operations_state_created_idx",
    "subtitle_download_operations_user_key_unique",
  ],
  subtitle_searches: [
    "subtitle_searches_expiry_idx",
    "subtitle_searches_media_idx",
    "subtitle_searches_user_created_idx",
  ],
} as const;
const requiredTriggers = [
  "audit_budget_entries_current_generation_delete_protected",
  "audit_budget_entries_insert_current_generation",
  "audit_budget_entries_update_immutable",
  "audit_budget_scopes_delete_protected",
  "audit_budget_scopes_update_guarded",
  "session_rotation_aliases_update_immutable",
  "session_secret_reservations_delete_immutable",
  "session_secret_reservations_update_immutable",
  "sessions_rotation_aliases_revoke",
  "sessions_secret_reservations_bearer_update",
  "sessions_secret_reservations_csrf_update",
  "sessions_secret_reservations_insert",
] as const;

interface MigrationJournalEntry {
  breakpoints: boolean;
  idx: number;
  tag: string;
  version: string;
  when: number;
}

interface MigrationJournal {
  dialect: string;
  entries: MigrationJournalEntry[];
  version: string;
}

interface LegacySessionFixture {
  createdAt: number;
  csrfTokenHash: string;
  id: string;
  lastRotatedAt: number;
  tokenHash: string;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function writeHistoricalMigrationFixture() {
  const journal = JSON.parse(
    readFileSync(path.join(currentMigrationDirectory, "meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
  const historicalEntries = journal.entries.filter(({ idx }) => idx <= 2);
  assertCondition(
    historicalEntries.length === 3 &&
      historicalEntries.at(-1)?.tag === "0002_oidc_runtime_security",
    "Historical migration smoke fixture must end exactly at migration 0002.",
  );

  mkdirSync(path.join(historicalMigrationDirectory, "meta"), {
    mode: 0o700,
    recursive: true,
  });
  for (const entry of historicalEntries) {
    copyFileSync(
      path.join(currentMigrationDirectory, `${entry.tag}.sql`),
      path.join(historicalMigrationDirectory, `${entry.tag}.sql`),
    );
  }
  writeFileSync(
    path.join(historicalMigrationDirectory, "meta/_journal.json"),
    `${JSON.stringify({ ...journal, entries: historicalEntries }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    currentMigrationCount: journal.entries.length,
    currentMigrationTag: journal.entries.at(-1)?.tag,
    currentMigrationTimestamp: journal.entries.at(-1)?.when,
    historicalMigrationTimestamp: historicalEntries.at(-1)!.when,
  };
}

function applyHistoricalMigrations(database: DatabaseHandle) {
  migrateWithDrizzle(database.db, { migrationsFolder: historicalMigrationDirectory });
}

function insertLegacySession(database: DatabaseHandle, fixture: LegacySessionFixture) {
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
        @createdAt,
        @lastRotatedAt,
        @lastRotatedAt,
        30000,
        40000
      )`,
    )
    .run(fixture);
}

function migrationJournalState(database: DatabaseHandle) {
  return database.sqlite
    .prepare(
      `select count(*) as count, max(created_at) as latestMigrationTimestamp
       from __drizzle_migrations`,
    )
    .get() as { count: number; latestMigrationTimestamp: number };
}

function assertNoForeignKeyViolations(database: DatabaseHandle, context: string) {
  const violations = database.sqlite.pragma("foreign_key_check") as unknown[];
  assertCondition(
    violations.length === 0,
    `${context} left ${violations.length} foreign-key violations.`,
  );
}

const {
  currentMigrationCount,
  currentMigrationTag,
  currentMigrationTimestamp,
  historicalMigrationTimestamp,
} = writeHistoricalMigrationFixture();
assertCondition(
  currentMigrationTimestamp !== undefined && currentMigrationTag === "0017_download_queue_removals",
  "Current migration journal must end at migration 0017_download_queue_removals.",
);

try {
  const database = openDatabase(freshDatabasePath);
  try {
    database.migrate();
    database.migrate();
    const tables = database.sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle_%'",
      )
      .all() as { name: string }[];
    const names = new Set(tables.map(({ name }) => name));
    const missing = requiredTables.filter((required) => !names.has(required));
    const unexpected = [...names].filter(
      (name) => !requiredTables.includes(name as (typeof requiredTables)[number]),
    );

    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Migration table set mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
      );
    }

    for (const [table, columns] of Object.entries(requiredColumns)) {
      const availableColumns = new Set(
        (
          database.sqlite.pragma(`table_info(${table})`) as {
            name: string;
          }[]
        ).map(({ name }) => name),
      );
      const missingColumns = columns.filter((column) => !availableColumns.has(column));
      if (missingColumns.length > 0) {
        throw new Error(`Migration columns missing from ${table}: ${missingColumns.join(", ")}.`);
      }
    }

    for (const [table, indexes] of Object.entries(requiredIndexes)) {
      const availableIndexes = new Set(
        (
          database.sqlite.pragma(`index_list(${table})`) as {
            name: string;
          }[]
        ).map(({ name }) => name),
      );
      const missingIndexes = indexes.filter((indexName) => !availableIndexes.has(indexName));
      if (missingIndexes.length > 0) {
        throw new Error(`Migration indexes missing from ${table}: ${missingIndexes.join(", ")}.`);
      }
    }

    const availableTriggers = new Set(
      (
        database.sqlite.prepare("select name from sqlite_master where type = 'trigger'").all() as {
          name: string;
        }[]
      ).map(({ name }) => name),
    );
    const missingTriggers = requiredTriggers.filter(
      (triggerName) => !availableTriggers.has(triggerName),
    );
    if (missingTriggers.length > 0) {
      throw new Error(`Migration triggers missing: ${missingTriggers.join(", ")}.`);
    }

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
    const connectorForeignKeyColumns = serviceLinkForeignKeys
      .filter(({ id }) => id === connectorForeignKeyId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ from, to }) => `${from}:${to}`);
    if (connectorForeignKeyColumns.join(",") !== "connector_id:id,service:type") {
      throw new Error(
        "Migration is missing the connector type-bound service identity foreign key.",
      );
    }

    const mediaReferenceForeignKeys = database.sqlite.pragma(
      "foreign_key_list(media_references)",
    ) as {
      from: string;
      id: number;
      seq: number;
      table: string;
      to: string;
    }[];
    const linkForeignKeyId = mediaReferenceForeignKeys.find(
      ({ from, table }) =>
        from === "service_identity_link_id" && table === "service_identity_links",
    )?.id;
    const linkForeignKeyColumns = mediaReferenceForeignKeys
      .filter(({ id }) => id === linkForeignKeyId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ from, to }) => `${from}:${to}`);
    if (linkForeignKeyColumns.join(",") !== "service_identity_link_id:id,user_id:user_id") {
      throw new Error("Migration is missing the user-bound media reference foreign key.");
    }

    const playbackForeignKeys = database.sqlite.pragma("foreign_key_list(playback_sessions)") as {
      from: string;
      id: number;
      seq: number;
      table: string;
      to: string;
    }[];
    const playbackLinkForeignKeyId = playbackForeignKeys.find(
      ({ from, table }) =>
        from === "service_identity_link_id" && table === "service_identity_links",
    )?.id;
    const playbackLinkForeignKeyColumns = playbackForeignKeys
      .filter(({ id }) => id === playbackLinkForeignKeyId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ from, to }) => `${from}:${to}`);
    if (playbackLinkForeignKeyColumns.join(",") !== "service_identity_link_id:id,user_id:user_id") {
      throw new Error("Migration is missing the user-bound playback session foreign key.");
    }
    if (
      !playbackForeignKeys.some(
        ({ from, table, to }) =>
          from === "media_reference_id" && table === "media_references" && to === "id",
      )
    ) {
      throw new Error("Migration is missing the playback-to-media-reference foreign key.");
    }

    const mediaIssueForeignKeys = database.sqlite.pragma("foreign_key_list(media_issues)") as {
      from: string;
      id: number;
      seq: number;
      table: string;
      to: string;
    }[];
    const mediaIssueLinkForeignKeyId = mediaIssueForeignKeys.find(
      ({ from, table }) =>
        from === "service_identity_link_id" && table === "service_identity_links",
    )?.id;
    const mediaIssueLinkForeignKeyColumns = mediaIssueForeignKeys
      .filter(({ id }) => id === mediaIssueLinkForeignKeyId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ from, to }) => `${from}:${to}`);
    if (
      mediaIssueLinkForeignKeyColumns.join(",") !== "service_identity_link_id:id,user_id:user_id"
    ) {
      throw new Error("Migration is missing the user-bound media issue identity foreign key.");
    }
    if (
      !mediaIssueForeignKeys.some(
        ({ from, table, to }) =>
          from === "media_reference_id" && table === "media_references" && to === "id",
      )
    ) {
      throw new Error("Migration is missing the issue-to-media-reference foreign key.");
    }

    const subtitleSearchForeignKeys = database.sqlite.pragma(
      "foreign_key_list(subtitle_searches)",
    ) as {
      from: string;
      id: number;
      seq: number;
      table: string;
      to: string;
    }[];
    const subtitleSearchLinkForeignKeyId = subtitleSearchForeignKeys.find(
      ({ from, table }) =>
        from === "service_identity_link_id" && table === "service_identity_links",
    )?.id;
    const subtitleSearchLinkForeignKeyColumns = subtitleSearchForeignKeys
      .filter(({ id }) => id === subtitleSearchLinkForeignKeyId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ from, to }) => `${from}:${to}`);
    if (
      subtitleSearchLinkForeignKeyColumns.join(",") !==
      "service_identity_link_id:id,user_id:user_id"
    ) {
      throw new Error("Migration is missing the user-bound subtitle search identity foreign key.");
    }
    for (const [column, table] of [
      ["media_reference_id", "media_references"],
      ["connector_id", "connector_configs"],
    ] as const) {
      if (
        !subtitleSearchForeignKeys.some(
          ({ from, table: foreignTable, to }) =>
            from === column && foreignTable === table && to === "id",
        )
      ) {
        throw new Error(`Migration is missing the subtitle-search ${column} foreign key.`);
      }
    }

    const subtitleDownloadForeignKeys = database.sqlite.pragma(
      "foreign_key_list(subtitle_download_operations)",
    ) as { from: string; table: string; to: string }[];
    if (
      !subtitleDownloadForeignKeys.some(
        ({ from, table, to }) => from === "user_id" && table === "users" && to === "id",
      )
    ) {
      throw new Error("Migration is missing the subtitle-download user foreign key.");
    }

    const rotationAliasForeignKeys = database.sqlite.pragma(
      "foreign_key_list(session_rotation_aliases)",
    ) as {
      from: string;
      id: number;
      seq: number;
      table: string;
      to: string;
    }[];
    const reservationForeignKeyId = rotationAliasForeignKeys.find(
      ({ from, table }) => from === "token_hash" && table === "session_secret_reservations",
    )?.id;
    const reservationForeignKeyColumns = rotationAliasForeignKeys
      .filter(({ id }) => id === reservationForeignKeyId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ from, to }) => `${from}:${to}`);
    if (
      reservationForeignKeyColumns.join(",") !==
      "token_hash:secret_hash,purpose:purpose,session_id:origin_session_id"
    ) {
      throw new Error(
        "Migration is missing the purpose- and origin-bound rotation alias reservation foreign key.",
      );
    }

    const auditBudgetForeignKeys = database.sqlite.pragma(
      "foreign_key_list(audit_budget_entries)",
    ) as { from: string; table: string; to: string }[];
    if (
      !auditBudgetForeignKeys.some(
        ({ from, table, to }) =>
          from === "scope" && table === "audit_budget_scopes" && to === "scope",
      )
    ) {
      throw new Error("Migration is missing the fixed-scope audit budget foreign key.");
    }

    assertCondition(
      (
        database.sqlite.prepare("select count(*) as count from audit_budget_scopes").get() as {
          count: number;
        }
      ).count === 0,
      "Migration must leave audit budget scope creation to the first audited event.",
    );

    const auditScope = "auth.oidc.failure:v1";
    database.sqlite
      .prepare(
        `insert into audit_budget_scopes (
           scope, generation, window_started_at, clock_watermark_at,
           rollback_started_at, saturated, suppressed_count
         ) values (?, 1, 1000, 1000, null, 0, 0)`,
      )
      .run(auditScope);
    database.sqlite
      .prepare(
        `insert into audit_budget_entries (
           scope, generation, slot, bucket_hash, created_at
         ) values (?, 1, 0, ?, 1000)`,
      )
      .run(auditScope, "a".repeat(22));
    let futureGenerationRejected = false;
    try {
      database.sqlite
        .prepare(
          `insert into audit_budget_entries (
             scope, generation, slot, bucket_hash, created_at
           ) values (?, 2, 0, ?, 1000)`,
        )
        .run(auditScope, "b".repeat(22));
    } catch {
      futureGenerationRejected = true;
    }
    assertCondition(
      futureGenerationRejected,
      "Audit budget accepted an entry outside the current generation.",
    );
    database.sqlite
      .prepare(
        `update audit_budget_scopes
         set generation = 2,
             window_started_at = 2000,
             clock_watermark_at = 2000
         where scope = ?`,
      )
      .run(auditScope);
    assertCondition(
      database.sqlite
        .prepare("delete from audit_budget_entries where scope = ? and generation = 1")
        .run(auditScope).changes === 1,
      "Audit budget could not delete an entry after its generation advanced.",
    );

    const foreignKeyViolations = database.sqlite.pragma("foreign_key_check") as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(`Migration left ${foreignKeyViolations.length} foreign-key violations.`);
    }

    process.stdout.write(
      `Migration smoke passed with ${names.size} application tables and hardened authentication invariants.\n`,
    );
  } finally {
    database.close();
  }

  const upgradeDatabase = openDatabase(upgradeDatabasePath);
  try {
    applyHistoricalMigrations(upgradeDatabase);
    assertCondition(
      JSON.stringify(migrationJournalState(upgradeDatabase)) ===
        JSON.stringify({
          count: 3,
          latestMigrationTimestamp: historicalMigrationTimestamp,
        }),
      "Historical upgrade fixture did not stop at migration 0002.",
    );
    insertLegacySession(upgradeDatabase, {
      createdAt: 1_000,
      csrfTokenHash: "c".repeat(43),
      id: "upgrade-session-one",
      lastRotatedAt: 1_500,
      tokenHash: "a".repeat(43),
    });
    insertLegacySession(upgradeDatabase, {
      createdAt: 2_000,
      csrfTokenHash: "d".repeat(43),
      id: "upgrade-session-two",
      lastRotatedAt: 2_500,
      tokenHash: "b".repeat(43),
    });

    upgradeDatabase.migrate();
    upgradeDatabase.migrate();
    assertCondition(
      JSON.stringify(migrationJournalState(upgradeDatabase)) ===
        JSON.stringify({
          count: currentMigrationCount,
          latestMigrationTimestamp: currentMigrationTimestamp,
        }),
      "Production migration did not advance the historical fixture exactly through migration 0015.",
    );
    const reservations = upgradeDatabase.sqlite
      .prepare(
        `select
          secret_hash as secretHash,
          purpose,
          origin_session_id as originSessionId,
          reserved_at as reservedAt
         from session_secret_reservations
         order by origin_session_id, purpose`,
      )
      .all();
    assertCondition(
      JSON.stringify(reservations) ===
        JSON.stringify([
          {
            secretHash: "a".repeat(43),
            purpose: "bearer",
            originSessionId: "upgrade-session-one",
            reservedAt: 1_500,
          },
          {
            secretHash: "c".repeat(43),
            purpose: "csrf",
            originSessionId: "upgrade-session-one",
            reservedAt: 1_000,
          },
          {
            secretHash: "b".repeat(43),
            purpose: "bearer",
            originSessionId: "upgrade-session-two",
            reservedAt: 2_500,
          },
          {
            secretHash: "d".repeat(43),
            purpose: "csrf",
            originSessionId: "upgrade-session-two",
            reservedAt: 2_000,
          },
        ]),
      "Production migration did not backfill every legacy bearer and CSRF reservation.",
    );
    assertCondition(
      (
        upgradeDatabase.sqlite
          .prepare("select count(*) as count from audit_budget_scopes")
          .get() as { count: number }
      ).count === 0,
      "Production upgrade created audit budget runtime state before the first event.",
    );

    upgradeDatabase.sqlite
      .prepare(
        `update sessions
         set token_hash = ?, last_rotated_at = 5000, last_seen_at = 5000
         where id = 'upgrade-session-one'`,
      )
      .run("e".repeat(43));
    assertCondition(
      (
        upgradeDatabase.sqlite
          .prepare("select count(*) as count from session_rotation_aliases")
          .get() as { count: number }
      ).count === 1,
      "Production upgrade did not create a durable rotation alias.",
    );
    upgradeDatabase.sqlite.exec("delete from sessions where id = 'upgrade-session-one'");
    assertCondition(
      (
        upgradeDatabase.sqlite
          .prepare("select count(*) as count from session_rotation_aliases")
          .get() as { count: number }
      ).count === 0,
      "Deleting a session did not clean up its transient rotation aliases.",
    );
    assertCondition(
      (
        upgradeDatabase.sqlite
          .prepare(
            "select count(*) as count from session_secret_reservations where origin_session_id = 'upgrade-session-one'",
          )
          .get() as { count: number }
      ).count === 3,
      "Permanent reservations did not survive deletion of their origin session.",
    );
    assertNoForeignKeyViolations(upgradeDatabase, "Production upgrade migration");
  } finally {
    upgradeDatabase.close();
  }

  const collisionDatabase = openDatabase(collisionDatabasePath);
  try {
    applyHistoricalMigrations(collisionDatabase);
    insertLegacySession(collisionDatabase, {
      createdAt: 1_000,
      csrfTokenHash: "c".repeat(43),
      id: "collision-session-one",
      lastRotatedAt: 1_000,
      tokenHash: "a".repeat(43),
    });
    insertLegacySession(collisionDatabase, {
      createdAt: 2_000,
      csrfTokenHash: "a".repeat(43),
      id: "collision-session-two",
      lastRotatedAt: 2_000,
      tokenHash: "b".repeat(43),
    });

    let collisionMigrationFailed = false;
    try {
      collisionDatabase.migrate();
    } catch {
      collisionMigrationFailed = true;
    }
    assertCondition(
      collisionMigrationFailed,
      "Production migration accepted cross-purpose legacy secret reuse.",
    );
    const partialTables = collisionDatabase.sqlite
      .prepare(
        `select name
         from sqlite_master
         where type = 'table'
           and name in ('session_rotation_aliases', 'session_secret_reservations')`,
      )
      .all();
    assertCondition(
      partialTables.length === 0,
      "Failed collision migration left migration 0003 tables behind.",
    );
    const partialTriggers = collisionDatabase.sqlite
      .prepare(
        `select name
         from sqlite_master
         where type = 'trigger'
           and name in (${requiredTriggers.map(() => "?").join(", ")})`,
      )
      .all(...requiredTriggers);
    assertCondition(
      partialTriggers.length === 0,
      "Failed collision migration left migration 0003 triggers behind.",
    );
    assertCondition(
      (
        collisionDatabase.sqlite.prepare("select count(*) as count from sessions").get() as {
          count: number;
        }
      ).count === 2,
      "Failed collision migration changed legacy session rows.",
    );
    assertCondition(
      JSON.stringify(migrationJournalState(collisionDatabase)) ===
        JSON.stringify({
          count: 3,
          latestMigrationTimestamp: historicalMigrationTimestamp,
        }),
      "Failed collision migration advanced the Drizzle journal beyond migration 0002.",
    );
    assertNoForeignKeyViolations(collisionDatabase, "Failed collision migration");
  } finally {
    collisionDatabase.close();
  }

  process.stdout.write(
    "Migration upgrade smoke passed for fresh, idempotent, historical-upgrade through 0015, retention, and collision-rollback paths.\n",
  );
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
