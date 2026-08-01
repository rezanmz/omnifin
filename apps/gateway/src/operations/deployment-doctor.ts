import Database from "better-sqlite3";
import { constants as fsConstants, lstatSync } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { z } from "zod";

const PUBLIC_RESPONSE_TIMEOUT_MS = 5_000;
const PRIVATE_RESPONSE_MAX_BYTES = 2_048;
const IMMUTABLE_IMAGE_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const INSECURE_FILE_MODE_MASK = 0o077;

export const deploymentDoctorCheckIds = [
  "runtime",
  "image",
  "gateway",
  "public_boundary",
  "storage",
  "backup",
] as const;

const deploymentDoctorCheckIdSchema = z.enum(deploymentDoctorCheckIds);
const deploymentDoctorAttentionCodeSchema = z.enum([
  "backup_directory_not_private",
  "backup_directory_unavailable",
  "gateway_response_invalid",
  "gateway_unavailable",
  "gateway_unready",
  "image_reference_not_immutable",
  "public_headers_invalid",
  "public_origin_invalid",
  "public_origin_unavailable",
  "public_response_invalid",
  "runtime_not_production",
  "storage_integrity_failed",
  "storage_not_persistent",
  "storage_unavailable",
]);
const attentionCodesByCheck = {
  backup: ["backup_directory_not_private", "backup_directory_unavailable"],
  gateway: ["gateway_response_invalid", "gateway_unavailable", "gateway_unready"],
  image: ["image_reference_not_immutable"],
  public_boundary: [
    "public_headers_invalid",
    "public_origin_invalid",
    "public_origin_unavailable",
    "public_response_invalid",
  ],
  runtime: ["runtime_not_production"],
  storage: ["storage_integrity_failed", "storage_not_persistent", "storage_unavailable"],
} as const satisfies Record<
  (typeof deploymentDoctorCheckIds)[number],
  readonly z.infer<typeof deploymentDoctorAttentionCodeSchema>[]
>;

export const deploymentDoctorCheckSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ id: deploymentDoctorCheckIdSchema, state: z.literal("ready") }),
    z.strictObject({
      code: deploymentDoctorAttentionCodeSchema,
      id: deploymentDoctorCheckIdSchema,
      state: z.literal("attention"),
    }),
  ])
  .superRefine((check, context) => {
    if (
      check.state === "attention" &&
      !(attentionCodesByCheck[check.id] as readonly string[]).includes(check.code)
    ) {
      context.addIssue({ code: "custom", message: "attention code does not match check" });
    }
  });

export const deploymentDoctorReportSchema = z
  .strictObject({
    checks: z.array(deploymentDoctorCheckSchema).length(deploymentDoctorCheckIds.length),
    generatedAt: z.iso.datetime({ offset: true }),
    readyCount: z.int().nonnegative().max(deploymentDoctorCheckIds.length),
    schemaVersion: z.literal(1),
    state: z.enum(["attention", "ready"]),
    total: z.literal(deploymentDoctorCheckIds.length),
  })
  .superRefine((report, context) => {
    const checksAreOrdered = report.checks.every(
      (check, index) => check.id === deploymentDoctorCheckIds[index],
    );
    const readyCount = report.checks.filter(({ state }) => state === "ready").length;
    const expectedState = readyCount === report.checks.length ? "ready" : "attention";
    if (!checksAreOrdered || report.readyCount !== readyCount || report.state !== expectedState) {
      context.addIssue({ code: "custom", message: "report summary does not match checks" });
    }
  });

export type DeploymentDoctorCheck = z.infer<typeof deploymentDoctorCheckSchema>;
export type DeploymentDoctorReport = z.infer<typeof deploymentDoctorReportSchema>;

export interface DeploymentDoctorOptions {
  backupDirectory: string;
  baseUrl?: string;
  databasePath: string;
  environment?: string;
  gatewayHealthUrl?: string;
  gatewayReadyUrl?: string;
  imageReference?: string;
}

export interface DeploymentDoctorDependencies {
  clock?: () => Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type AttentionCode = z.infer<typeof deploymentDoctorAttentionCodeSchema>;
type CheckId = z.infer<typeof deploymentDoctorCheckIdSchema>;

const gatewayHealthSchema = z.strictObject({ status: z.literal("ok") });
const gatewayReadySchema = z.strictObject({
  checks: z.strictObject({ database: z.literal("ok") }),
  status: z.literal("ready"),
});

function ready(id: CheckId): DeploymentDoctorCheck {
  return { id, state: "ready" };
}

function attention(id: CheckId, code: AttentionCode): DeploymentDoctorCheck {
  return { code, id, state: "attention" };
}

function isPersistentDatabase(databasePath: string) {
  const normalized = databasePath.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    normalized !== ":memory:" &&
    !normalized.startsWith("file::memory:") &&
    !/[?&]mode=memory(?:&|$)/u.test(normalized)
  );
}

function canonicalHttpsOrigin(rawValue: string | undefined) {
  if (!rawValue) return undefined;
  try {
    const url = new URL(rawValue);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function canonicalPrivateEndpoint(rawValue: string | undefined, expectedPath: string) {
  if (!rawValue) return undefined;
  try {
    const url = new URL(rawValue);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== expectedPath ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

interface TimedResponse {
  dispose: () => void;
  response: Response;
}

async function fetchWithTimeout(
  fetchImplementation: typeof fetch,
  url: URL,
  timeoutMs: number,
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    return {
      dispose: () => {
        clearTimeout(timeout);
        controller.abort();
      },
      response,
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function readBoundedJson(response: Response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > PRIVATE_RESPONSE_MAX_BYTES
    ) {
      throw new Error("response_invalid");
    }
  }

  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("response_invalid");
  }

  if (!response.body) throw new Error("response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > PRIVATE_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error("response_invalid");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks, length).toString("utf8");
  return JSON.parse(body) as unknown;
}

function hasRequiredPublicHeaders(headers: Headers) {
  const contentSecurityPolicy = new Set(
    (headers.get("content-security-policy") ?? "")
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean),
  );
  const requiredCspDirectives = [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ];
  if (!requiredCspDirectives.every((directive) => contentSecurityPolicy.has(directive))) {
    return false;
  }

  const hsts = new Set(
    (headers.get("strict-transport-security") ?? "")
      .toLowerCase()
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean),
  );
  const maxAge = [...hsts]
    .map((directive) => /^max-age=(\d+)$/u.exec(directive)?.[1])
    .find(Boolean);
  if (!maxAge || Number(maxAge) < 31_536_000 || !hsts.has("includesubdomains")) return false;

  const permissionsPolicy = new Set(
    (headers.get("permissions-policy") ?? "")
      .split(",")
      .map((directive) => directive.trim())
      .filter(Boolean),
  );
  if (
    !["camera=()", "geolocation=()", "microphone=()", "payment=()", "usb=()"].every((directive) =>
      permissionsPolicy.has(directive),
    )
  ) {
    return false;
  }

  return (
    headers.get("referrer-policy") === "strict-origin-when-cross-origin" &&
    headers.get("x-content-type-options")?.toLowerCase() === "nosniff" &&
    headers.get("x-frame-options")?.toUpperCase() === "DENY"
  );
}

async function inspectGateway(
  options: DeploymentDoctorOptions,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<DeploymentDoctorCheck> {
  const healthUrl = canonicalPrivateEndpoint(options.gatewayHealthUrl, "/healthz");
  const readyUrl = canonicalPrivateEndpoint(options.gatewayReadyUrl, "/readyz");
  if (!healthUrl || !readyUrl || healthUrl.origin !== readyUrl.origin) {
    return attention("gateway", "gateway_unavailable");
  }

  const [healthResult, readyResult] = await Promise.allSettled([
    fetchWithTimeout(fetchImplementation, healthUrl, timeoutMs),
    fetchWithTimeout(fetchImplementation, readyUrl, timeoutMs),
  ]);
  if (healthResult.status === "rejected" || readyResult.status === "rejected") {
    if (healthResult.status === "fulfilled") {
      healthResult.value.dispose();
    }
    if (readyResult.status === "fulfilled") {
      readyResult.value.dispose();
    }
    return attention("gateway", "gateway_unavailable");
  }
  const healthRequest = healthResult.value;
  const readyRequest = readyResult.value;
  const healthResponse = healthRequest.response;
  const readyResponse = readyRequest.response;

  try {
    if (!healthResponse.ok || !readyResponse.ok) {
      return !healthResponse.ok
        ? attention("gateway", "gateway_unavailable")
        : attention("gateway", "gateway_unready");
    }
    const [healthBody, readyBody] = await Promise.all([
      readBoundedJson(healthResponse),
      readBoundedJson(readyResponse),
    ]);
    if (!gatewayHealthSchema.safeParse(healthBody).success) {
      return attention("gateway", "gateway_response_invalid");
    }
    if (!gatewayReadySchema.safeParse(readyBody).success) {
      return attention("gateway", "gateway_response_invalid");
    }
  } catch {
    return attention("gateway", "gateway_response_invalid");
  } finally {
    healthRequest.dispose();
    readyRequest.dispose();
  }

  return ready("gateway");
}

async function inspectPublicBoundary(
  rawBaseUrl: string | undefined,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<DeploymentDoctorCheck> {
  const origin = canonicalHttpsOrigin(rawBaseUrl);
  if (!origin) return attention("public_boundary", "public_origin_invalid");
  const healthUrl = new URL("healthz", origin);

  let request: TimedResponse;
  try {
    request = await fetchWithTimeout(fetchImplementation, healthUrl, timeoutMs);
  } catch {
    return attention("public_boundary", "public_origin_unavailable");
  }

  try {
    const response = request.response;
    if (!response.ok || response.url !== healthUrl.href) {
      return attention("public_boundary", "public_response_invalid");
    }
    if (!hasRequiredPublicHeaders(response.headers)) {
      return attention("public_boundary", "public_headers_invalid");
    }
    return ready("public_boundary");
  } finally {
    request.dispose();
  }
}

function inspectStorage(databasePath: string): DeploymentDoctorCheck {
  if (!isPersistentDatabase(databasePath)) {
    return attention("storage", "storage_not_persistent");
  }

  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(databasePath);
  } catch {
    return attention("storage", "storage_unavailable");
  }
  if (!metadata.isFile()) return attention("storage", "storage_unavailable");

  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, {
      fileMustExist: true,
      readonly: true,
      timeout: 1_000,
    });
  } catch {
    return attention("storage", "storage_unavailable");
  }

  try {
    const quickCheck = database.pragma("quick_check(1)") as Array<Record<string, unknown>>;
    const foreignKeyFailures = database.pragma("foreign_key_check") as Array<
      Record<string, unknown>
    >;
    const migrationTable = database
      .prepare(
        "select count(*) as count from sqlite_schema where type = 'table' and name = '__drizzle_migrations'",
      )
      .get() as { count?: unknown } | undefined;
    const migrationCount =
      migrationTable?.count === 1
        ? (database.prepare("select count(*) as count from __drizzle_migrations").get() as
            { count?: unknown } | undefined)
        : undefined;
    if (
      quickCheck.length !== 1 ||
      quickCheck[0]?.quick_check !== "ok" ||
      foreignKeyFailures.length !== 0 ||
      typeof migrationCount?.count !== "number" ||
      !Number.isSafeInteger(migrationCount.count) ||
      migrationCount.count < 1
    ) {
      return attention("storage", "storage_integrity_failed");
    }
    return ready("storage");
  } catch {
    return attention("storage", "storage_integrity_failed");
  } finally {
    database?.close();
  }
}

async function inspectBackupDirectory(backupDirectory: string): Promise<DeploymentDoctorCheck> {
  try {
    const metadata = await lstat(backupDirectory);
    if (!metadata.isDirectory()) return attention("backup", "backup_directory_unavailable");
    if ((metadata.mode & INSECURE_FILE_MODE_MASK) !== 0) {
      return attention("backup", "backup_directory_not_private");
    }
    await access(backupDirectory, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    return ready("backup");
  } catch {
    return attention("backup", "backup_directory_unavailable");
  }
}

export async function runDeploymentDoctor(
  options: DeploymentDoctorOptions,
  dependencies: DeploymentDoctorDependencies = {},
): Promise<DeploymentDoctorReport> {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? PUBLIC_RESPONSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PUBLIC_RESPONSE_TIMEOUT_MS) {
    throw new Error("deployment_doctor_configuration_invalid");
  }

  const [gateway, publicBoundary, backup] = await Promise.all([
    inspectGateway(options, fetchImplementation, timeoutMs),
    inspectPublicBoundary(options.baseUrl, fetchImplementation, timeoutMs),
    inspectBackupDirectory(options.backupDirectory),
  ]);
  const checks: DeploymentDoctorCheck[] = [
    options.environment === "production"
      ? ready("runtime")
      : attention("runtime", "runtime_not_production"),
    options.imageReference && IMMUTABLE_IMAGE_PATTERN.test(options.imageReference)
      ? ready("image")
      : attention("image", "image_reference_not_immutable"),
    gateway,
    publicBoundary,
    inspectStorage(options.databasePath),
    backup,
  ];

  const generatedAt = (dependencies.clock ?? (() => new Date()))();
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new Error("deployment_doctor_integrity_failure");
  }
  const readyCount = checks.filter(({ state }) => state === "ready").length;
  return deploymentDoctorReportSchema.parse({
    checks,
    generatedAt: generatedAt.toISOString(),
    readyCount,
    schemaVersion: 1,
    state: readyCount === checks.length ? "ready" : "attention",
    total: checks.length,
  });
}
