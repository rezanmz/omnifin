import assert from "node:assert/strict";
import test from "node:test";

import { selectConnectorServices } from "./connector-matrix.mjs";
import { SERVICES, validateReadinessLedger } from "../integration/readiness.mjs";

const readiness = validateReadinessLedger({
  schemaVersion: 1,
  services: Object.fromEntries(
    SERVICES.map((service) => [
      service,
      {
        fixture: ["oidc", "authentik"].includes(service) ? "pending" : "ready",
        live: "pending",
      },
    ]),
  ),
});

test("the empty bootstrap base runs established fixture coverage", () => {
  const selected = selectConnectorServices(
    ["scripts/integration/readiness.json", "apps/gateway/src/auth/provider-routes.ts"],
    { emptyBase: true, readiness },
  );
  assert.equal(selected.includes("oidc"), false);
  assert.equal(selected.includes("jellyfin"), true);
});

test("later global changes retain explicitly selected pending identity suites", () => {
  const selected = selectConnectorServices(
    ["scripts/integration/readiness.json", "apps/gateway/src/auth/provider-routes.ts"],
    { readiness },
  );
  assert.equal(selected.includes("oidc"), true);
  assert.equal(selected.includes("authentik"), true);
});

test("shared auth contract changes select all linked identity services", () => {
  assert.deepEqual(selectConnectorServices(["packages/contracts/src/auth.ts"], { readiness }), [
    "oidc",
    "authentik",
    "jellyfin",
  ]);
});
