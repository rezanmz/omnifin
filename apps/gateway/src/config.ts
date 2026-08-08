import { validateDestinationUrlLiteral } from "@omnifin/connectors/security/destination";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";
import { asStartupError, StartupError, type StartupFailureCode } from "./startup-error.js";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalUrlString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

const optionalSecretSetting = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OMNIFIN_BASE_URL: z.url().default("http://localhost:3000"),
  OMNIFIN_BACKUP_DIRECTORY: z.string().min(1).default("/backups"),
  OMNIFIN_BACKUP_RETENTION_COUNT: z.coerce.number().int().min(2).max(365).default(14),
  OMNIFIN_DATABASE_URL: z.string().min(1).default("./data/omnifin.db"),
  OMNIFIN_ENCRYPTION_KEY: optionalSecretSetting,
  OMNIFIN_ENCRYPTION_KEY_FILE: optionalSecretSetting,
  OMNIFIN_HOST: z.string().min(1).default("127.0.0.1"),
  OMNIFIN_IMAGE_REF: optionalSecretSetting,
  OMNIFIN_INSECURE_LOOPBACK_PREVIEW: booleanString,
  OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED: booleanString,
  OMNIFIN_JELLYFIN_URL: optionalUrlString,
  OMNIFIN_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  OMNIFIN_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  OMNIFIN_RECOVERY_SECRET: optionalSecretSetting,
  OMNIFIN_RECOVERY_SECRET_FILE: optionalSecretSetting,
  OMNIFIN_SECURE_COOKIES: booleanString,
  OMNIFIN_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
});

export interface AppConfig {
  backupDirectory?: string;
  backupRetentionCount?: number;
  baseUrl: URL;
  databaseUrl: string;
  encryptionKey: Buffer;
  environment: "development" | "test" | "production";
  host: string;
  imageReference?: string;
  insecureLoopbackPreview: boolean;
  jellyfinInsecureHttpApproved: boolean;
  jellyfinUrl?: URL;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  port: number;
  recoverySecretDigest?: Buffer;
  secureCookies: boolean;
  session: {
    absoluteTtlMs: number;
    inactivityTtlMs: number;
    recoveryAbsoluteTtlMs: number;
    rotationIntervalMs: number;
  };
  trustProxyHops: number;
}

const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RECOVERY_SECRET_MIN_BYTES = 32;
const RECOVERY_SECRET_MAX_BYTES = 128;
const RECOVERY_SECRET_MAX_ENCODED_CHARACTERS = Math.ceil(RECOVERY_SECRET_MAX_BYTES / 3) * 4;
const RECOVERY_SECRET_DIGEST_BYTES = 32;
const IMMUTABLE_IMAGE_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;

function secretFromEnvironment(
  value: string | undefined,
  file: string | undefined,
  conflictCode: StartupFailureCode,
  unreadableFileCode: StartupFailureCode,
) {
  if (value !== undefined && file !== undefined) throw new StartupError(conflictCode);
  if (file === undefined) return value;

  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new StartupError(unreadableFileCode, { cause: error });
  }
}

function decodeCanonicalBase64(encoded: string) {
  if (encoded.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.toString("base64") === encoded ? decoded : undefined;
}

function decodeEncryptionKey(encoded: string | undefined) {
  if (!encoded) throw new StartupError("encryption_key_missing");
  const key = decodeCanonicalBase64(encoded);
  if (!key || key.length !== 32) {
    throw new StartupError("encryption_key_invalid");
  }
  return key;
}

function digestRecoverySecret(encoded: string) {
  if (encoded.length > RECOVERY_SECRET_MAX_ENCODED_CHARACTERS) {
    throw new StartupError("recovery_secret_invalid");
  }
  const secret = decodeCanonicalBase64(encoded);
  if (
    !secret ||
    secret.length < RECOVERY_SECRET_MIN_BYTES ||
    secret.length > RECOVERY_SECRET_MAX_BYTES
  ) {
    throw new StartupError("recovery_secret_invalid");
  }

  try {
    return createHash("sha256").update(secret).digest();
  } finally {
    secret.fill(0);
  }
}

export function verifyRecoverySecret(candidate: unknown, expectedDigest: unknown) {
  const decodedCandidate =
    typeof candidate === "string" && candidate.length <= RECOVERY_SECRET_MAX_ENCODED_CHARACTERS
      ? decodeCanonicalBase64(candidate)
      : undefined;
  const candidateHasValidFormat =
    decodedCandidate !== undefined &&
    decodedCandidate.length >= RECOVERY_SECRET_MIN_BYTES &&
    decodedCandidate.length <= RECOVERY_SECRET_MAX_BYTES;
  const candidateDigest = createHash("sha256")
    .update(candidateHasValidFormat ? decodedCandidate : Buffer.alloc(0))
    .digest();
  decodedCandidate?.fill(0);

  const comparisonDigest = Buffer.alloc(RECOVERY_SECRET_DIGEST_BYTES);
  const expectedDigestHasValidFormat =
    expectedDigest instanceof Uint8Array &&
    expectedDigest.byteLength === RECOVERY_SECRET_DIGEST_BYTES;
  if (expectedDigestHasValidFormat) {
    comparisonDigest.set(expectedDigest);
  }

  const matches = timingSafeEqual(candidateDigest, comparisonDigest);
  comparisonDigest.fill(0);
  candidateDigest.fill(0);
  return candidateHasValidFormat && expectedDigestHasValidFormat && matches;
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)]$/, "$1")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  return family === 6 && normalized === "::1";
}

function canonicalBaseUrl(value: string, environment: AppConfig["environment"]) {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new StartupError("base_url_invalid");
  }
  if (
    environment === "production" &&
    url.protocol !== "https:" &&
    !isLoopbackHostname(url.hostname)
  ) {
    throw new StartupError("base_url_invalid");
  }
  return url;
}

function canonicalJellyfinUrl(value: string, insecureHttpApproved: boolean) {
  if (value.includes("?") || value.includes("#")) {
    throw new StartupError("jellyfin_configuration_invalid");
  }
  try {
    return validateDestinationUrlLiteral(value, {
      allowInsecureHttp: insecureHttpApproved,
    });
  } catch (error) {
    throw new StartupError("jellyfin_configuration_invalid", { cause: error });
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  let parsed: z.infer<typeof environmentSchema>;
  try {
    parsed = environmentSchema.parse(environment);
  } catch (error) {
    throw asStartupError(error, "configuration_invalid");
  }
  const encryptionKey = secretFromEnvironment(
    parsed.OMNIFIN_ENCRYPTION_KEY,
    parsed.OMNIFIN_ENCRYPTION_KEY_FILE,
    "encryption_key_conflict",
    "encryption_key_file_unreadable",
  );
  const recoverySecret = secretFromEnvironment(
    parsed.OMNIFIN_RECOVERY_SECRET,
    parsed.OMNIFIN_RECOVERY_SECRET_FILE,
    "recovery_secret_conflict",
    "recovery_secret_file_unreadable",
  );
  const recoverySecretDigest =
    recoverySecret === undefined ? undefined : digestRecoverySecret(recoverySecret);
  if (parsed.OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED && !parsed.OMNIFIN_JELLYFIN_URL) {
    throw new StartupError("jellyfin_configuration_invalid");
  }
  const jellyfinUrl = parsed.OMNIFIN_JELLYFIN_URL
    ? canonicalJellyfinUrl(
        parsed.OMNIFIN_JELLYFIN_URL,
        parsed.OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED,
      )
    : undefined;
  const baseUrl = canonicalBaseUrl(parsed.OMNIFIN_BASE_URL, parsed.NODE_ENV);
  const secureCookies = parsed.OMNIFIN_SECURE_COOKIES || baseUrl.protocol === "https:";
  const insecureLoopbackPreview =
    !secureCookies &&
    baseUrl.protocol === "http:" &&
    isLoopbackHostname(baseUrl.hostname) &&
    (parsed.NODE_ENV !== "production" || parsed.OMNIFIN_INSECURE_LOOPBACK_PREVIEW);
  if (
    (secureCookies && baseUrl.protocol !== "https:") ||
    (!secureCookies && !insecureLoopbackPreview)
  ) {
    throw new StartupError("base_url_invalid");
  }
  if (
    parsed.NODE_ENV === "production" &&
    (!parsed.OMNIFIN_IMAGE_REF || !IMMUTABLE_IMAGE_PATTERN.test(parsed.OMNIFIN_IMAGE_REF))
  ) {
    throw new StartupError("image_reference_invalid");
  }

  return {
    backupDirectory: parsed.OMNIFIN_BACKUP_DIRECTORY,
    backupRetentionCount: parsed.OMNIFIN_BACKUP_RETENTION_COUNT,
    baseUrl,
    databaseUrl: parsed.OMNIFIN_DATABASE_URL,
    encryptionKey: decodeEncryptionKey(encryptionKey),
    environment: parsed.NODE_ENV,
    host: parsed.OMNIFIN_HOST,
    ...(parsed.OMNIFIN_IMAGE_REF ? { imageReference: parsed.OMNIFIN_IMAGE_REF } : {}),
    insecureLoopbackPreview,
    jellyfinInsecureHttpApproved: parsed.OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED,
    ...(jellyfinUrl ? { jellyfinUrl } : {}),
    logLevel: parsed.OMNIFIN_LOG_LEVEL,
    port: parsed.OMNIFIN_PORT,
    ...(recoverySecretDigest ? { recoverySecretDigest } : {}),
    secureCookies,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 12 * 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 15 * 60 * 1_000,
    },
    trustProxyHops: parsed.OMNIFIN_TRUST_PROXY_HOPS,
  };
}
