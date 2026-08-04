import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_BROWSER_ATTEMPTS = 2;
export const DEFAULT_BROWSER_TIMEOUT_MS = 180_000;
export const DEFAULT_DEPENDENCY_TIMEOUT_MS = 900_000;
export const DEFAULT_BACKOFF_MS = 10_000;

const FORCE_KILL_DELAY_MS = 10_000;
const EXIT_CHECK_INTERVAL_MS = 100;
const EXIT_CHECK_TIMEOUT_MS = 5_000;
const SUPPORTED_BROWSERS = new Set(["chromium", "firefox", "webkit"]);
const SUPPORTED_PHASES = new Set(["dependencies", "browsers"]);

function validateBrowsers(browsers) {
  if (!Array.isArray(browsers) || browsers.length === 0) {
    throw new Error("At least one Playwright browser target is required.");
  }

  const seen = new Set();
  for (const browser of browsers) {
    if (!SUPPORTED_BROWSERS.has(browser)) {
      throw new Error(`Unsupported Playwright browser target: ${String(browser)}`);
    }
    if (seen.has(browser)) {
      throw new Error(`Duplicate Playwright browser target: ${browser}`);
    }
    seen.add(browser);
  }

  return Object.freeze([...browsers]);
}

function validateOptions({ backoffMs, browserAttempts, browserTimeoutMs, dependencyTimeoutMs }) {
  if (!Number.isInteger(browserAttempts) || browserAttempts < 1 || browserAttempts > 3) {
    throw new Error("Playwright browser install attempts must be an integer between 1 and 3.");
  }
  for (const [label, timeoutMs] of [
    ["browser install", browserTimeoutMs],
    ["dependency install", dependencyTimeoutMs],
  ]) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_200_000) {
      throw new Error(`Playwright ${label} timeout must be between 1 second and 20 minutes.`);
    }
  }
  if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 60_000) {
    throw new Error("Playwright install backoff must be between 0 and 60 seconds.");
  }
}

function stopProcessGroup(child, signal) {
  if (!child.pid) return;

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupIsAlive(child) {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(
  child,
  { exitCheckIntervalMs, exitCheckTimeoutMs, isAlive, sleep },
) {
  let elapsedMs = 0;
  while (isAlive(child)) {
    if (elapsedMs >= exitCheckTimeoutMs) {
      throw new Error("The Playwright install process group remained alive after forced cleanup.");
    }
    const waitMs = Math.min(exitCheckIntervalMs, exitCheckTimeoutMs - elapsedMs);
    await sleep(waitMs);
    elapsedMs += waitMs;
  }
}

export async function terminateProcessGroup(
  child,
  {
    exitCheckIntervalMs = EXIT_CHECK_INTERVAL_MS,
    exitCheckTimeoutMs = EXIT_CHECK_TIMEOUT_MS,
    forceKillDelayMs = FORCE_KILL_DELAY_MS,
    isAlive = processGroupIsAlive,
    sleep = delay,
    stop = stopProcessGroup,
  } = {},
) {
  let terminationError;
  try {
    stop(child, "SIGTERM");
  } catch (error) {
    terminationError = error;
  }

  try {
    await sleep(forceKillDelayMs);
  } catch (error) {
    terminationError ??= error;
  }

  try {
    stop(child, "SIGKILL");
  } catch (error) {
    terminationError ??= error;
  }

  try {
    await waitForProcessGroupExit(child, {
      exitCheckIntervalMs,
      exitCheckTimeoutMs,
      isAlive,
      sleep,
    });
  } catch (error) {
    terminationError ??= error;
  }

  if (terminationError) throw terminationError;
}

function installArguments(phase, browsers) {
  if (!SUPPORTED_PHASES.has(phase)) {
    throw new Error(`Unsupported Playwright installation phase: ${String(phase)}`);
  }
  const command = phase === "dependencies" ? "install-deps" : "install";
  return ["--filter", "@omnifin/web", "exec", "playwright", command, ...browsers];
}

export function runPlaywrightInstallAttempt(
  phase,
  browsers,
  { spawnProcess = spawn, terminate = terminateProcessGroup, timeoutMs },
) {
  const args = installArguments(phase, browsers);
  return new Promise((resolveAttempt) => {
    const child = spawnProcess("pnpm", args, {
      detached: process.platform !== "win32",
      env: process.env,
      stdio: "inherit",
    });

    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    let timedOut = false;
    let timeoutTimer;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolveAttempt(Object.freeze(result));
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      void terminate(child).then(
        () => {
          settle({ code: exitCode, ok: false, reason: "timeout", signal: exitSignal });
        },
        () => {
          settle({ code: exitCode, ok: false, reason: "termination", signal: exitSignal });
        },
      );
    }, timeoutMs);

    child.once("error", () => {
      if (timedOut) return;
      settle({ code: null, ok: false, reason: "spawn", signal: null });
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (timedOut) return;
      settle({
        code,
        ok: code === 0,
        reason: code === 0 ? "success" : "exit",
        signal,
      });
    });
  });
}

function runDependencyInstallAttempt(browsers, options) {
  return runPlaywrightInstallAttempt("dependencies", browsers, options);
}

function runBrowserInstallAttempt(browsers, options) {
  return runPlaywrightInstallAttempt("browsers", browsers, options);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function writeDiagnostic(message) {
  process.stderr.write(`${message}\n`);
}

function writeResult(write, { attempt, attempts, phase, result }) {
  write(
    `[playwright-install] failure phase=${phase} attempt=${attempt}/${attempts} reason=${result.reason} code=${result.code ?? "none"} signal=${result.signal ?? "none"}`,
  );
}

export async function installPlaywright(
  browsers,
  {
    backoffMs = DEFAULT_BACKOFF_MS,
    browserAttempts = DEFAULT_BROWSER_ATTEMPTS,
    browserTimeoutMs = DEFAULT_BROWSER_TIMEOUT_MS,
    dependencyTimeoutMs = DEFAULT_DEPENDENCY_TIMEOUT_MS,
    runBrowserAttempt = runBrowserInstallAttempt,
    runDependencyAttempt = runDependencyInstallAttempt,
    sleep = delay,
    write = writeDiagnostic,
  } = {},
) {
  const targets = validateBrowsers(browsers);
  validateOptions({ backoffMs, browserAttempts, browserTimeoutMs, dependencyTimeoutMs });

  write(
    `[playwright-install] phase=dependencies attempt=1/1 browsers=${targets.join(",")} timeout_ms=${dependencyTimeoutMs}`,
  );
  const dependencyResult = await runDependencyAttempt(targets, {
    timeoutMs: dependencyTimeoutMs,
  });
  if (!dependencyResult.ok) {
    writeResult(write, {
      attempt: 1,
      attempts: 1,
      phase: "dependencies",
      result: dependencyResult,
    });
    throw new Error("Playwright operating-system dependency installation failed.");
  }
  write("[playwright-install] success phase=dependencies attempt=1/1");

  for (let attempt = 1; attempt <= browserAttempts; attempt += 1) {
    write(
      `[playwright-install] phase=browsers attempt=${attempt}/${browserAttempts} browsers=${targets.join(",")} timeout_ms=${browserTimeoutMs}`,
    );
    const result = await runBrowserAttempt(targets, { timeoutMs: browserTimeoutMs });
    if (result.ok) {
      write(`[playwright-install] success phase=browsers attempt=${attempt}/${browserAttempts}`);
      return;
    }

    writeResult(write, {
      attempt,
      attempts: browserAttempts,
      phase: "browsers",
      result,
    });
    if (attempt < browserAttempts) await sleep(backoffMs);
  }

  throw new Error(`Playwright browser installation failed after ${browserAttempts} attempts.`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  installPlaywright(process.argv.slice(2)).catch((error) => {
    writeDiagnostic(`[playwright-install] ${error.message}`);
    process.exitCode = 1;
  });
}
