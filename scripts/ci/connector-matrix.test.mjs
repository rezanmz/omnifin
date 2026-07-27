import assert from "node:assert/strict";
import test from "node:test";

import { planConnectorServices, selectConnectorServices } from "./connector-matrix.mjs";
import { SERVICES, validateReadinessLedger } from "../integration/readiness.mjs";

const readiness = validateReadinessLedger({
  schemaVersion: 1,
  services: Object.fromEntries(
    SERVICES.map((service) => [
      service,
      {
        fixture: service === "authentik" ? "pending" : "ready",
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
  assert.equal(selected.includes("oidc"), true);
  assert.equal(selected.includes("jellyfin"), true);
});

test("later global changes run ready fixtures and report pending fixtures separately", () => {
  const plan = planConnectorServices(
    ["scripts/integration/readiness.json", "apps/gateway/src/auth/provider-routes.ts"],
    { readiness },
  );
  assert.equal(plan.services.includes("oidc"), true);
  assert.equal(plan.services.includes("authentik"), false);
  assert.equal(plan.services.includes("jellyfin"), true);
  assert.deepEqual(plan.deferredServices, ["authentik"]);
});

test("shared auth changes strictly run ready identity fixtures without claiming pending coverage", () => {
  assert.deepEqual(planConnectorServices(["packages/contracts/src/auth.ts"], { readiness }), {
    deferredServices: ["authentik"],
    services: ["oidc", "jellyfin"],
  });
});

test("a readiness promotion enters the strict matrix in the same pull request", () => {
  const promoted = structuredClone(readiness);
  promoted.services.authentik.fixture = "ready";
  assert.deepEqual(
    planConnectorServices(
      ["scripts/integration/readiness.json", "apps/gateway/src/auth/oidc-provider.ts"],
      { readiness: promoted },
    ),
    {
      deferredServices: [],
      services: [
        "oidc",
        "authentik",
        "jellyfin",
        "seerr",
        "radarr",
        "sonarr",
        "prowlarr",
        "bazarr",
        "qbittorrent",
        "sabnzbd",
      ],
    },
  );
});

test("pending-only changes retain the established strict fixture baseline", () => {
  const selected = selectConnectorServices(["scripts/integration/authentik/blueprint.yaml"], {
    readiness,
  });
  assert.equal(selected.includes("authentik"), false);
  assert.deepEqual(
    selected,
    SERVICES.filter((service) => service !== "authentik"),
  );
});
