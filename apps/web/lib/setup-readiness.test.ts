import { setupReadinessResponseSchema, setupReadinessStepIds } from "@omnifin/contracts/setup";
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("loadSetupReadiness", () => {
  it("loads one normalized no-store resource without fetching administrative records", async () => {
    const request = vi.fn(async () => jsonResponse(readiness()));

    const outcome = await loadSetupReadiness({ request });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/api/admin/setup/readiness", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(outcome).toEqual({ readiness: readiness(), status: "ready" });
    expect(JSON.stringify(outcome)).not.toMatch(/csrf|baseUrl|connectorId|issuer|externalUserId/u);
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
