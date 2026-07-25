const startupFailureDefinitions = {
  base_url_invalid: { category: "configuration" },
  configuration_invalid: { category: "configuration" },
  database_directory_owner_invalid: { category: "database" },
  database_directory_permissions_invalid: { category: "database" },
  database_directory_unavailable: { category: "database" },
  database_file_permissions_failed: { category: "database" },
  database_initialization_failed: { category: "database" },
  database_migration_failed: { category: "migration" },
  database_migrations_missing: { category: "migration" },
  database_open_failed: { category: "database" },
  encryption_key_conflict: { category: "secrets" },
  encryption_key_file_unreadable: { category: "secrets" },
  encryption_key_invalid: { category: "secrets" },
  encryption_key_missing: { category: "secrets" },
  jellyfin_configuration_invalid: { category: "configuration" },
  recovery_secret_conflict: { category: "secrets" },
  recovery_secret_file_unreadable: { category: "secrets" },
  server_listen_failed: { category: "listener" },
  unexpected_startup_failure: { category: "unexpected" },
} as const;

export type StartupFailureCode = keyof typeof startupFailureDefinitions;
export type StartupFailureCategory =
  (typeof startupFailureDefinitions)[StartupFailureCode]["category"];

const startupFailureMessages: Record<StartupFailureCode, string> = {
  base_url_invalid: "The Omnifin base URL is not valid for this deployment.",
  configuration_invalid: "Gateway configuration is invalid.",
  database_directory_owner_invalid:
    "The database directory must be owned by the gateway runtime user.",
  database_directory_permissions_invalid:
    "The database directory must not be accessible by group or other users.",
  database_directory_unavailable: "The database directory could not be prepared or inspected.",
  database_file_permissions_failed: "The database file permissions could not be restricted.",
  database_initialization_failed: "The database could not be initialized securely.",
  database_migration_failed: "The database migration did not complete.",
  database_migrations_missing: "Database migrations are not present in this build.",
  database_open_failed: "The database could not be opened.",
  encryption_key_conflict: "OMNIFIN_ENCRYPTION_KEY must be provided as a value or file, not both.",
  encryption_key_file_unreadable: "The configured encryption-key file could not be read.",
  encryption_key_invalid:
    "OMNIFIN_ENCRYPTION_KEY must be canonical base64 encoding of exactly 32 bytes.",
  encryption_key_missing: "OMNIFIN_ENCRYPTION_KEY or OMNIFIN_ENCRYPTION_KEY_FILE is required.",
  jellyfin_configuration_invalid: "The Jellyfin connection configuration is invalid.",
  recovery_secret_conflict:
    "OMNIFIN_RECOVERY_SECRET must be provided as a value or file, not both.",
  recovery_secret_file_unreadable: "The configured recovery-secret file could not be read.",
  server_listen_failed: "The gateway could not bind its configured listener.",
  unexpected_startup_failure: "The gateway encountered an unexpected startup failure.",
};

export interface StartupFailureDetails {
  category: StartupFailureCategory;
  code: StartupFailureCode;
}

export class StartupError extends Error {
  readonly startupFailureCode: StartupFailureCode;

  constructor(code: StartupFailureCode, options?: ErrorOptions) {
    super(startupFailureMessages[code], options);
    this.name = "StartupError";
    this.startupFailureCode = code;
  }
}

function findStartupError(
  error: unknown,
  seen: Set<object>,
  remainingDepth: number,
): StartupError | undefined {
  if (remainingDepth === 0 || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  if (error === null || seen.has(error)) return undefined;
  seen.add(error);

  if (
    error instanceof StartupError &&
    Object.hasOwn(startupFailureDefinitions, error.startupFailureCode)
  ) {
    return error;
  }

  if (error instanceof AggregateError) {
    for (const nestedError of error.errors) {
      const match = findStartupError(nestedError, seen, remainingDepth - 1);
      if (match) return match;
    }
  }

  if (error instanceof Error && error.cause !== undefined) {
    return findStartupError(error.cause, seen, remainingDepth - 1);
  }
  return undefined;
}

export function asStartupError(error: unknown, fallbackCode: StartupFailureCode): StartupError {
  return findStartupError(error, new Set(), 8) ?? new StartupError(fallbackCode, { cause: error });
}

export function startupFailureDetails(error: unknown): StartupFailureDetails {
  const startupError = findStartupError(error, new Set(), 8);
  const code = startupError?.startupFailureCode ?? "unexpected_startup_failure";
  return { category: startupFailureDefinitions[code].category, code };
}
