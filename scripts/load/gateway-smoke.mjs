#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const executeFile = promisify(execFile);
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PROFILE = Object.freeze({
  concurrency: 80,
  requestCount: 20_000,
  warmupCount: 1_600,
});
const BUDGETS = Object.freeze({
  errorRate: 0,
  maxLatencyMs: 1_000,
  memoryGrowthMiB: 192,
  peakMemoryMiB: 384,
  p95LatencyMs: 150,
  p99LatencyMs: 400,
  throughputRequestsPerSecond: 250,
});
const ROUTES = Object.freeze([
  { expectedStatus: 200, path: "/healthz", weight: 11 },
  { expectedStatus: 200, path: "/v1/auth/session", weight: 4 },
  { expectedStatus: 200, path: "/v1/auth/providers", weight: 4 },
  { expectedStatus: 200, path: "/readyz", weight: 1 },
]);
const WORKLOAD = ROUTES.flatMap((route) => Array.from({ length: route.weight }, () => route));

class LoadFailure extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "LoadFailure";
    this.code = code;
  }
}

function parseArguments(arguments_) {
  const options = { reportPath: undefined };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--report") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--") || options.reportPath) {
        throw new LoadFailure("usage_invalid");
      }
      const reportPath = resolve(REPOSITORY_ROOT, value);
      const reportRelativePath = relative(REPOSITORY_ROOT, reportPath);
      if (reportRelativePath.startsWith("..") || isAbsolute(reportRelativePath)) {
        throw new LoadFailure("usage_invalid");
      }
      options.reportPath = reportPath;
      index += 1;
      continue;
    }
    throw new LoadFailure("usage_invalid");
  }
  return options;
}

export function percentile(sortedValues, proportion) {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * proportion) - 1);
  return sortedValues[Math.min(index, sortedValues.length - 1)];
}

export function evaluateBudgets(metrics, budgets = BUDGETS) {
  const failures = [];
  if (metrics.errorRate > budgets.errorRate) failures.push("error_rate");
  if (metrics.latencyMs.p95 > budgets.p95LatencyMs) failures.push("latency_p95");
  if (metrics.latencyMs.p99 > budgets.p99LatencyMs) failures.push("latency_p99");
  if (metrics.latencyMs.max > budgets.maxLatencyMs) failures.push("latency_max");
  if (metrics.throughputRequestsPerSecond < budgets.throughputRequestsPerSecond) {
    failures.push("throughput");
  }
  if (metrics.memoryMiB.peak > budgets.peakMemoryMiB) failures.push("memory_peak");
  if (metrics.memoryMiB.growth > budgets.memoryGrowthMiB) failures.push("memory_growth");
  return failures;
}

export function workloadRoute(requestIndex, concurrency = PROFILE.concurrency) {
  const clientNumber = requestIndex % concurrency;
  const clientIteration = Math.floor(requestIndex / concurrency);
  return WORKLOAD[(clientIteration + clientNumber) % WORKLOAD.length];
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new LoadFailure("port_reservation_failed");
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

async function waitForGateway(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new LoadFailure("gateway_exited_early");
    try {
      const response = await fetch(`${baseUrl}/readyz`, {
        headers: { "x-forwarded-for": "198.18.255.1" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // Startup is allowed to refuse connections until the deadline.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new LoadFailure("gateway_start_timeout");
}

async function residentMemoryMiB(processId) {
  try {
    const { stdout } = await executeFile("ps", ["-o", "rss=", "-p", String(processId)], {
      timeout: 2_000,
    });
    const kibibytes = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(kibibytes) || kibibytes < 1) return undefined;
    return kibibytes / 1_024;
  } catch {
    return undefined;
  }
}

async function requestOnce(baseUrl, route, clientNumber) {
  const startedAt = process.hrtime.bigint();
  let response;
  try {
    response = await fetch(`${baseUrl}${route.path}`, {
      headers: {
        accept: "application/json",
        "x-forwarded-for": `198.18.${Math.floor(clientNumber / 254)}.${(clientNumber % 254) + 1}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    await response.arrayBuffer();
  } catch {
    return { durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000, status: 0 };
  }
  return {
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    status: response.status,
  };
}

async function runWarmup(baseUrl) {
  const measurements = new Array(PROFILE.warmupCount);
  await Promise.all(
    Array.from({ length: PROFILE.concurrency }, async (_, clientNumber) => {
      for (let index = clientNumber; index < PROFILE.warmupCount; index += PROFILE.concurrency) {
        measurements[index] = await requestOnce(baseUrl, workloadRoute(index), clientNumber);
      }
    }),
  );
  if (measurements.some(({ status }, index) => status !== workloadRoute(index).expectedStatus)) {
    throw new LoadFailure("warmup_failed");
  }
}

async function runMeasuredWorkload(baseUrl, child) {
  const measurements = new Array(PROFILE.requestCount);
  const baselineMemoryMiB = await residentMemoryMiB(child.pid);
  if (baselineMemoryMiB === undefined) throw new LoadFailure("memory_measurement_failed");
  let peakMemoryMiB = baselineMemoryMiB;
  let memorySample = Promise.resolve();
  const memorySampler = setInterval(() => {
    memorySample = memorySample.then(async () => {
      const value = await residentMemoryMiB(child.pid);
      if (value !== undefined) peakMemoryMiB = Math.max(peakMemoryMiB, value);
    });
  }, 100);
  memorySampler.unref();

  const startedAt = process.hrtime.bigint();
  try {
    await Promise.all(
      Array.from({ length: PROFILE.concurrency }, async (_, clientNumber) => {
        for (let index = clientNumber; index < PROFILE.requestCount; index += PROFILE.concurrency) {
          measurements[index] = await requestOnce(baseUrl, workloadRoute(index), clientNumber);
        }
      }),
    );
  } finally {
    clearInterval(memorySampler);
  }
  const finishedAt = process.hrtime.bigint();
  await memorySample;
  const durationSeconds = Number(finishedAt - startedAt) / 1_000_000_000;
  const finalMemoryMiB = await residentMemoryMiB(child.pid);
  if (finalMemoryMiB === undefined) throw new LoadFailure("memory_measurement_failed");
  peakMemoryMiB = Math.max(peakMemoryMiB, finalMemoryMiB);

  const latencies = measurements
    .map(({ durationMs }) => durationMs)
    .sort((left, right) => left - right);
  const statusCounts = {};
  let errors = 0;
  for (let index = 0; index < measurements.length; index += 1) {
    const measurement = measurements[index];
    const route = workloadRoute(index);
    statusCounts[measurement.status] = (statusCounts[measurement.status] ?? 0) + 1;
    if (measurement.status !== route.expectedStatus) errors += 1;
  }

  return {
    durationSeconds,
    errorRate: errors / PROFILE.requestCount,
    errors,
    latencyMs: {
      max: latencies.at(-1) ?? 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    memoryMiB: {
      baseline: baselineMemoryMiB,
      growth: Math.max(0, peakMemoryMiB - baselineMemoryMiB),
      peak: peakMemoryMiB,
    },
    statusCounts,
    throughputRequestsPerSecond: PROFILE.requestCount / durationSeconds,
  };
}

async function stopGateway(child) {
  if (child.exitCode !== null) return;
  const exitPromise = new Promise((resolvePromise) =>
    child.once("exit", () => resolvePromise(true)),
  );
  child.kill("SIGTERM");
  const exited = await Promise.race([
    exitPromise,
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 5_000)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      exitPromise,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
    ]);
  }
}

function roundedMetrics(metrics) {
  const rounded = structuredClone(metrics);
  rounded.durationSeconds = Number(metrics.durationSeconds.toFixed(3));
  rounded.errorRate = Number(metrics.errorRate.toFixed(6));
  rounded.throughputRequestsPerSecond = Number(metrics.throughputRequestsPerSecond.toFixed(1));
  for (const key of Object.keys(rounded.latencyMs)) {
    rounded.latencyMs[key] = Number(metrics.latencyMs[key].toFixed(2));
  }
  for (const key of Object.keys(rounded.memoryMiB)) {
    rounded.memoryMiB[key] = Number(metrics.memoryMiB[key].toFixed(2));
  }
  return rounded;
}

async function writeReport(reportPath, report) {
  if (!reportPath) return;
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function main(options) {
  const temporaryDirectory = await mkdtemp(`${tmpdir()}/omnifin-load-`);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const gatewayArtifact = resolve(REPOSITORY_ROOT, "apps/gateway/dist/main.js");
  const child = spawn(process.execPath, [gatewayArtifact], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      OMNIFIN_BASE_URL: "http://localhost:3000",
      OMNIFIN_DATABASE_URL: `${temporaryDirectory}/omnifin.db`,
      OMNIFIN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      OMNIFIN_HOST: "127.0.0.1",
      OMNIFIN_INSECURE_LOOPBACK_PREVIEW: "true",
      OMNIFIN_LOG_LEVEL: "silent",
      OMNIFIN_PORT: String(port),
      OMNIFIN_SECURE_COOKIES: "false",
      OMNIFIN_TRUST_PROXY_HOPS: "1",
    },
    stdio: "ignore",
  });

  try {
    await waitForGateway(baseUrl, child);
    await runWarmup(baseUrl);
    const metrics = roundedMetrics(await runMeasuredWorkload(baseUrl, child));
    const budgetFailures = evaluateBudgets(metrics);
    const report = {
      budgets: BUDGETS,
      budgetFailures,
      metrics,
      profile: {
        ...PROFILE,
        clients: PROFILE.concurrency,
        routes: ROUTES.map(({ path, weight }) => ({ path, weight })),
      },
      schemaVersion: 1,
      status: budgetFailures.length === 0 ? "passed" : "failed",
    };
    await writeReport(options.reportPath, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (budgetFailures.length > 0) process.exitCode = 1;
  } finally {
    await stopGateway(child);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    await main(options);
  } catch (error) {
    const code = error instanceof LoadFailure ? error.code : "load_runner_failed";
    if (options?.reportPath) {
      try {
        await writeReport(options.reportPath, { code, schemaVersion: 1, status: "failed" });
      } catch {
        // The bounded stderr result remains available when artifact storage is unavailable.
      }
    }
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 1;
  }
}
