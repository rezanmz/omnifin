import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import {
  authentikFixture,
  djangoPasswordHash,
  dotenv,
  failureReportFor,
  httpFailureStage,
  isPrivateIpv4,
  PROVIDER_VALIDATION_MAX_ATTEMPTS,
  PROVIDER_VALIDATION_MAX_WAIT_MS,
  providerValidationRetryDelay,
  reportFor,
  secretLeakDetected,
  selectPrivateHost,
} from "./authentik/fixture.mjs";
import {
  forwardedRequestHeaders,
  forwardedResponseHeaders,
} from "./authentik/tls-proxy-headers.mjs";

const composeSource = readFileSync(new URL("./authentik/compose.yaml", import.meta.url), "utf8");
const blueprintSource = readFileSync(
  new URL("./authentik/blueprint.yaml", import.meta.url),
  "utf8",
);
const runnerSource = readFileSync(new URL("./authentik/run.mjs", import.meta.url), "utf8");
const proxySource = readFileSync(new URL("./authentik/tls-proxy.mjs", import.meta.url), "utf8");
const dispatchSource = readFileSync(
  new URL("./authentik/dispatch-backchannel.py", import.meta.url),
  "utf8",
);

test("selects only a non-loopback RFC1918 fixture host", () => {
  assert.equal(isPrivateIpv4("10.4.5.6"), true);
  assert.equal(isPrivateIpv4("172.31.9.8"), true);
  assert.equal(isPrivateIpv4("192.168.1.4"), true);
  assert.equal(isPrivateIpv4("127.0.0.1"), false);
  assert.equal(isPrivateIpv4("169.254.1.2"), false);
  assert.equal(
    selectPrivateHost({
      docker: [{ address: "172.20.0.1", family: "IPv4", internal: false }],
      loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      public: [{ address: "203.0.113.10", family: "IPv4", internal: false }],
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

test("serializes a deterministic quoted environment without multiline injection", () => {
  assert.equal(dotenv({ SECOND: "two$", FIRST: "one" }), "FIRST='one'\nSECOND='two$'\n");
  assert.throws(() => dotenv({ INVALID: "line\nbreak" }), /environment_value_invalid/u);
  assert.throws(() => dotenv({ invalid: "value" }), /environment_name_invalid/u);
});

test("generates the current Django PBKDF2 bootstrap hash without a plaintext subprocess", () => {
  assert.equal(
    djangoPasswordHash("a-long-isolated-password", "fixedFixtureSalt1234"),
    "pbkdf2_sha256$1000000$fixedFixtureSalt1234$yOBThZRNKwQFOBzKL4dEsOcTkTEeSXNzeet6DzMo5bU=",
  );
  assert.throws(
    () => djangoPasswordHash("short", "fixedFixtureSalt1234"),
    /password_hash_input_invalid/u,
  );
  assert.doesNotMatch(runnerSource, /hash_password|"run",\s*"--rm"/u);
});

test("emits only the bounded, sanitized Authentik report contract", () => {
  const report = reportFor();
  assert.equal(report.passed, true);
  assert.equal(report.upstreamVersion, authentikFixture.version);
  assert.equal(report.image, authentikFixture.image);
  assert.deepEqual(report.checks, authentikFixture.checks);
  assert.deepEqual(Object.keys(report).sort(), [
    "checks",
    "image",
    "mode",
    "passed",
    "schemaVersion",
    "service",
    "upstreamVersion",
  ]);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /https?:\/\/|-----BEGIN|private-token/iu);
  assert.throws(() => reportFor(["authorization_code_pkce"]), /fixture_checks_incomplete/u);

  const failure = failureReportFor("backchannel_send_failed");
  assert.equal(failure.passed, false);
  assert.deepEqual(failure.checks, []);
  assert.equal(failure.errorCategory, "backchannel_send_failed");
  assert.equal(failure.image, authentikFixture.image);
  assert.doesNotMatch(JSON.stringify(failure), /https?:\/\/|-----BEGIN|private-token/iu);
  assert.throws(() => failureReportFor("invalid category"), /fixture_error_category_invalid/u);
});

test("bounds transient provider validation retries without weakening fail-closed responses", () => {
  assert.equal(PROVIDER_VALIDATION_MAX_ATTEMPTS, 10);
  assert.equal(PROVIDER_VALIDATION_MAX_WAIT_MS, 300_000);
  assert.equal(
    providerValidationRetryDelay({
      attempt: 0,
      elapsedMs: 0,
      retryAfterSeconds: 30,
      status: 503,
    }),
    36_000,
  );
  assert.equal(
    providerValidationRetryDelay({
      attempt: 8,
      elapsedMs: 288_000,
      retryAfterSeconds: 30,
      status: 503,
    }),
    null,
  );
  assert.equal(
    providerValidationRetryDelay({
      attempt: 0,
      elapsedMs: 0,
      retryAfterSeconds: Number.NaN,
      status: 422,
    }),
    null,
  );
  assert.throws(
    () =>
      providerValidationRetryDelay({
        attempt: 0,
        elapsedMs: 0,
        retryAfterSeconds: 0,
        status: 503,
      }),
    /provider_validation_retry_invalid/u,
  );
  assert.throws(
    () =>
      providerValidationRetryDelay({
        attempt: -1,
        elapsedMs: 0,
        retryAfterSeconds: 30,
        status: 503,
      }),
    /provider_validation_retry_invalid/u,
  );
});

test("normalizes HTTP diagnostics without retaining response details", () => {
  assert.equal(httpFailureStage("provider_enable", 302), "provider_enable_redirect");
  assert.equal(httpFailureStage("provider_enable", 422), "provider_enable_client_error");
  assert.equal(httpFailureStage("provider_enable", 503), "provider_enable_server_error");
  assert.equal(httpFailureStage("provider_enable", 204), "provider_enable_unexpected_status");
  assert.throws(() => httpFailureStage("unsafe-stage", 503), /http_failure_stage_invalid/u);
  assert.throws(() => httpFailureStage("provider_enable", 700), /http_failure_stage_invalid/u);
});

test("detects generated secrets before runtime logs can be retained", () => {
  assert.equal(secretLeakDetected(["gateway ready"], ["private-value"]), false);
  assert.equal(secretLeakDetected(["bad private-value output"], ["private-value"]), true);
});

test("forwards end-to-end Authentik headers without trusting proxy metadata", () => {
  const headers = forwardedRequestHeaders(
    {
      connection: "keep-alive, x-remove-me",
      cookie: "authentik_session=fixture",
      forwarded: "for=203.0.113.10",
      host: "attacker.invalid",
      "sec-ch-ua": '"Chromium";v="124"',
      "x-authentik-csrf": "fixture-csrf",
      "x-forwarded-for": "203.0.113.10",
      "x-remove-me": "connection-scoped",
    },
    "192.168.20.5:9443",
    "9443",
    "192.168.20.7",
  );

  assert.equal(headers instanceof Map, true);
  assert.equal(headers.get("cookie"), "authentik_session=fixture");
  assert.equal(headers.get("sec-ch-ua"), '"Chromium";v="124"');
  assert.equal(headers.get("x-authentik-csrf"), "fixture-csrf");
  assert.equal(headers.get("host"), "192.168.20.5:9443");
  assert.equal(headers.get("x-forwarded-for"), "192.168.20.7");
  assert.equal(headers.get("x-forwarded-host"), "192.168.20.5:9443");
  assert.equal(headers.get("x-forwarded-port"), "9443");
  assert.equal(headers.get("x-forwarded-proto"), "https");
  assert.equal(headers.has("connection"), false);
  assert.equal(headers.has("forwarded"), false);
  assert.equal(headers.has("x-remove-me"), false);
});

test("forwards arbitrary upstream response headers without hop-by-hop state", () => {
  const headers = forwardedResponseHeaders({
    connection: "x-remove-me",
    "content-security-policy": "default-src 'self'",
    "set-cookie": ["authentik_session=fixture; Secure"],
    "x-authentik-meta": "fixture",
    "x-remove-me": "connection-scoped",
  });

  assert.equal(headers instanceof Map, true);
  assert.equal(headers.get("content-security-policy"), "default-src 'self'");
  assert.deepEqual(headers.get("set-cookie"), ["authentik_session=fixture; Secure"]);
  assert.equal(headers.get("x-authentik-meta"), "fixture");
  assert.equal(headers.has("connection"), false);
  assert.equal(headers.has("x-remove-me"), false);
});

test("uses Map-based proxy headers without forwarding upstream reason phrases", () => {
  assert.match(proxySource, /upstream\.setHeaders/u);
  assert.match(proxySource, /response\.setHeaders/u);
  assert.match(proxySource, /response\.statusCode/u);
  assert.doesNotMatch(proxySource, /upstreamResponse\.statusMessage/u);
});

test("browser failure diagnostics are restricted to allowlisted stage identifiers", () => {
  const browserSource = readFileSync(
    new URL("./authentik/browser-check.mjs", import.meta.url),
    "utf8",
  );
  assert.match(browserSource, /authentik_browser_checks_failed/u);
  assert.match(browserSource, /INTERACTION_RETRY_ATTEMPTS = 6/u);
  assert.match(browserSource, /INTERACTION_WAIT_TIMEOUT_MS = 30_000/u);
  assert.match(browserSource, /retryInteraction/u);
  assert.match(browserSource, /waitForStageTransition/u);
  assert.match(browserSource, /stage\.isConnected/u);
  assert.match(browserSource, /unrecognizedStage/u);
  assert.match(browserSource, /locator\.fill\(value/u);
  assert.match(browserSource, /ak-stage-identification input\[name="uidField"\]:visible/u);
  assert.match(browserSource, /ak-stage-password input\[name="password"\]:visible/u);
  assert.match(browserSource, /ak-stage-consent button\[type="submit"\]:visible/u);
  assert.match(browserSource, /form\.requestSubmit\(\)/u);
  assert.match(browserSource, /ak-stage-identification form/u);
  assert.match(browserSource, /ak-stage-consent form/u);
  assert.match(browserSource, /providerValidationRetryDelay/u);
  assert.match(browserSource, /enableProvider/u);
  assert.match(browserSource, /request\.put\(path/u);
  assert.match(browserSource, /updateMapping/u);
  assert.match(browserSource, /role_mapping_update/u);
  assert.match(browserSource, /updatedMapping\.revokedSessions === 0/u);
  assert.match(browserSource, /issuer, "operator"/u);
  assert.match(browserSource, /httpFailureStage/u);
  assert.match(browserSource, /assertAuthentikProviderConfiguration/u);
  assert.match(browserSource, /assertAuthentikBrowserSession/u);
  assert.match(runnerSource, /provider_enable_server_error/u);
  assert.match(browserSource, /backchannelTaskFailureStage/u);
  assert.match(browserSource, /backchannel_logout_notification_dispatch/u);
  assert.match(browserSource, /send_backchannel_logout_request/u);
  assert.match(browserSource, /application\/o\/omnifin\/end-session/u);
  assert.match(browserSource, /assertAuthentikAccessToken/u);
  assert.match(browserSource, /api\/v3\/oauth2\/access_tokens/u);
  assert.match(browserSource, /backchannel_access_token_api/u);
  assert.match(browserSource, /backchannel_access_token_missing/u);
  assert.match(browserSource, /backchannel_access_token_provider_mismatch/u);
  assert.match(browserSource, /backchannel_access_token_retained/u);
  assert.match(browserSource, /backchannel_access_token_user_mismatch/u);
  assert.match(browserSource, /backchannel_access_token_inactive/u);
  assert.match(browserSource, /dispatchAuthentikBackchannel/u);
  assert.match(browserSource, /backchannel_trigger_tls_failure/u);
  assert.match(browserSource, /backchannel_trigger_tls_chain_failure/u);
  assert.match(browserSource, /backchannel_trigger_tls_identity_failure/u);
  assert.match(browserSource, /backchannel_trigger_tls_validity_failure/u);
  assert.match(browserSource, /backchannel_trigger_network_failure/u);
  assert.match(browserSource, /backchannel_trigger_process_failure/u);
  assert.match(dispatchSource, /create_logout_token/u);
  assert.match(dispatchSource, /get_http_session\(\)\.post/u);
  assert.match(dispatchSource, /verify=environ\["REQUESTS_CA_BUNDLE"\]/u);
  assert.match(dispatchSource, /response\.raise_for_status\(\)/u);
  assert.doesNotMatch(dispatchSource, /print\([^)]*(?:token|session|subject|secret)/iu);
  assert.match(browserSource, /currentAuthentikBrowserSession/u);
  assert.match(browserSource, /revokeAuthentikBrowserSessions/u);
  assert.match(browserSource, /core\/authenticated_sessions/u);
  assert.match(runnerSource, /allowedStages/u);
  assert.match(runnerSource, /first_login_submit/u);
  assert.match(runnerSource, /second_login_submit/u);
  assert.match(runnerSource, /\[a-z_\]\+/u);
  assert.doesNotMatch(runnerSource, /throw new FixtureError\([^)]*stderr/u);
  assert.match(runnerSource, /backchannel_not_delivered/u);
  assert.match(runnerSource, /backchannel_response_missing/u);
  assert.match(runnerSource, /backchannel_response_\$\{responseMatch\[1\]\}/u);
  assert.match(runnerSource, /basicConstraints=critical,CA:TRUE,pathlen:0/u);
  assert.match(runnerSource, /keyUsage=critical,keyCertSign,cRLSign/u);
  assert.match(runnerSource, /authorityKeyIdentifier=keyid:always/u);
  assert.match(runnerSource, /"-x509_strict"/u);
});

test("pins an isolated Authentik topology without privileged host mounts", () => {
  const compose = parse(composeSource);
  assert.match(
    compose.services.postgresql.image,
    /^docker\.io\/library\/postgres:16-alpine@sha256:[a-f0-9]{64}$/u,
  );
  for (const service of [compose.services.server, compose.services.worker]) {
    assert.equal(service.image, "${OMNIFIN_AUTHENTIK_IMAGE:?immutable Authentik image required}");
    assert.equal(service.restart, "no");
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  }
  assert.match(
    authentikFixture.image,
    /^ghcr\.io\/goauthentik\/server:2026\.5\.6@sha256:[a-f0-9]{64}$/u,
  );
  assert.deepEqual(compose.networks.fixture, {});
  assert.match(runnerSource, /OMNIFIN_AUTHENTIK_IMAGE: authentikFixture\.image/u);
  assert.equal(compose.services.server.environment.AUTHENTIK_ERROR_REPORTING__ENABLED, "false");
  assert.equal(compose.services.server.environment.AUTHENTIK_DISABLE_UPDATE_CHECK, "true");
  assert.match(JSON.stringify(compose.services.worker.environment), /BOOTSTRAP_PASSWORD_HASH/u);
  assert.doesNotMatch(
    composeSource,
    /docker\.sock|:\s*latest(?:\s|$)|\/etc\/(?:localtime|timezone)/u,
  );
});

test("blueprint limits the provider to a confidential authorization-code client", () => {
  assert.match(blueprintSource, /grant_types:\n\s+- authorization_code/u);
  assert.match(blueprintSource, /client_type: confidential/u);
  assert.match(blueprintSource, /matching_mode: strict/u);
  assert.match(blueprintSource, /logout_method: backchannel/u);
  assert.match(blueprintSource, /issuer_mode: per_provider/u);
  assert.match(blueprintSource, /scope_name, profile/u);
  assert.doesNotMatch(
    blueprintSource,
    /implicit|password|refresh_token|offline_access|matching_mode: regex/u,
  );
});
