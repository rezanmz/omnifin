import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { runtimeIdentityRoutes } from "../src/runtime/identity-routes.js";
import { loadRuntimeIdentity } from "../src/runtime/identity.js";
import { startupFailureDetails } from "../src/startup-error.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const applications: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("loadRuntimeIdentity", () => {
  it("marks local builds as development and unverified", () => {
    expect(loadRuntimeIdentity({})).toEqual({
      channel: "development",
      license: "AGPL-3.0-only",
      revision: null,
      schemaVersion: 1,
      sourceUrl: "https://github.com/rezanmz/omnifin",
      verification: "development",
      version: "0.0.0-dev",
    });
  });

  it("binds a stable release to its immutable corresponding source", () => {
    expect(
      loadRuntimeIdentity({
        OMNIFIN_BUILD_CHANNEL: "stable",
        OMNIFIN_BUILD_REVISION: revision,
        OMNIFIN_BUILD_SOURCE_URL: `https://github.com/rezanmz/omnifin/tree/${revision}`,
        OMNIFIN_BUILD_VERSION: "1.2.3",
      }),
    ).toMatchObject({
      channel: "stable",
      revision,
      verification: "verified",
      version: "1.2.3",
    });
  });

  it.each([
    {
      OMNIFIN_BUILD_CHANNEL: "stable",
      OMNIFIN_BUILD_VERSION: "1.2.3",
    },
    {
      OMNIFIN_BUILD_CHANNEL: "edge",
      OMNIFIN_BUILD_REVISION: revision,
      OMNIFIN_BUILD_SOURCE_URL: "https://github.com/rezanmz/omnifin/tree/main",
      OMNIFIN_BUILD_VERSION: "1.2.3-edge",
    },
    {
      OMNIFIN_BUILD_CHANNEL: "stable",
      OMNIFIN_BUILD_REVISION: revision,
      OMNIFIN_BUILD_SOURCE_URL: `https://github.com/rezanmz/omnifin/tree/${revision}`,
      OMNIFIN_BUILD_VERSION: "latest",
    },
  ])("rejects unverifiable published metadata without echoing it", (environment) => {
    let failure: unknown;
    try {
      loadRuntimeIdentity(environment);
    } catch (error) {
      failure = error;
    }

    expect(startupFailureDetails(failure)).toEqual({
      category: "configuration",
      code: "runtime_identity_invalid",
    });
    expect((failure as Error).message).not.toContain(JSON.stringify(environment));
  });
});

describe("runtimeIdentityRoutes", () => {
  it("serves a cacheable public identity without creating a session", async () => {
    const app = Fastify();
    applications.push(app);
    const identity = loadRuntimeIdentity({});
    await app.register(runtimeIdentityRoutes, { identity });

    const response = await app.inject({
      headers: { cookie: "omnifin_session=not-a-session" },
      method: "GET",
      url: "/v1/runtime",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(identity);
    expect(response.headers["cache-control"]).toBe("public, max-age=3600, stale-if-error=86400");
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
