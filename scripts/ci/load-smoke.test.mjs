import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";
import {
  BUDGETS,
  evaluateBudgets,
  HOSTED_BASELINE_MEMORY_ALLOWANCE_MIB,
  percentile,
  workloadRoute,
} from "../load/gateway-smoke.mjs";

test("load percentiles select the upper observation at each boundary", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
});

test("load budgets report every exceeded resource dimension", () => {
  const failures = evaluateBudgets(
    {
      errorRate: 0.01,
      latencyMs: { max: 1_001, p95: 151, p99: 401 },
      memoryMiB: { growth: 65, peak: 257 },
      throughputRequestsPerSecond: 249,
    },
    {
      errorRate: 0,
      maxLatencyMs: 1_000,
      memoryGrowthMiB: 64,
      peakMemoryMiB: 256,
      p95LatencyMs: 150,
      p99LatencyMs: 400,
      throughputRequestsPerSecond: 250,
    },
  );

  assert.deepEqual(failures, [
    "error_rate",
    "latency_p95",
    "latency_p99",
    "latency_max",
    "throughput",
    "memory_peak",
    "memory_growth",
  ]);
});

test("the absolute memory ceiling preserves the hosted baseline and growth guards", () => {
  assert.equal(HOSTED_BASELINE_MEMORY_ALLOWANCE_MIB, 320);
  assert.equal(
    BUDGETS.peakMemoryMiB,
    HOSTED_BASELINE_MEMORY_ALLOWANCE_MIB + BUDGETS.memoryGrowthMiB,
  );
  assert.equal(BUDGETS.peakMemoryMiB, 512);
  assert.equal(BUDGETS.memoryGrowthMiB, 192);
});

test("the workload stays below route and global limits for every modeled client", () => {
  const routeLimits = new Map([
    ["/readyz", 20],
    ["/v1/auth/providers", 60],
    ["/v1/auth/session", 120],
  ]);
  const clients = Array.from({ length: 80 }, () => new Map());

  for (let requestIndex = 0; requestIndex < 20_000; requestIndex += 1) {
    const client = clients[requestIndex % clients.length];
    const path = workloadRoute(requestIndex).path;
    client.set(path, (client.get(path) ?? 0) + 1);
  }

  for (const client of clients) {
    const total = [...client.values()].reduce((sum, value) => sum + value, 0) + 20;
    assert.ok(total < 300);
    for (const [path, limit] of routeLimits) {
      assert.ok((client.get(path) ?? 0) < limit, `${path} exceeded its modeled client budget`);
    }
  }
});

test("the protected CI aggregate requires the load report", () => {
  const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const document = parse(source);
  const load = document.jobs.load;

  assert.equal(load.name, "Gateway load and resilience");
  assert.equal(load["timeout-minutes"], 10);
  assert.ok(document.jobs.gate.needs.includes("load"));
  assert.equal(
    load.steps.find((step) => step.name === "Enforce gateway load budgets").run,
    "pnpm load:gateway --report artifacts/load/gateway.json",
  );
  const upload = load.steps.find((step) => step.name === "Upload gateway load report");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, "artifacts/load/gateway.json");
  assert.equal(upload.with["if-no-files-found"], "error");
});
