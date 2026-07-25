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

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OMNIFIN_BASE_URL: z.url().default("http://localhost:3000"),
  OMNIFIN_DATABASE_URL: z.string().min(1).default("./data/omnifin.db"),
  OMNIFIN_ENCRYPTION_KEY: z.string().optional(),
  OMNIFIN_ENCRYPTION_KEY_FILE: z.string().optional(),
  OMNIFIN_HOST: z.string().min(1).default("127.0.0.1"),
  OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED: booleanString,
  OMNIFIN_JELLYFIN_URL: optionalUrlString,
  OMNIFIN_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  OMNIFIN_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  OMNIFIN_RECOVERY_SECRET: z.string().optional(),
  OMNIFIN_RECOVERY_SECRET_FILE: z.string().optional(),
  OMNIFIN_SECURE_COOKIES: booleanString,
  OMNIFIN_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
});

export interface AppConfig {
  baseUrl: URL;
  databaseUrl: string;
  encryptionKey: Buffer;
  environment: "development" | "test" | "production";
  host: string;
  jellyfinInsecureHttpApproved: boolean;
  jellyfinUrl?: URL;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  port: number;
  recoverySecret?: string;
  secureCookies: boolean;
  session: {
    absoluteTtlMs: number;
    inactivityTtlMs: number;
    rotationIntervalMs: number;
  };
  trustProxyHops: number;
}

function secretFromEnvironment(
  value: string | undefined,
  file: string | undefined,
  conflictCode: StartupFailureCode,
  unreadableFileCode: StartupFailureCode,
) {
  if (value && file) throw new StartupError(conflictCode);
  if (!file) return value;

  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new StartupError(unreadableFileCode, { cause: error });
  }
}

function decodeEncryptionKey(encoded: string | undefined) {
  if (!encoded) throw new StartupError("encryption_key_missing");
  const canonicalBase64 =
    encoded.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded);
  const key = Buffer.from(encoded, "base64");
  if (!canonicalBase64 || key.length !== 32 || key.toString("base64") !== encoded) {
    throw new StartupError("encryption_key_invalid");
  }
  return key;
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
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new StartupError("jellyfin_configuration_invalid");
  }
  if (url.protocol === "http:" && !insecureHttpApproved) {
    throw new StartupError("jellyfin_configuration_invalid");
  }
  return url;
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
  if (parsed.OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED && !parsed.OMNIFIN_JELLYFIN_URL) {
    throw new StartupError("jellyfin_configuration_invalid");
  }
  const jellyfinUrl = parsed.OMNIFIN_JELLYFIN_URL
    ? canonicalJellyfinUrl(
        parsed.OMNIFIN_JELLYFIN_URL,
        parsed.OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED,
      )
    : undefined;

  return {
    baseUrl: canonicalBaseUrl(parsed.OMNIFIN_BASE_URL, parsed.NODE_ENV),
    databaseUrl: parsed.OMNIFIN_DATABASE_URL,
    encryptionKey: decodeEncryptionKey(encryptionKey),
    environment: parsed.NODE_ENV,
    host: parsed.OMNIFIN_HOST,
    jellyfinInsecureHttpApproved: parsed.OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED,
    ...(jellyfinUrl ? { jellyfinUrl } : {}),
    logLevel: parsed.OMNIFIN_LOG_LEVEL,
    port: parsed.OMNIFIN_PORT,
    ...(recoverySecret ? { recoverySecret } : {}),
    secureCookies: parsed.OMNIFIN_SECURE_COOKIES || parsed.NODE_ENV === "production",
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 12 * 60 * 60 * 1_000,
      rotationIntervalMs: 15 * 60 * 1_000,
    },
    trustProxyHops: parsed.OMNIFIN_TRUST_PROXY_HOPS,
  };
}
