import pino from "pino";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createBootstrapLoggerOptions } from "./logger.js";
import { asStartupError, startupFailureDetails } from "./startup-error.js";
import { createRuntimeDrainCoordinator } from "./runtime/drain.js";

export const SHUTDOWN_WATCHDOG_MS = 18_000;

type GatewayApp = Awaited<ReturnType<typeof createApp>>;

export interface ShutdownDependencies {
  clearTimeout: typeof clearTimeout;
  setTimeout: typeof setTimeout;
}

const shutdownDependencies: ShutdownDependencies = {
  clearTimeout,
  setTimeout,
};

export async function shutdownGateway(
  app: GatewayApp,
  signal: NodeJS.Signals,
  dependencies: ShutdownDependencies = shutdownDependencies,
) {
  app.runtimeDrain.beginDrain(signal);
  let closureSettled = false;
  const watchdog = dependencies.setTimeout(() => {
    if (closureSettled) return;
    app.log.error(
      { operation: "gateway.shutdown", signal, timeoutMs: SHUTDOWN_WATCHDOG_MS },
      "Gateway shutdown watchdog expired",
    );
    process.exitCode = 1;
    process.exit(1);
  }, SHUTDOWN_WATCHDOG_MS);

  try {
    await app.close();
  } finally {
    closureSettled = true;
    dependencies.clearTimeout(watchdog);
  }
}

export async function runMain() {
  const runtimeDrain = createRuntimeDrainCoordinator();
  let app: GatewayApp | undefined;
  let shutdownSignal: NodeJS.Signals | undefined;
  let closePromise: Promise<void> | undefined;
  let shutdownErrorReported = false;

  const reportShutdownError = (error: unknown) => {
    if (shutdownErrorReported) return;
    shutdownErrorReported = true;
    app?.log.error({ err: error, operation: "gateway.shutdown" }, "Graceful shutdown failed");
    process.exitCode = 1;
  };

  const beginShutdown = (signal: NodeJS.Signals) => {
    shutdownSignal ??= signal;
    runtimeDrain.beginDrain(shutdownSignal);
    if (!app) return closePromise;
    if (!closePromise) {
      app.log.info(
        { operation: "gateway.shutdown", signal: shutdownSignal },
        "Graceful shutdown started",
      );
      closePromise = shutdownGateway(app, shutdownSignal);
    }
    return closePromise;
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    const pendingClose = beginShutdown(signal);
    if (pendingClose) void pendingClose.catch(reportShutdownError);
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    app = await createApp({ runtimeDrain });

    const awaitRequestedShutdown = async () => {
      if (!shutdownSignal) return;
      const pendingClose = beginShutdown(shutdownSignal);
      if (!pendingClose) return;
      try {
        await pendingClose;
      } catch (error) {
        reportShutdownError(error);
      }
    };

    if (shutdownSignal) {
      await awaitRequestedShutdown();
      return;
    }

    try {
      await app.listen({ host: app.appConfig.host, port: app.appConfig.port });
    } catch (error) {
      if (shutdownSignal) {
        await awaitRequestedShutdown();
        return;
      }
      throw asStartupError(error, "server_listen_failed");
    }

    if (shutdownSignal) {
      await awaitRequestedShutdown();
      return;
    }
    app.log.info(
      { operation: "gateway.listen", port: app.appConfig.port },
      "Gateway is accepting requests",
    );
  } catch (error) {
    const startupFailure = startupFailureDetails(error);
    const logger =
      app?.log ??
      pino(
        createBootstrapLoggerOptions(process.env.NODE_ENV),
        pino.destination({ dest: 2, sync: true }),
      );
    logger.fatal(
      {
        err: error,
        operation: "gateway.startup",
        startupErrorCategory: startupFailure.category,
        startupErrorCode: startupFailure.code,
      },
      "Gateway startup failed",
    );

    try {
      if (shutdownSignal) {
        const pendingClose = beginShutdown(shutdownSignal);
        if (pendingClose) await pendingClose;
      } else if (app) {
        closePromise ??= app.close();
        await closePromise;
      }
    } catch (closeError) {
      logger.error(
        { err: closeError, operation: "gateway.shutdown" },
        "Gateway cleanup after startup failure failed",
      );
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMain();
}
