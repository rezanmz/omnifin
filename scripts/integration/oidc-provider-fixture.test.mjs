import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  dotenv,
  failureReportFor,
  isPrivateIpv4,
  oidcProviderFixture,
  renderConfig,
  reportFor,
  secretLeakDetected,
  selectPrivateHost,
} from "./oidc-provider/fixture.mjs";
import { waitForSemanticSessionThenCookie } from "./oidc-provider/session-convergence.mjs";

const composeSource = readFileSync(
  new URL("./oidc-provider/compose.yaml", import.meta.url),
  "utf8",
);
const templateSource = readFileSync(
  new URL("./oidc-provider/config.yaml.template", import.meta.url),
  "utf8",
);
const runnerSource = readFileSync(new URL("./oidc-provider/run.mjs", import.meta.url), "utf8");
const browserSource = readFileSync(
  new URL("./oidc-provider/browser-check.mjs", import.meta.url),
  "utf8",
);
const proxySource = readFileSync(new URL("./oidc-provider/tls-proxy.mjs", import.meta.url), "utf8");

test("selects only a non-loopback private fixture host", () => {
  assert.equal(isPrivateIpv4("10.4.5.6"), true);
  assert.equal(isPrivateIpv4("172.31.9.8"), true);
  assert.equal(isPrivateIpv4("192.168.1.4"), true);
  assert.equal(isPrivateIpv4("127.0.0.1"), false);
  assert.equal(isPrivateIpv4("169.254.1.2"), false);
  assert.equal(
    selectPrivateHost({
      docker: [{ address: "172.20.0.1", family: "IPv4", internal: false }],
      loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    }),
    "172.20.0.1",
  );
  assert.throws(
    () =>
      selectPrivateHost({
        loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      }),
    /private_host_unavailable/u,
  );
});

test("renders quoted provider configuration without unresolved placeholders", () => {
  const rendered = renderConfig(templateSource, {
    CALLBACK_URL: "https://192.168.1.2:8443/api/auth/oidc/callback/oidc-generic",
    CLIENT_ID: "fixture-client",
    CLIENT_SECRET: "fixture-secret",
    ISSUER: "https://192.168.1.2:9443/dex",
  });
  const config = parse(rendered);
  assert.equal(config.issuer, "https://192.168.1.2:9443/dex");
  assert.deepEqual(config.oauth2.responseTypes, ["code"]);
  assert.deepEqual(config.oauth2.pkce.codeChallengeMethodsSupported, ["S256"]);
  assert.equal(config.oauth2.pkce.enforce, true);
  assert.deepEqual(config.staticClients[0].redirectURIs, [
    "https://192.168.1.2:8443/api/auth/oidc/callback/oidc-generic",
  ]);
  assert.deepEqual(config.connectors, [
    { id: "generic", name: "Generic identity", type: "mockCallback" },
  ]);
  assert.doesNotMatch(rendered, /__[A-Z][A-Z0-9_]*__/u);
  assert.throws(() => renderConfig("value: __MISSING__", {}), /provider_config_incomplete/u);
});

test("serializes a deterministic private Compose environment", () => {
  assert.equal(dotenv({ SECOND: "two$", FIRST: "one" }), "FIRST='one'\nSECOND='two$'\n");
  assert.throws(() => dotenv({ INVALID: "line\nbreak" }), /environment_value_invalid/u);
});

test("pins and hardens the isolated standards provider", () => {
  const compose = parse(composeSource);
  const provider = compose.services.provider;
  assert.match(provider.image, /^ghcr\.io\/dexidp\/dex:v2\.45\.1@sha256:[a-f0-9]{64}$/u);
  assert.equal(provider.read_only, true);
  assert.equal(provider.restart, "no");
  assert.deepEqual(provider.cap_drop, ["ALL"]);
  assert.deepEqual(provider.security_opt, ["no-new-privileges:true"]);
  assert.ok(provider.tmpfs.includes("/var/dex:uid=1001,gid=1001,mode=0700"));
  assert.deepEqual(compose.networks.fixture, {});
  assert.match(JSON.stringify(provider.ports), /127\.0\.0\.1/u);
  assert.doesNotMatch(composeSource, /:\s*latest(?:\s|$)|docker\.sock/u);
});

test("emits only the closed sanitized generic OIDC report", () => {
  const report = reportFor();
  assert.equal(report.passed, true);
  assert.equal(report.upstreamVersion, oidcProviderFixture.version);
  assert.deepEqual(report.checks, oidcProviderFixture.checks);
  assert.deepEqual(Object.keys(report).sort(), [
    "checks",
    "mode",
    "passed",
    "schemaVersion",
    "service",
    "upstreamVersion",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /https?:\/\/|@|-----BEGIN/iu);
  assert.throws(() => reportFor(["authorization_code_pkce"]), /fixture_checks_incomplete/u);

  const failure = failureReportFor("provider_start_failed");
  assert.equal(failure.passed, false);
  assert.deepEqual(failure.checks, []);
  assert.doesNotMatch(JSON.stringify(failure), /https?:\/\/|@|-----BEGIN/iu);
});

test("detects generated secrets without retaining runtime logs", () => {
  assert.equal(secretLeakDetected(["gateway ready"], ["private-value"]), false);
  assert.equal(secretLeakDetected(["bad private-value output"], ["private-value"]), true);
});

test("keeps the provider flow strict, bounded, and free of raw diagnostics", () => {
  assert.match(runnerSource, /NODE_EXTRA_CA_CERTS/u);
  assert.match(runnerSource, /code_challenge_methods_supported/u);
  assert.match(runnerSource, /code_challenge_methods_supported\?\.includes\("S256"\)/u);
  assert.match(runnerSource, /discovery\.end_session_endpoint === undefined/u);
  assert.match(runnerSource, /backchannel_logout_supported !== true/u);
  assert.match(runnerSource, /secretLeakDetected/u);
  assert.match(runnerSource, /clearReport\(options\.output\)/u);
  assert.match(runnerSource, /composeArguments\(project, environmentFile, "logs"/u);
  assert.match(runnerSource, /if \(teardownFailure\) throw teardownFailure/u);
  assert.match(runnerSource, /allowedChecks/u);
  assert.match(runnerSource, /browser_flow_failed_\$\{match\[1\]\}_\$\{match\[2\]\}/u);
  assert.ok(
    runnerSource.indexOf("if (teardownFailure) throw teardownFailure") <
      runnerSource.indexOf("writeReport(options.output, completedReport)"),
  );
  assert.doesNotMatch(runnerSource, /console\.(?:debug|log)|throw new FixtureError\([^)]*stderr/u);

  assert.match(browserSource, /"viewer"/u);
  assert.match(browserSource, /code_challenge_method"\) === "S256"/u);
  assert.match(browserSource, /request\.searchParams\.has\("code_verifier"\) === false/u);
  assert.match(browserSource, /new Set\(states\)\.size === authorizationRequests\.length/u);
  assert.match(browserSource, /new Set\(nonces\)\.size === authorizationRequests\.length/u);
  assert.match(browserSource, /values: \["authors"\]/u);
  assert.match(browserSource, /role: "admin"/u);
  assert.match(browserSource, /role: "operator"/u);
  assert.match(browserSource, /role_mapping_update/u);
  assert.match(browserSource, /updatedMapping\.revokedSessions === 1/u);
  assert.match(browserSource, /"operator",\s*mappedIdentity\.subject/u);
  assert.match(browserSource, /SESSION_CONVERGENCE_TIMEOUT_MS = 10_000/u);
  assert.match(browserSource, /waitForPendingPrincipal/u);
  assert.match(browserSource, /waitForSessionCookie/u);
  assert.equal(
    (browserSource.match(/await waitForPendingPrincipalThenSessionCookie\(/gu) ?? []).length,
    2,
  );
  assert.ok(
    browserSource.indexOf("currentStage = `${stage}_session`") <
      browserSource.indexOf("currentStage = `${stage}_cookie`"),
  );
  assert.match(browserSource, /candidate\.name === SESSION_COOKIE_NAME/u);
  assert.match(browserSource, /cookie\.value !== previousValue/u);
  assert.match(browserSource, /administrationContext\.request/u);
  assert.match(browserSource, /"principal_role"/u);
  assert.match(browserSource, /failureDetail = \{ check \}/u);
  assert.match(browserSource, /supportsBackChannelLogout === false/u);
  assert.match(browserSource, /supportsRpInitiatedLogout === false/u);
  assert.match(browserSource, /localLogout\.origin === webOrigin/u);
  assert.match(browserSource, /localLogout\.searchParams\.get\("loggedOut"\) === "1"/u);
  assert.doesNotMatch(browserSource, /console\.(?:debug|log)/u);

  assert.match(proxySource, /forwardedRequestHeaders/u);
  assert.match(proxySource, /forwardResponseHeaders/u);
  assert.doesNotMatch(proxySource, /upstreamResponse\.statusMessage/u);
  assert.equal((proxySource.match(/response\.writeHead\(/gu) ?? []).length, 1);
  assert.doesNotMatch(proxySource, /Object\.entries\(headers\)|forwarded\[name\]/u);
});

test("waits for semantic session convergence before inspecting the replacement cookie", async () => {
  const calls = [];
  let releaseSession;
  const sessionReady = new Promise((resolve) => {
    releaseSession = resolve;
  });

  const convergence = waitForSemanticSessionThenCookie({
    waitForSession: async () => {
      calls.push("session");
      await sessionReady;
      return { principal: { role: "admin" } };
    },
    waitForCookie: async () => {
      calls.push("cookie");
      return "replacement-observed";
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["session"]);
  releaseSession();
  assert.deepEqual(await convergence, {
    sessionCookie: "replacement-observed",
    sessionResult: { principal: { role: "admin" } },
  });
  assert.deepEqual(calls, ["session", "cookie"]);
});

test("does not inspect cookies when semantic session convergence fails", async () => {
  let cookieInspected = false;

  await assert.rejects(
    waitForSemanticSessionThenCookie({
      waitForSession: async () => {
        throw new Error("session_not_ready");
      },
      waitForCookie: async () => {
        cookieInspected = true;
        return "unexpected";
      },
    }),
    /session_not_ready/u,
  );
  assert.equal(cookieInspected, false);
});
