import type { FastifyPluginAsync } from "fastify";
import { apiErrorJsonSchema, createApiError } from "@omnifin/contracts/errors";
import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db/client.js";

const REQUIRED_TABLES = [
  "__drizzle_migrations",
  "acquisition_search_operations",
  "audit_budget_entries",
  "audit_budget_scopes",
  "audit_events",
  "auth_transactions",
  "connector_configs",
  "external_identities",
  "media_issues",
  "media_references",
  "media_request_operations",
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

const READINESS_BUSY_TIMEOUT_MS = 0;

function assertDatabaseReady(database: DatabaseHandle) {
  const configuredBusyTimeout = database.sqlite.pragma("busy_timeout", {
    simple: true,
  }) as number;
  try {
    database.sqlite.pragma(`busy_timeout = ${READINESS_BUSY_TIMEOUT_MS}`);

    const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
    const tables = database.sqlite
      .prepare(`select name from sqlite_schema where type = 'table' and name in (${placeholders})`)
      .all(...REQUIRED_TABLES) as { name: string }[];
    if (tables.length !== REQUIRED_TABLES.length) {
      throw new Error("Required database schema is not present.");
    }

    database.sqlite
      .prepare(
        "select id, user_id, service_identity_link_id, link_revision, item_digest, encrypted_payload, last_used_at, expires_at from media_references limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, user_id, service_identity_link_id, media_reference_id, playback_session_id, category, encrypted_description, position_seconds, state, encrypted_resolution, resolved_by_user_id, resolved_at from media_issues limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, user_id, service_identity_link_id, media_reference_id, encrypted_payload, state, position_seconds, revision, last_reported_at, expires_at from playback_sessions limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, user_id, service_identity_link_id, link_revision, media_reference_id, connector_id, encrypted_payload, expires_at from subtitle_searches limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, user_id, search_id, result_id, idempotency_key_hash, fingerprint_hash, state, response_json, failure_code, completed_at from subtitle_download_operations limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, user_id, idempotency_key_hash, fingerprint_hash, state, response_json, failure_code, completed_at from media_request_operations limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, user_id, idempotency_key_hash, fingerprint_hash, state, response_json, failure_code, completed_at from acquisition_search_operations limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, user_id, idempotency_key_hash, fingerprint_hash, state, response_json, failure_code, completed_at from acquisition_grab_operations limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select scope, generation, slot, bucket_hash, created_at from audit_budget_entries limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select scope, generation, window_started_at, clock_watermark_at, rollback_started_at, saturated, suppressed_count from audit_budget_scopes limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, oidc_provider_id, external_identity_id, oidc_session_id_hash from sessions limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select token_hash, purpose, state, session_id, valid_from, expires_at from session_rotation_aliases limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select secret_hash, purpose, origin_session_id, reserved_at from session_secret_reservations limit 0",
      )
      .all();
    database.sqlite
      .prepare(
        "select id, claim_path_json, operator, values_json, enabled from role_mappings limit 0",
      )
      .all();

    database.sqlite.exec("begin immediate");
    try {
      database.sqlite
        .prepare('insert into "__drizzle_migrations" (hash, created_at) values (?, ?)')
        .run(`readiness-${randomUUID()}`, Date.now());
    } finally {
      if (database.sqlite.inTransaction) database.sqlite.exec("rollback");
    }
  } finally {
    database.sqlite.pragma(`busy_timeout = ${configuredBusyTimeout}`);
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/healthz",
    {
      config: { rateLimit: false },
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: { status: { const: "ok" } },
          },
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  app.get(
    "/readyz",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["checks", "status"],
            properties: {
              checks: {
                type: "object",
                additionalProperties: false,
                required: ["database"],
                properties: { database: { const: "ok" } },
              },
              status: { const: "ready" },
            },
          },
          503: apiErrorJsonSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        assertDatabaseReady(app.database);
        return { checks: { database: "ok" as const }, status: "ready" as const };
      } catch (error) {
        app.log.error({ err: error, operation: "readiness.database" }, "Readiness check failed");
        return reply.status(503).send(
          createApiError({
            code: "service_unavailable",
            message: "The gateway is not ready.",
            requestId: _request.id,
          }),
        );
      }
    },
  );
};
