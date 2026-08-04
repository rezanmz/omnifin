import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_BROWSER_ATTEMPTS,
  DEFAULT_BROWSER_TIMEOUT_MS,
  DEFAULT_DEPENDENCY_TIMEOUT_MS,
  installPlaywright,
  runPlaywrightInstallAttempt,
  terminateProcessGroup,
} from "./install-playwright.mjs";

const success = Object.freeze({ code: 0, ok: true, reason: "success", signal: null });

test("installs operating-system dependencies once before retrying browser downloads", async () => {
  const dependencyAttempts = [];
  const browserAttempts = [];
  const delays = [];
  const browserResults = [
    Object.freeze({ code: null, ok: false, reason: "timeout", signal: "SIGTERM" }),
    success,
  ];

  await installPlaywright(["chromium", "webkit"], {
    runBrowserAttempt: async (browsers, options) => {
      browserAttempts.push({ browsers, options });
      return browserResults.shift();
    },
    runDependencyAttempt: async (browsers, options) => {
      dependencyAttempts.push({ browsers, options });
      return success;
    },
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    write: () => undefined,
  });

  assert.equal(DEFAULT_BROWSER_ATTEMPTS, 2);
  assert.equal(DEFAULT_BROWSER_TIMEOUT_MS, 180_000);
  assert.equal(DEFAULT_DEPENDENCY_TIMEOUT_MS, 900_000);
  assert.equal(DEFAULT_BACKOFF_MS, 10_000);
  assert.deepEqual(dependencyAttempts, [
    {
      browsers: ["chromium", "webkit"],
      options: { timeoutMs: DEFAULT_DEPENDENCY_TIMEOUT_MS },
    },
  ]);
  assert.deepEqual(browserAttempts, [
    {
      browsers: ["chromium", "webkit"],
      options: { timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS },
    },
    {
      browsers: ["chromium", "webkit"],
      options: { timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS },
    },
  ]);
  assert.deepEqual(delays, [DEFAULT_BACKOFF_MS]);
});

test("fails closed after a dependency failure without starting a browser download", async () => {
  let browserAttempts = 0;
  let dependencyAttempts = 0;
  let delays = 0;

  await assert.rejects(
    installPlaywright(["chromium"], {
      runBrowserAttempt: async () => {
        browserAttempts += 1;
        return success;
      },
      runDependencyAttempt: async () => {
        dependencyAttempts += 1;
        return Object.freeze({ code: 1, ok: false, reason: "exit", signal: null });
      },
      sleep: async () => {
        delays += 1;
      },
      write: () => undefined,
    }),
    /operating-system dependency installation failed/u,
  );

  assert.equal(dependencyAttempts, 1);
  assert.equal(browserAttempts, 0);
  assert.equal(delays, 0);
});

test("does not start browser installation while timed-out dependency cleanup is pending", async () => {
  let finishDependency;
  let browserAttempts = 0;
  const dependency = new Promise((resolveDependency) => {
    finishDependency = resolveDependency;
  });
  const installation = installPlaywright(["chromium"], {
    runBrowserAttempt: async () => {
      browserAttempts += 1;
      return success;
    },
    runDependencyAttempt: async () => dependency,
    write: () => undefined,
  });

  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(browserAttempts, 0);
  finishDependency({ code: null, ok: false, reason: "timeout", signal: "SIGKILL" });
  await assert.rejects(installation, /operating-system dependency installation failed/u);
  assert.equal(browserAttempts, 0);
});

test("fails closed after both bounded browser-download attempts", async () => {
  let browserAttempts = 0;

  await assert.rejects(
    installPlaywright(["firefox"], {
      backoffMs: 0,
      runBrowserAttempt: async () => {
        browserAttempts += 1;
        return Object.freeze({ code: 1, ok: false, reason: "exit", signal: null });
      },
      runDependencyAttempt: async () => success,
      sleep: async () => undefined,
      write: () => undefined,
    }),
    /browser installation failed after 2 attempts/u,
  );
  assert.equal(browserAttempts, DEFAULT_BROWSER_ATTEMPTS);
});

test("uses separate Playwright commands for dependencies and browser binaries", async () => {
  const spawns = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = spawns.length + 40;
    spawns.push({ args, command, options });
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };

  assert.deepEqual(
    await runPlaywrightInstallAttempt("dependencies", ["chromium", "firefox"], {
      spawnProcess,
      timeoutMs: 1_000,
    }),
    success,
  );
  assert.deepEqual(
    await runPlaywrightInstallAttempt("browsers", ["chromium", "firefox"], {
      spawnProcess,
      timeoutMs: 1_000,
    }),
    success,
  );

  assert.deepEqual(
    spawns.map(({ args, command }) => ({ args, command })),
    [
      {
        command: "pnpm",
        args: [
          "--filter",
          "@omnifin/web",
          "exec",
          "playwright",
          "install-deps",
          "chromium",
          "firefox",
        ],
      },
      {
        command: "pnpm",
        args: ["--filter", "@omnifin/web", "exec", "playwright", "install", "chromium", "firefox"],
      },
    ],
  );
  for (const { options } of spawns) {
    assert.equal(options.detached, process.platform !== "win32");
    assert.equal(options.stdio, "inherit");
  }
});

test("rejects unknown or duplicate browser targets before spawning", async () => {
  let attempts = 0;
  const runAttempt = async () => {
    attempts += 1;
    return success;
  };

  await assert.rejects(
    installPlaywright(["chromium", "private-browser"], {
      runBrowserAttempt: runAttempt,
      runDependencyAttempt: runAttempt,
    }),
    /Unsupported Playwright browser target/u,
  );
  await assert.rejects(
    installPlaywright(["webkit", "webkit"], {
      runBrowserAttempt: runAttempt,
      runDependencyAttempt: runAttempt,
    }),
    /Duplicate Playwright browser target/u,
  );
  assert.equal(attempts, 0);
});

test("rejects an unbounded dependency timeout before spawning", async () => {
  let attempts = 0;
  const runAttempt = async () => {
    attempts += 1;
    return success;
  };

  await assert.rejects(
    installPlaywright(["chromium"], {
      dependencyTimeoutMs: 1_200_001,
      runBrowserAttempt: runAttempt,
      runDependencyAttempt: runAttempt,
    }),
    /dependency install timeout must be between 1 second and 20 minutes/u,
  );
  assert.equal(attempts, 0);
});

test("keeps a timed-out attempt pending until process-group cleanup is verified", async () => {
  const child = new EventEmitter();
  child.pid = 42;
  let finishTermination;
  const termination = new Promise((resolveTermination) => {
    finishTermination = resolveTermination;
  });
  const attempt = runPlaywrightInstallAttempt("dependencies", ["chromium"], {
    spawnProcess: () => child,
    terminate: async () => termination,
    timeoutMs: 1,
  });

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  child.emit("exit", null, "SIGTERM");
  let settled = false;
  void attempt.then(() => {
    settled = true;
  });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(settled, false);

  finishTermination();
  assert.deepEqual(await attempt, {
    code: null,
    ok: false,
    reason: "timeout",
    signal: "SIGTERM",
  });
});

test("reports a failed timeout cleanup without exposing the thrown diagnostic", async () => {
  const child = new EventEmitter();
  child.pid = 42;
  const attempt = runPlaywrightInstallAttempt("dependencies", ["chromium"], {
    spawnProcess: () => child,
    terminate: async () => {
      throw new Error("private process diagnostic");
    },
    timeoutMs: 1,
  });

  assert.deepEqual(await attempt, {
    code: null,
    ok: false,
    reason: "termination",
    signal: null,
  });
});

test("terminates the exact process group and verifies that it exited", async () => {
  const signals = [];
  const delays = [];
  const liveness = [true, false];

  await terminateProcessGroup(
    { pid: 42 },
    {
      exitCheckIntervalMs: 100,
      exitCheckTimeoutMs: 500,
      forceKillDelayMs: 250,
      isAlive: () => liveness.shift(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      stop: (_child, signal) => {
        signals.push(signal);
      },
    },
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(delays, [250, 100]);
});

test("fails timeout cleanup when the exact process group remains alive", async () => {
  await assert.rejects(
    terminateProcessGroup(
      { pid: 42 },
      {
        exitCheckIntervalMs: 1,
        exitCheckTimeoutMs: 2,
        forceKillDelayMs: 1,
        isAlive: () => true,
        sleep: async () => undefined,
        stop: () => undefined,
      },
    ),
    /process group remained alive/u,
  );
});

test("timeout cleanup never searches for or signals unrelated package-manager owners", () => {
  const source = readFileSync(new URL("./install-playwright.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\b(?:killall|pgrep|pkill)\b|\/var\/lib\/dpkg|apt-get/u);
});
