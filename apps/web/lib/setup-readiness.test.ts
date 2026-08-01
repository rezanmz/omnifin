import { setupReadinessResponseSchema, setupReadinessStepIds } from "@omnifin/contracts/setup";
import {
  deploymentReadinessCheckIds,
  deploymentReadinessResponseSchema,
} from "@omnifin/contracts/deployment";
import { describe, expect, it, vi } from "vitest";

import { loadSetupReadiness } from "./setup-readiness";

function readiness() {
  return setupReadinessResponseSchema.parse({
    coreReady: true,
    essentialCompleted: 2,
    essentialTotal: 2,
    generatedAt: "2026-08-01T12:00:00.000Z",
    optionalReady: 0,
    optionalTotal: 6,
    steps: setupReadinessStepIds.map((id, index) => ({
      configuredCount: index < 2 ? 1 : 0,
      id,
      readyCount: index < 2 ? 1 : 0,
      state: index < 2 ? "ready" : "not_configured",
    })),
  });
}

function deploymentReadiness() {
  return deploymentReadinessResponseSchema.parse({
    checks: deploymentReadinessCheckIds.map((id) => ({ id, state: "ready" })),
    generatedAt: "2026-08-01T12:00:00.000Z",
    readyCount: 4,
    state: "ready",
    total: 4,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("loadSetupReadiness", () => {
  it("loads normalized setup resources in parallel without fetching administrative records", async () => {
    const request = vi.fn(async (path: string) =>
      jsonResponse(path.endsWith("/deployment") ? deploymentReadiness() : readiness()),
    );

    const outcome = await loadSetupReadiness({ request });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("/api/admin/setup/readiness", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(request).toHaveBeenCalledWith("/api/admin/setup/deployment", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(outcome).toEqual({
      deployment: { readiness: deploymentReadiness(), status: "ready" },
      readiness: readiness(),
      status: "ready",
    });
    expect(JSON.stringify(outcome)).not.toMatch(/csrf|baseUrl|connectorId|issuer|externalUserId/u);
  });

  it("preserves connector readiness when only deployment posture is unavailable", async () => {
    const outcome = await loadSetupReadiness({
      request: async (path) =>
        path.endsWith("/deployment") ? jsonResponse({}, 503) : jsonResponse(readiness()),
    });

    expect(outcome).toEqual({
      deployment: { status: "unavailable" },
      readiness: readiness(),
      status: "ready",
    });
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    const outcome = await loadSetupReadiness({
      request: async () => jsonResponse({ error: { code: "private-error" } }, status),
    });

    expect(outcome).toEqual({ status: expected });
  });

  it.each([
    ["server rejection", async () => jsonResponse({}, 503)],
    ["network rejection", async () => Promise.reject(new Error("private network detail"))],
    ["unreadable JSON", async () => new Response("not-json", { status: 200 })],
    [
      "contract expansion",
      async () => jsonResponse({ ...readiness(), baseUrl: "https://private.example.test" }),
    ],
  ])("fails closed for %s", async (_label, request) => {
    await expect(loadSetupReadiness({ request })).resolves.toEqual({ status: "unavailable" });
  });
});
