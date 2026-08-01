import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  deploymentReadinessCheckIds,
  deploymentReadinessResponseSchema,
  type DeploymentReadinessCheck,
  type DeploymentReadinessResponse,
} from "@omnifin/contracts/deployment";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";

const RECOVERY_SECRET_DIGEST_BYTES = 32;

export interface DeploymentReadinessContext {
  principal: SessionPrincipal;
}

export interface DeploymentReadinessDependencies {
  clock?: () => Date;
}

export type DeploymentReadinessErrorReason = "integrity_failure" | "storage_failure";

export class DeploymentReadinessError extends Error {
  public readonly reason: DeploymentReadinessErrorReason;

  public constructor(reason: DeploymentReadinessErrorReason, options?: ErrorOptions) {
    super("Deployment readiness could not be retrieved.", options);
    this.name = "DeploymentReadinessError";
    this.reason = reason;
  }
}

function usesPersistentStorage(databaseUrl: string) {
  const normalized = databaseUrl.trim().toLowerCase();
  return (
    normalized !== ":memory:" &&
    !normalized.startsWith("file::memory:") &&
    !/[?&]mode=memory(?:&|$)/u.test(normalized)
  );
}

function check(id: DeploymentReadinessCheck["id"], ready: boolean): DeploymentReadinessCheck {
  return { id, state: ready ? "ready" : "attention" };
}

export class DeploymentReadinessService {
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: DeploymentReadinessDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#config = config;
    this.#database = database;
  }

  public read(context: DeploymentReadinessContext): DeploymentReadinessResponse {
    const principal = requirePermission(context.principal, "connectors.manage");
    requirePermission(principal, "recovery.oidc.manage");

    try {
      const migrationTable = this.#database.sqlite
        .prepare(
          "select count(*) as count from sqlite_schema where type = 'table' and name = '__drizzle_migrations'",
        )
        .get() as { count?: unknown } | undefined;
      if (migrationTable?.count !== 1) throw new DeploymentReadinessError("integrity_failure");
    } catch (error) {
      if (error instanceof DeploymentReadinessError) throw error;
      throw new DeploymentReadinessError("storage_failure", { cause: error });
    }

    let generatedAt: Date;
    try {
      generatedAt = this.#clock();
    } catch (error) {
      throw new DeploymentReadinessError("integrity_failure", { cause: error });
    }
    if (!Number.isFinite(generatedAt.getTime())) {
      throw new DeploymentReadinessError("integrity_failure");
    }

    const checks: DeploymentReadinessCheck[] = [
      check("runtime", this.#config.environment === "production"),
      check(
        "transport",
        this.#config.baseUrl.protocol === "https:" &&
          this.#config.secureCookies &&
          !this.#config.insecureLoopbackPreview,
      ),
      check(
        "recovery",
        this.#config.recoverySecretDigest?.byteLength === RECOVERY_SECRET_DIGEST_BYTES,
      ),
      check("storage", usesPersistentStorage(this.#config.databaseUrl)),
    ];
    if (checks.some((item, index) => item.id !== deploymentReadinessCheckIds[index])) {
      throw new DeploymentReadinessError("integrity_failure");
    }
    const readyCount = checks.filter(({ state }) => state === "ready").length;
    const parsed = deploymentReadinessResponseSchema.safeParse({
      checks,
      generatedAt: generatedAt.toISOString(),
      readyCount,
      state: readyCount === checks.length ? "ready" : "attention",
      total: checks.length,
    });
    if (!parsed.success) {
      throw new DeploymentReadinessError("integrity_failure", { cause: parsed.error });
    }
    return parsed.data;
  }
}
