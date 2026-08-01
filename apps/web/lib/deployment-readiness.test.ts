import {
  deploymentReadinessCheckIds,
  deploymentReadinessResponseSchema,
} from "@omnifin/contracts/deployment";
import { describe, expect, it, vi } from "vitest";

import { loadDeploymentReadiness } from "./deployment-readiness";

function readiness() {
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

describe("loadDeploymentReadiness", () => {
  it("loads the normalized no-store deployment resource", async () => {
    const request = vi.fn(async () => jsonResponse(readiness()));

    await expect(loadDeploymentReadiness({ request })).resolves.toEqual({
      readiness: readiness(),
      status: "ready",
    });
    expect(request).toHaveBeenCalledWith("/api/admin/setup/deployment", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    await expect(
      loadDeploymentReadiness({
        request: async () => jsonResponse({ error: { code: "private-error" } }, status),
      }),
    ).resolves.toEqual({ status: expected });
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
    await expect(loadDeploymentReadiness({ request })).resolves.toEqual({
      status: "unavailable",
    });
  });
});
