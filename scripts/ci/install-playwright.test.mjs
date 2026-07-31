import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  installPlaywright,
} from "./install-playwright.mjs";

const success = Object.freeze({ code: 0, ok: true, reason: "success", signal: null });

test("retries one bounded Playwright install failure", async () => {
  const attempts = [];
  const delays = [];
  const failures = [
    Object.freeze({ code: null, ok: false, reason: "timeout", signal: "SIGTERM" }),
    success,
  ];

  await installPlaywright(["chromium", "webkit"], {
    runAttempt: async (browsers, options) => {
      attempts.push({ browsers, options });
      return failures.shift();
    },
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    write: () => undefined,
  });

  assert.equal(DEFAULT_ATTEMPTS, 2);
  assert.equal(DEFAULT_TIMEOUT_MS, 180_000);
  assert.equal(DEFAULT_BACKOFF_MS, 10_000);
  assert.deepEqual(attempts, [
    { browsers: ["chromium", "webkit"], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
    { browsers: ["chromium", "webkit"], options: { timeoutMs: DEFAULT_TIMEOUT_MS } },
  ]);
  assert.deepEqual(delays, [DEFAULT_BACKOFF_MS]);
});

test("fails closed after both bounded attempts", async () => {
  let attempts = 0;

  await assert.rejects(
    installPlaywright(["firefox"], {
      backoffMs: 0,
      runAttempt: async () => {
        attempts += 1;
        return Object.freeze({ code: 1, ok: false, reason: "exit", signal: null });
      },
      sleep: async () => undefined,
      write: () => undefined,
    }),
    /Playwright runtime installation failed after 2 attempts/u,
  );
  assert.equal(attempts, DEFAULT_ATTEMPTS);
});

test("rejects unknown or duplicate browser targets before spawning", async () => {
  let attempts = 0;
  const runAttempt = async () => {
    attempts += 1;
    return success;
  };

  await assert.rejects(
    installPlaywright(["chromium", "private-browser"], { runAttempt }),
    /Unsupported Playwright browser target/u,
  );
  await assert.rejects(
    installPlaywright(["webkit", "webkit"], { runAttempt }),
    /Duplicate Playwright browser target/u,
  );
  assert.equal(attempts, 0);
});
