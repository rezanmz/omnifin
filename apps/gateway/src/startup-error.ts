const startupFailureDefinitions = {
  base_url_invalid: { category: "configuration" },
  configuration_invalid: { category: "configuration" },
  database_directory_owner_invalid: { category: "database" },
  database_directory_permissions_invalid: { category: "database" },
  database_directory_unavailable: { category: "database" },
  database_encryption_key_mismatch: { category: "secrets" },
  database_file_permissions_failed: { category: "database" },
  database_foreign_key_check_failed: { category: "database" },
  database_initialization_failed: { category: "database" },
  database_integrity_check_failed: { category: "database" },
  database_key_verifier_invalid: { category: "database" },
  database_maintenance_active: { category: "database" },
  database_migration_history_invalid: { category: "migration" },
  database_migration_failed: { category: "migration" },
  database_migrations_missing: { category: "migration" },
  database_open_failed: { category: "database" },
  database_recovery_backup_failed: { category: "migration" },
  database_recovery_staging_failed: { category: "database" },
  database_recovery_staging_insufficient: { category: "database" },
  database_schema_newer: { category: "migration" },
  database_schema_unsupported: { category: "migration" },
  database_schema_validation_failed: { category: "migration" },
  encryption_key_conflict: { category: "secrets" },
  encryption_key_file_unreadable: { category: "secrets" },
  encryption_key_invalid: { category: "secrets" },
  encryption_key_missing: { category: "secrets" },
  image_reference_invalid: { category: "configuration" },
  jellyfin_configuration_invalid: { category: "configuration" },
  recovery_secret_conflict: { category: "secrets" },
  recovery_secret_file_unreadable: { category: "secrets" },
  recovery_secret_invalid: { category: "secrets" },
  runtime_identity_invalid: { category: "configuration" },
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
  database_encryption_key_mismatch: "The configured encryption key does not match this database.",
  database_file_permissions_failed: "The database file permissions could not be restricted.",
  database_foreign_key_check_failed: "The database contains foreign-key integrity failures.",
  database_initialization_failed: "The database could not be initialized securely.",
  database_integrity_check_failed: "The database integrity check did not pass.",
  database_key_verifier_invalid: "The database key verifier is missing or invalid.",
  database_maintenance_active: "The database is reserved by an explicit maintenance operation.",
  database_migration_history_invalid: "The database migration history does not match this release.",
  database_migration_failed: "The database migration did not complete.",
  database_migrations_missing: "Database migrations are not present in this build.",
  database_open_failed: "The database could not be opened.",
  database_recovery_backup_failed: "A verified pre-migration recovery point could not be created.",
  database_recovery_staging_failed:
    "The database recovery staging copy could not be created or inspected safely.",
  database_recovery_staging_insufficient:
    "Private recovery staging does not have enough bounded space for SQLite recovery.",
  database_schema_newer: "The database schema is newer than this gateway release.",
  database_schema_unsupported: "The database schema is not supported by this gateway release.",
  database_schema_validation_failed: "The migrated database schema did not pass validation.",
  encryption_key_conflict: "OMNIFIN_ENCRYPTION_KEY must be provided as a value or file, not both.",
  encryption_key_file_unreadable: "The configured encryption-key file could not be read.",
  encryption_key_invalid:
    "OMNIFIN_ENCRYPTION_KEY must be canonical base64 encoding of exactly 32 bytes.",
  encryption_key_missing: "OMNIFIN_ENCRYPTION_KEY or OMNIFIN_ENCRYPTION_KEY_FILE is required.",
  image_reference_invalid:
    "OMNIFIN_IMAGE_REF must identify exactly one immutable sha256 image in production.",
  jellyfin_configuration_invalid: "The Jellyfin connection configuration is invalid.",
  recovery_secret_conflict:
    "OMNIFIN_RECOVERY_SECRET must be provided as a value or file, not both.",
  recovery_secret_file_unreadable: "The configured recovery-secret file could not be read.",
  recovery_secret_invalid:
    "OMNIFIN_RECOVERY_SECRET must be canonical base64 encoding of 32 to 128 bytes.",
  runtime_identity_invalid: "The runtime build identity is invalid or unverifiable.",
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
