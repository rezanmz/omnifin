import assert from "node:assert/strict";
import test from "node:test";

import { endpoint, normalizeVersion, runLiveProbe } from "./live-probes.mjs";

test("live probe endpoints require HTTPS by default", () => {
  assert.equal(
    endpoint("https://media.example.test/base", "api/status").href,
    "https://media.example.test/base/api/status",
  );
  assert.throws(
    () => endpoint("http://media.example.test", "api/status"),
    /configuration_invalid/u,
  );
});

test("live probe HTTP opt-in accepts only the exact true value", () => {
  assert.equal(
    endpoint("http://media.example.test", "api/status", {
      OMNIFIN_INTEGRATION_ALLOW_HTTP: "true",
    }).href,
    "http://media.example.test/api/status",
  );
  for (const value of ["TRUE", "1", "yes"]) {
    assert.throws(
      () =>
        endpoint("http://media.example.test", "api/status", {
          OMNIFIN_INTEGRATION_ALLOW_HTTP: value,
        }),
      /configuration_invalid/u,
    );
  }
});

test("live probe endpoint configuration rejects embedded credentials and URL suffixes", () => {
  for (const url of [
    "https://user:password@media.example.test",
    "https://media.example.test?token=secret",
    "https://media.example.test#fragment",
  ]) {
    assert.throws(() => endpoint(url, "api/status"), /configuration_invalid/u);
  }
});

test("normalizes only conservative upstream versions", () => {
  for (const version of ["v5.1.2", "10.11.2", "6.0.4.10291", "1.2.3-rc.1+build.7"]) {
    assert.equal(normalizeVersion(version), version);
  }
  for (const version of ["fixture-api-key", "<script>1.2.3</script>", "1", "01.2.3"]) {
    assert.throws(() => normalizeVersion(version), /response_invalid/u);
  }
});

test("rejects exact, prefixed, contained, and delimiter-bounded credential reflections", () => {
  const reflections = [
    { credential: "1.2.3", candidate: "1.2.3" },
    { credential: "1.2.3", candidate: "v1.2.3" },
    { credential: "12.34.56", candidate: "112.34.56" },
    { credential: "beta", candidate: "1.2.3-beta.1" },
  ];

  for (const { candidate, credential } of reflections) {
    assert.throws(
      () => normalizeVersion(candidate, { OMNIFIN_RADARR_API_KEY: credential }),
      (error) => {
        assert.equal(error.message, "response_invalid");
        assert.equal(String(error).includes(credential), false);
        return true;
      },
    );
  }
});

test("does not reject ambiguous short credential substrings", () => {
  assert.equal(
    normalizeVersion("1.2.3-rc.1", {
      OMNIFIN_RADARR_API_KEY: "rc",
      OMNIFIN_RADARR_PASSWORD: "2.3",
    }),
    "1.2.3-rc.1",
  );
});

test("Prowlarr live probe verifies every read surface used by Indexer Intelligence", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    requests.push({ headers: new Headers(init?.headers), url });
    const bodies = {
      "/api/v1/applications": [],
      "/api/v1/history": { records: [], totalRecords: 0 },
      "/api/v1/indexer": [],
      "/api/v1/indexerstats": { indexers: [] },
      "/api/v1/indexerstatus": [],
      "/api/v1/system/status": { version: "2.5.2.5491" },
    };
    return new Response(JSON.stringify(bodies[url.pathname]), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await runLiveProbe("prowlarr", {
      OMNIFIN_PROWLARR_API_KEY: "protected-prowlarr-key",
      OMNIFIN_PROWLARR_URL: "https://prowlarr.example.test",
    });

    assert.deepEqual(result, {
      service: "prowlarr",
      profile: "live-upstream",
      status: "passed",
      version: "2.5.2.5491",
      checks: [
        "authentication",
        "version_discovery",
        "indexer_inventory",
        "statistics",
        "failure_status",
        "application_sync",
        "failure_history",
      ],
    });
    assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), [
      "/api/v1/applications",
      "/api/v1/history",
      "/api/v1/indexer",
      "/api/v1/indexerstats",
      "/api/v1/indexerstatus",
      "/api/v1/system/status",
    ]);
    assert.equal(
      requests.every(({ headers }) => headers.get("x-api-key") === "protected-prowlarr-key"),
      true,
    );
    const history = requests.find(({ url }) => url.pathname === "/api/v1/history")?.url;
    assert.equal(history?.searchParams.get("pageSize"), "1");
    assert.equal(history?.searchParams.get("successful"), "false");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Prowlarr live probe rejects shifted intelligence response shapes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(input).pathname;
    const body = path.endsWith("/system/status")
      ? { version: "2.5.2.5491" }
      : path.endsWith("/indexerstats")
        ? { indexers: "shifted" }
        : path.endsWith("/history")
          ? { records: [], totalRecords: 0 }
          : [];
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    assert.deepEqual(
      await runLiveProbe("prowlarr", {
        OMNIFIN_PROWLARR_API_KEY: "protected-prowlarr-key",
        OMNIFIN_PROWLARR_URL: "https://prowlarr.example.test",
      }),
      {
        service: "prowlarr",
        profile: "live-upstream",
        status: "failed",
        errorCategory: "response_invalid",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const credentialReflectionCases = [
  {
    service: "seerr",
    environment: {
      OMNIFIN_SEERR_URL: "https://seerr.example.test",
      OMNIFIN_SEERR_API_KEY: "1.2.3",
    },
    credential: "1.2.3",
    candidate: "1.2.3",
    body: (version) => ({ version }),
  },
  {
    service: "radarr",
    environment: {
      OMNIFIN_RADARR_URL: "https://radarr.example.test",
      OMNIFIN_RADARR_API_KEY: "1.2.3",
    },
    credential: "1.2.3",
    candidate: "v1.2.3",
    body: (version) => ({ version }),
  },
  {
    service: "sonarr",
    environment: {
      OMNIFIN_SONARR_URL: "https://sonarr.example.test",
      OMNIFIN_SONARR_API_KEY: "12.34.56",
    },
    credential: "12.34.56",
    candidate: "112.34.56",
    body: (version) => ({ version }),
  },
  {
    service: "prowlarr",
    environment: {
      OMNIFIN_PROWLARR_URL: "https://prowlarr.example.test",
      OMNIFIN_PROWLARR_API_KEY: "beta",
    },
    credential: "beta",
    candidate: "1.2.3-beta.1",
    body: (version) => ({ version }),
  },
  {
    service: "bazarr",
    environment: {
      OMNIFIN_BAZARR_URL: "https://bazarr.example.test",
      OMNIFIN_BAZARR_API_KEY: "2.3.4",
    },
    credential: "2.3.4",
    candidate: "V2.3.4",
    body: (version) => ({ data: { bazarr_version: version } }),
  },
  {
    service: "sabnzbd",
    environment: {
      OMNIFIN_SABNZBD_URL: "https://sabnzbd.example.test",
      OMNIFIN_SABNZBD_API_KEY: "34.56.78",
    },
    credential: "34.56.78",
    candidate: "134.56.78",
    body: (version) => ({ version }),
  },
];

for (const { body, candidate, credential, environment, service } of credentialReflectionCases) {
  test(`${service} never publishes a reflected configured credential`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body(candidate)), {
        headers: { "content-type": "application/json" },
      });
    try {
      const result = await runLiveProbe(service, environment);
      assert.deepEqual(result, {
        service,
        profile: "live-upstream",
        status: "failed",
        errorCategory: "response_invalid",
      });
      assert.equal(JSON.stringify(result).includes(credential), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("qBittorrent rejects configured credential and negotiated SID reflections", async () => {
  const cases = [
    {
      username: "1.2.3",
      password: "strong-password",
      sessionId: "negotiated-session",
      credential: "1.2.3",
      candidate: "v1.2.3",
    },
    {
      username: "operator",
      password: "12.34.56",
      sessionId: "negotiated-session",
      credential: "12.34.56",
      candidate: "112.34.56",
    },
    {
      username: "operator",
      password: "strong-password",
      sessionId: "beta",
      credential: "beta",
      candidate: "1.2.3-beta.1",
    },
  ];

  const originalFetch = globalThis.fetch;
  try {
    for (const { candidate, credential, password, sessionId, username } of cases) {
      globalThis.fetch = async (url) => {
        if (new URL(url).pathname.endsWith("/api/v2/auth/login")) {
          return new Response("Ok.", { headers: { "set-cookie": `SID=${sessionId}; HttpOnly` } });
        }
        return new Response(candidate);
      };

      const result = await runLiveProbe("qbittorrent", {
        OMNIFIN_QBITTORRENT_URL: "https://qbittorrent.example.test",
        OMNIFIN_QBITTORRENT_USERNAME: username,
        OMNIFIN_QBITTORRENT_PASSWORD: password,
      });
      assert.deepEqual(result, {
        service: "qbittorrent",
        profile: "live-upstream",
        status: "failed",
        errorCategory: "response_invalid",
      });
      assert.equal(JSON.stringify(result).includes(credential), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
