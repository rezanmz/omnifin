import type { FastifyPluginAsync } from "fastify";
import { apiErrorJsonSchema, createApiError } from "@omnifin/contracts/errors";
import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db/client.js";

const REQUIRED_TABLES = [
  "__drizzle_migrations",
  "audit_events",
  "auth_transactions",
  "connector_configs",
  "external_identities",
  "oidc_providers",
  "operational_failures",
  "role_mappings",
  "service_identity_links",
  "session_rotation_aliases",
  "session_secret_reservations",
  "sessions",
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
