import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_ATTEMPTS = 2;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_BACKOFF_MS = 10_000;

const FORCE_KILL_DELAY_MS = 10_000;
const SUPPORTED_BROWSERS = new Set(["chromium", "firefox", "webkit"]);

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

function validateOptions({ attempts, backoffMs, timeoutMs }) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
    throw new Error("Playwright install attempts must be an integer between 1 and 3.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("Playwright install timeout must be between 1 second and 10 minutes.");
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

export function runPlaywrightInstallAttempt(browsers, { timeoutMs }) {
  return new Promise((resolveAttempt) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@omnifin/web", "exec", "playwright", "install", "--with-deps", ...browsers],
      {
        detached: process.platform !== "win32",
        env: process.env,
        stdio: "inherit",
      },
    );

    let forceKillTimer;
    let settled = false;
    let timedOut = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopProcessGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        stopProcessGroup(child, "SIGKILL");
      }, FORCE_KILL_DELAY_MS);
    }, timeoutMs);

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveAttempt(Object.freeze(result));
    };

    child.once("error", () => {
      settle({ code: null, ok: false, reason: "spawn", signal: null });
    });
    child.once("exit", (code, signal) => {
      settle({
        code,
        ok: code === 0 && !timedOut,
        reason: timedOut ? "timeout" : code === 0 ? "success" : "exit",
        signal,
      });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function writeDiagnostic(message) {
  process.stderr.write(`${message}\n`);
}

export async function installPlaywright(
  browsers,
  {
    attempts = DEFAULT_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    runAttempt = runPlaywrightInstallAttempt,
    sleep = delay,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    write = writeDiagnostic,
  } = {},
) {
  const targets = validateBrowsers(browsers);
  validateOptions({ attempts, backoffMs, timeoutMs });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    write(
      `[playwright-install] attempt=${attempt}/${attempts} browsers=${targets.join(",")} timeout_ms=${timeoutMs}`,
    );
    const result = await runAttempt(targets, { timeoutMs });
    if (result.ok) {
      write(`[playwright-install] success attempt=${attempt}/${attempts}`);
      return;
    }

    write(
      `[playwright-install] failure attempt=${attempt}/${attempts} reason=${result.reason} code=${result.code ?? "none"} signal=${result.signal ?? "none"}`,
    );
    if (attempt < attempts) await sleep(backoffMs);
  }

  throw new Error(`Playwright runtime installation failed after ${attempts} attempts.`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  installPlaywright(process.argv.slice(2)).catch((error) => {
    writeDiagnostic(`[playwright-install] ${error.message}`);
    process.exitCode = 1;
  });
}
