import { connectorHealthSchema } from "@omnifin/contracts/connectors";
import { describe, expect, it } from "vitest";

import { BazarrAdapter } from "../src/adapters/bazarr.js";
import { JellyfinAdapter } from "../src/adapters/jellyfin.js";
import { ProwlarrAdapter } from "../src/adapters/prowlarr.js";
import { QBittorrentAdapter } from "../src/adapters/qbittorrent.js";
import { RadarrAdapter } from "../src/adapters/radarr.js";
import { SabnzbdAdapter } from "../src/adapters/sabnzbd.js";
import { SeerrAdapter } from "../src/adapters/seerr.js";
import { SonarrAdapter } from "../src/adapters/sonarr.js";
import type { ConnectorAdapter, ConnectorTargetConfig } from "../src/types.js";
import { probeFixtures } from "./fixtures/probes.js";
import {
  createMockTransport,
  fixedClock,
  jsonResponse,
  publicResolver,
  type CapturedRequest,
} from "./helpers/mock-fetch.js";

const TEST_API_KEY = "fixture-api-key";

function target(
  service: string,
  transport: NonNullable<ConnectorTargetConfig["transport"]>,
): ConnectorTargetConfig {
  return {
    connectorId: `${service}-main`,
    displayName: service,
    baseUrl: `https://${service}.example.test/`,
    transport,
    resolveHost: publicResolver,
    clock: fixedClock(),
  };
}

interface ProbeCase {
  name: string;
  expectedPath: string;
  expectedVersion: string;
  expectedCapabilities?: readonly string[];
  response: unknown;
  create: (config: ConnectorTargetConfig) => ConnectorAdapter;
  assertRequest?: (request: CapturedRequest) => void;
}

interface CredentialReflectionCase {
  name: string;
  create: (config: ConnectorTargetConfig, credential: string) => ConnectorAdapter;
  responses: (version: string) => Response[];
  assertCredentialRequest?: (request: CapturedRequest, credential: string) => void;
}

const probeCases: ProbeCase[] = [
  {
    name: "jellyfin",
    expectedPath: "/System/Info/Public",
    expectedVersion: probeFixtures.jellyfin.Version,
    response: probeFixtures.jellyfin,
    create: (config) => new JellyfinAdapter(config),
  },
  {
    name: "seerr",
    expectedPath: "/api/v1/status",
    expectedVersion: probeFixtures.seerr.version,
    response: probeFixtures.seerr,
    create: (config) => new SeerrAdapter(config),
    assertRequest: (request) => {
      expect(request.init.headers.has("x-api-key")).toBe(false);
    },
  },
  {
    name: "radarr",
    expectedPath: "/api/v3/system/status",
    expectedVersion: probeFixtures.radarr.version,
    response: probeFixtures.radarr,
    expectedCapabilities: [
      "connector.health",
      "connector.version",
      "acquisition.history",
      "acquisition.search",
    ],
    create: (config) => new RadarrAdapter({ ...config, apiKey: TEST_API_KEY }),
    assertRequest: (request) => {
      expect(request.init.headers.get("x-api-key")).toBe(TEST_API_KEY);
    },
  },
  {
    name: "sonarr",
    expectedPath: "/api/v3/system/status",
    expectedVersion: probeFixtures.sonarr.version,
    response: probeFixtures.sonarr,
    expectedCapabilities: [
      "connector.health",
      "connector.version",
      "acquisition.history",
      "acquisition.search",
    ],
    create: (config) => new SonarrAdapter({ ...config, apiKey: TEST_API_KEY }),
    assertRequest: (request) => {
      expect(request.init.headers.get("x-api-key")).toBe(TEST_API_KEY);
    },
  },
  {
    name: "prowlarr",
    expectedPath: "/api/v1/system/status",
    expectedVersion: probeFixtures.prowlarr.version,
    response: probeFixtures.prowlarr,
    create: (config) => new ProwlarrAdapter({ ...config, apiKey: TEST_API_KEY }),
    assertRequest: (request) => {
      expect(request.init.headers.get("x-api-key")).toBe(TEST_API_KEY);
    },
  },
  {
    name: "bazarr",
    expectedPath: "/api/system/status",
    expectedVersion: probeFixtures.bazarr.data.bazarr_version,
    response: probeFixtures.bazarr,
    create: (config) => new BazarrAdapter({ ...config, apiKey: TEST_API_KEY }),
    assertRequest: (request) => {
      expect(request.init.headers.get("x-api-key")).toBe(TEST_API_KEY);
    },
  },
  {
    name: "sabnzbd",
    expectedPath: "/api",
    expectedVersion: probeFixtures.sabnzbd.version,
    response: probeFixtures.sabnzbd,
    create: (config) => new SabnzbdAdapter(config),
    assertRequest: (request) => {
      expect(request.url.searchParams.get("mode")).toBe("version");
      expect(request.url.searchParams.get("output")).toBe("json");
      expect(request.url.searchParams.has("apikey")).toBe(false);
    },
  },
];

const credentialReflectionCases: CredentialReflectionCase[] = [
  {
    name: "seerr",
    create: (config, credential) => new SeerrAdapter({ ...config, apiKey: credential }),
    responses: (version) => [jsonResponse({ version })],
    assertCredentialRequest: (request, credential) => {
      expect(request.init.headers.get("x-api-key")).toBe(credential);
    },
  },
  {
    name: "radarr",
    create: (config, credential) => new RadarrAdapter({ ...config, apiKey: credential }),
    responses: (version) => [jsonResponse({ version })],
  },
  {
    name: "sonarr",
    create: (config, credential) => new SonarrAdapter({ ...config, apiKey: credential }),
    responses: (version) => [jsonResponse({ version })],
  },
  {
    name: "prowlarr",
    create: (config, credential) => new ProwlarrAdapter({ ...config, apiKey: credential }),
    responses: (version) => [jsonResponse({ version })],
  },
  {
    name: "bazarr",
    create: (config, credential) => new BazarrAdapter({ ...config, apiKey: credential }),
    responses: (version) => [jsonResponse({ data: { bazarr_version: version } })],
  },
  {
    name: "sabnzbd",
    create: (config, credential) => new SabnzbdAdapter({ ...config, apiKey: credential }),
    responses: (version) => [jsonResponse({ version })],
    assertCredentialRequest: (request, credential) => {
      expect(request.url.searchParams.get("apikey")).toBe(credential);
    },
  },
  {
    name: "qbittorrent",
    create: (config, credential) =>
      new QBittorrentAdapter({
        ...config,
        username: "operator",
        password: credential,
      }),
    responses: (version) => [
      new Response("Ok.", { headers: { "set-cookie": "SID=fixture-session; Path=/; HttpOnly" } }),
      new Response(version),
    ],
  },
];

describe.each(probeCases)("$name adapter", (probeCase) => {
  it("performs a deterministic health/version read", async () => {
    const mock = createMockTransport([jsonResponse(probeCase.response)]);
    const adapter = probeCase.create(target(probeCase.name, mock.transport));

    const health = await adapter.probe();

    expect(health).toEqual(
      expect.objectContaining({
        connectorId: `${probeCase.name}-main`,
        service: probeCase.name,
        status: "healthy",
        checkedAt: "2026-07-25T12:00:00.000Z",
        latencyMs: 12,
        version: probeCase.expectedVersion,
        capabilities: probeCase.expectedCapabilities ?? ["connector.health", "connector.version"],
        failure: null,
      }),
    );
    expect(mock.requests[0]?.url.pathname).toBe(probeCase.expectedPath);
    if (mock.requests[0]) probeCase.assertRequest?.(mock.requests[0]);
  });
});

describe.each(credentialReflectionCases)("$name credential reflection", (probeCase) => {
  it.each([
    { credential: "7.8.9", version: "7.8.9", scenario: "exact" },
    {
      credential: "credential-reflection-token",
      version: "1.2.3+credential-reflection-token",
      scenario: "contained",
    },
  ])(
    "rejects a $scenario reflected credential without returning it",
    async ({ credential, version }) => {
      const mock = createMockTransport(probeCase.responses(version));
      const adapter = probeCase.create(target(probeCase.name, mock.transport), credential);

      const health = await adapter.probe();

      expect(health).toMatchObject({
        status: "degraded",
        version: null,
        failure: { code: "response_invalid", retryable: false },
      });
      expect(JSON.stringify(health)).not.toContain(credential);
      if (mock.requests[0]) probeCase.assertCredentialRequest?.(mock.requests[0], credential);
    },
  );
});

describe("qBittorrent adapter", () => {
  it("authenticates, keeps the SID internal, and reads the application version", async () => {
    const mock = createMockTransport([
      new Response("Ok.", { headers: { "set-cookie": "SID=fixture-session; Path=/; HttpOnly" } }),
      new Response("v5.1.2"),
    ]);
    const adapter = new QBittorrentAdapter({
      ...target("qbittorrent", mock.transport),
      username: "operator",
      password: "fixture-password",
    });

    const health = await adapter.probe();

    expect(health).toMatchObject({ status: "healthy", version: "v5.1.2", failure: null });
    expect(mock.requests.map(({ url }) => url.pathname)).toEqual([
      "/api/v2/auth/login",
      "/api/v2/app/version",
    ]);
    expect(mock.requests[1]?.init.headers.get("cookie")).toBe("SID=fixture-session");
    expect(JSON.stringify(health)).not.toContain("fixture-session");
    expect(JSON.stringify(health)).not.toContain("fixture-password");
  });

  it("returns a safe misconfiguration state for rejected credentials", async () => {
    const mock = createMockTransport([new Response("Fails.")]);
    const adapter = new QBittorrentAdapter({
      ...target("qbittorrent", mock.transport),
      username: "operator",
      password: "fixture-password",
    });

    const health = await adapter.probe();

    expect(health).toMatchObject({
      status: "misconfigured",
      version: null,
      failure: { code: "invalid_credentials", retryable: false },
    });
    expect(JSON.stringify(health)).not.toContain("fixture-password");
  });

  it("rejects a reflected username and negotiated session identifier", async () => {
    for (const version of ["1.2.3+operator", "1.2.3+fixture-session"]) {
      const mock = createMockTransport([
        new Response("Ok.", {
          headers: { "set-cookie": "SID=fixture-session; Path=/; HttpOnly" },
        }),
        new Response(version),
      ]);
      const adapter = new QBittorrentAdapter({
        ...target("qbittorrent", mock.transport),
        username: "operator",
        password: "fixture-password",
      });

      const health = await adapter.probe();

      expect(health).toMatchObject({
        status: "degraded",
        version: null,
        failure: { code: "response_invalid" },
      });
      expect(JSON.stringify(health)).not.toContain("operator");
      expect(JSON.stringify(health)).not.toContain("fixture-session");
    }
  });
});

describe("degraded adapter state", () => {
  it("normalizes schema drift without returning the raw payload", async () => {
    const rawPayload = { versionChangedTo: "secret-or-unsupported-shape" };
    const mock = createMockTransport([jsonResponse(rawPayload)]);
    const adapter = new RadarrAdapter({
      ...target("radarr", mock.transport),
      apiKey: TEST_API_KEY,
    });

    const health = await adapter.probe();

    expect(health).toMatchObject({
      status: "degraded",
      version: null,
      failure: { code: "response_invalid", retryable: false },
    });
    expect(JSON.stringify(health)).not.toContain("versionChangedTo");
    expect(JSON.stringify(health)).not.toContain("secret-or-unsupported-shape");
  });

  it("bounds an extreme upstream retry delay before returning contract-safe health", async () => {
    const mock = createMockTransport([
      new Response("", {
        status: 429,
        headers: { "retry-after": "999999999999999999999999999999" },
      }),
    ]);
    const adapter = new RadarrAdapter({
      ...target("radarr", mock.transport),
      apiKey: TEST_API_KEY,
    });

    const health = await adapter.probe();

    expect(health.failure?.retryAfterSeconds).toBe(86_400);
    expect(connectorHealthSchema.parse(health)).toEqual(health);
  });

  it("rejects a version field that contains markup or arbitrary text", async () => {
    const mock = createMockTransport([
      jsonResponse({ Version: "<script>not-a-version</script>", ProductName: "Jellyfin Server" }),
    ]);
    const adapter = new JellyfinAdapter(target("jellyfin", mock.transport));

    const health = await adapter.probe();

    expect(health).toMatchObject({
      status: "degraded",
      version: null,
      failure: { code: "response_invalid" },
    });
    expect(JSON.stringify(health)).not.toContain("script");
  });
});
