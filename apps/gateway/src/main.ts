import pino from "pino";
import { createApp } from "./app.js";
import { createBootstrapLoggerOptions } from "./logger.js";
import { asStartupError, startupFailureDetails } from "./startup-error.js";

let app: Awaited<ReturnType<typeof createApp>> | undefined;

try {
  app = await createApp();

  let shuttingDown = false;
  const close = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app?.log.info({ operation: "gateway.shutdown", signal }, "Graceful shutdown started");
    try {
      await app?.close();
    } catch (error) {
      app?.log.error({ err: error, operation: "gateway.shutdown" }, "Graceful shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  try {
    await app.listen({ host: app.appConfig.host, port: app.appConfig.port });
  } catch (error) {
    throw asStartupError(error, "server_listen_failed");
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
    await app?.close();
  } catch (closeError) {
    logger.error(
      { err: closeError, operation: "gateway.shutdown" },
      "Gateway cleanup after startup failure failed",
    );
  }
  process.exitCode = 1;
}
