import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { databaseQuiescenceMarkerPath } from "../src/db/maintenance-lock.js";
import { shutdownGateway } from "../src/main.js";
import { RuntimeDrainCoordinator } from "../src/runtime/drain.js";

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 4),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    jellyfinUrl: new URL("https://jellyfin.example"),
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 12 * 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 15 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

async function responseFromSocket(port: number, path: string) {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(socket, "close");
  return Buffer.concat(chunks).toString("utf8");
}

describe("runtime drain", () => {
  it("is irreversible and idempotent while preserving the first reason", () => {
    const coordinator = new RuntimeDrainCoordinator();

    expect(coordinator.state).toBe("running");
    expect(coordinator.beginDrain("SIGTERM")).toBe(true);
    expect(coordinator.beginDrain("SIGINT")).toBe(false);
    expect(coordinator.state).toBe("draining");
    expect(coordinator.metadata).toBe("SIGTERM");
    expect(coordinator.reason).toBeInstanceOf(DOMException);
    expect(coordinator.reason?.name).toBe("AbortError");
    expect(coordinator.signal.reason).toBe(coordinator.reason);
    expect(coordinator.signal.aborted).toBe(true);
  });

  it("exposes a request signal that aborts on a real client disconnect", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    let signal: AbortSignal | undefined;
    let abortCount = 0;
    let cancellationSource: unknown;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    app.get("/v1/test-request-abort", async (request) => {
      signal = request.operationSignal;
      const operationSignal = request.operationSignal;
      operationSignal.addEventListener("abort", () => {
        abortCount += 1;
        cancellationSource = (operationSignal.reason as { cancellationSource?: unknown })
          .cancellationSource;
      });
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { aborted: request.operationSignal.aborted };
    });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind.");
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      await once(socket, "connect");
      socket.write(
        "GET /v1/test-request-abort HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      await enteredPromise;
      socket.destroy();
      await once(socket, "close");
      await waitFor(() => signal?.aborted === true);
      expect(signal?.reason).toBeInstanceOf(DOMException);
      expect((signal?.reason as DOMException).name).toBe("AbortError");
      expect(abortCount).toBe(1);
      expect(cancellationSource).toBe("client_abort");
      release();
    } finally {
      release?.();
      await app.close();
    }
  });

  it("keeps a JSON POST operation live after body completion during delayed work", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.post(
      "/v1/test-json-operation",
      { config: { omnifinSecurity: { kind: "public-browser" } } },
      async (request) => {
        signal = request.operationSignal;
        entered();
        await work;
        return { ok: true };
      },
    );

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind.");
      const responsePromise = new Promise<{ body: string; statusCode: number }>(
        (resolve, reject) => {
          const client = httpRequest(
            {
              host: "127.0.0.1",
              method: "POST",
              path: "/v1/test-json-operation",
              port: address.port,
              headers: {
                "content-type": "application/json",
                origin: "https://omnifin.example",
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () =>
                resolve({
                  body: Buffer.concat(chunks).toString("utf8"),
                  statusCode: response.statusCode ?? 0,
                }),
              );
            },
          );
          client.on("error", reject);
          client.end(JSON.stringify({ payload: "complete" }));
        },
      );

      await enteredPromise;
      expect(signal?.aborted).toBe(false);
      release();
      await expect(responsePromise).resolves.toMatchObject({
        statusCode: 200,
        body: '{"ok":true}',
      });
    } finally {
      release?.();
      await app.close();
    }
  });

  it("aborts a partial JSON body once with the client-abort source", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    let signal: AbortSignal | undefined;
    let abortCount = 0;
    let cancellationSource: unknown;
    let requestObserved!: () => void;
    const requestObservedPromise = new Promise<void>((resolve) => {
      requestObserved = resolve;
    });
    app.post(
      "/v1/test-partial-json",
      {
        config: { omnifinSecurity: { kind: "public-browser" } },
        onRequest: async (request) => {
          signal = request.operationSignal;
          const operationSignal = request.operationSignal;
          operationSignal.addEventListener("abort", () => {
            abortCount += 1;
            cancellationSource = (operationSignal.reason as { cancellationSource?: unknown })
              .cancellationSource;
          });
          requestObserved();
        },
      },
      async () => {
        return { ok: true };
      },
    );

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind.");
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      await once(socket, "connect");
      socket.write(
        'POST /v1/test-partial-json HTTP/1.1\r\nHost: localhost\r\nOrigin: https://omnifin.example\r\nContent-Type: application/json\r\nContent-Length: 32\r\nConnection: close\r\n\r\n{"payload":"partial',
      );
      await requestObservedPromise;
      socket.destroy();
      await once(socket, "close");
      await waitFor(() => signal?.aborted === true);
      expect(abortCount).toBe(1);
      expect(cancellationSource).toBe("client_abort");
    } finally {
      await app.close();
    }
  });

  it("aborts on a premature reply close and cleans up a hijacked reply", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    let prematureSignal: AbortSignal | undefined;
    let prematureAbortCount = 0;
    let prematureCancellationSource: unknown;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    app.post(
      "/v1/test-premature-close",
      { config: { omnifinSecurity: { kind: "public-browser" } } },
      async (request) => {
        prematureSignal = request.operationSignal;
        prematureSignal.addEventListener("abort", () => {
          prematureAbortCount += 1;
          prematureCancellationSource = (
            prematureSignal?.reason as { cancellationSource?: unknown }
          ).cancellationSource;
        });
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true };
      },
    );
    let hijackedSignal: AbortSignal | undefined;
    app.get("/v1/test-hijacked", async (request, reply) => {
      hijackedSignal = request.operationSignal;
      reply.hijack();
      reply.raw.end("hijacked");
    });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind.");

      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      await once(socket, "connect");
      socket.write(
        'POST /v1/test-premature-close HTTP/1.1\r\nHost: localhost\r\nOrigin: https://omnifin.example\r\nContent-Type: application/json\r\nContent-Length: 22\r\nConnection: close\r\n\r\n{"payload":"complete"}',
      );
      await enteredPromise;
      socket.destroy();
      await once(socket, "close");
      await waitFor(() => prematureSignal?.aborted === true);
      expect((prematureSignal?.reason as DOMException).name).toBe("AbortError");
      expect(prematureAbortCount).toBe(1);
      expect(prematureCancellationSource).toBe("response_closed");
      release();

      const response = await responseFromSocket(address.port, "/v1/test-hijacked");
      expect(response).toContain("hijacked");
      expect(hijackedSignal?.aborted).toBe(false);
      app.runtimeDrain.beginDrain("after hijack");
      expect(hijackedSignal?.aborted).toBe(false);
    } finally {
      release?.();
      await app.close();
    }
  });

  it("aborts an in-flight handler with AbortError when drain begins", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let handlerReason: unknown;
    app.get("/v1/test-drain-abort", async (request) => {
      entered();
      try {
        await new Promise<void>((_resolve, reject) => {
          request.operationSignal.addEventListener(
            "abort",
            () => reject(request.operationSignal.reason),
            { once: true },
          );
        });
      } catch (error) {
        handlerReason = error;
        throw error;
      }
      return { ok: true };
    });

    try {
      const responsePromise = app.inject({ method: "GET", url: "/v1/test-drain-abort" });
      await enteredPromise;
      app.runtimeDrain.beginDrain("SIGTERM");
      await responsePromise;
      expect(handlerReason).toBeInstanceOf(DOMException);
      expect((handlerReason as DOMException).name).toBe("AbortError");
      expect(handlerReason).toBe(app.runtimeDrain.reason);
    } finally {
      await app.close();
    }
  });

  it("cleans the request signal's drain listener after a normal response", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    let signal: AbortSignal | undefined;
    app.get("/v1/test-request-normal", async (request) => {
      signal = request.operationSignal;
      return { ok: true };
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/test-request-normal" });
      expect(response.statusCode).toBe(200);
      app.runtimeDrain.beginDrain("test drain");
      expect(signal?.aborted).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("cleans the request signal after the error response finishes", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    let signal: AbortSignal | undefined;
    app.get("/v1/test-request-error", async (request) => {
      signal = request.operationSignal;
      throw new Error("expected test failure");
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/test-request-error" });
      expect(response.statusCode).toBe(500);
      app.runtimeDrain.beginDrain("after error");
      expect(signal?.aborted).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("flips readiness immediately and wins a started deferred readiness check", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    try {
      app.runtimeDrain.beginDrain("test drain");
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    } finally {
      await app.close();
    }

    const racedDatabase = openDatabase(":memory:");
    const racedApp = await createApp({ config: testConfig(), database: racedDatabase });
    try {
      let readinessCheckStarted = false;
      const originalPrepare = racedDatabase.sqlite.prepare.bind(racedDatabase.sqlite);
      racedDatabase.sqlite.prepare = ((sql: string) => {
        if (sql.startsWith("select name from sqlite_schema")) {
          readinessCheckStarted = true;
          racedApp.runtimeDrain.beginDrain("raced drain");
        }
        return originalPrepare(sql);
      }) as typeof racedDatabase.sqlite.prepare;
      const response = await racedApp.inject({ method: "GET", url: "/readyz" });
      expect(readinessCheckStarted).toBe(true);
      expect(response.statusCode).toBe(503);
    } finally {
      await racedApp.close();
    }
  });

  it("drains before direct app.close closes the database", async () => {
    const database = openDatabase(":memory:");
    const originalClose = database.close;
    database.close = vi.fn(() => {
      expect(app.runtimeDrain.state).toBe("draining");
      originalClose();
    });
    const app = await createApp({ config: testConfig(), database });

    await app.close();
    expect(app.runtimeDrain.state).toBe("draining");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes once and clears a successful shutdown watchdog", async () => {
    const coordinator = new RuntimeDrainCoordinator();
    const close = vi.fn(async () => undefined);
    const log = { error: vi.fn() };
    const app = {
      appConfig: { databaseUrl: ":memory:" },
      close,
      log,
      runtimeDrain: coordinator,
    } as unknown as Parameters<typeof shutdownGateway>[0];
    const timer = {} as ReturnType<typeof setTimeout>;
    const setTimeout = vi.fn(() => timer) as unknown as typeof globalThis.setTimeout;
    const clearTimeout = vi.fn() as unknown as typeof globalThis.clearTimeout;

    await shutdownGateway(app, "SIGTERM", { clearTimeout, setTimeout });

    expect(coordinator.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledWith(timer);
  });

  it("records database quiescence only after the gateway closes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omnifin-gateway-shutdown-"));
    const databaseUrl = path.join(directory, "omnifin.db");
    const coordinator = new RuntimeDrainCoordinator();
    const close = vi.fn(async () => {
      await expect(lstat(databaseQuiescenceMarkerPath(databaseUrl))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    const app = {
      appConfig: { databaseUrl },
      close,
      log: { error: vi.fn() },
      runtimeDrain: coordinator,
    } as unknown as Parameters<typeof shutdownGateway>[0];

    try {
      await shutdownGateway(app, "SIGTERM");
      await expect(lstat(databaseQuiescenceMarkerPath(databaseUrl))).resolves.toMatchObject({
        mode: expect.any(Number),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
  it("uses the watchdog only while app.close remains hung", async () => {
    const coordinator = new RuntimeDrainCoordinator();
    let release!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const log = { error: vi.fn() };
    const app = {
      appConfig: { databaseUrl: ":memory:" },
      close,
      log,
      runtimeDrain: coordinator,
    } as unknown as Parameters<typeof shutdownGateway>[0];
    let triggerWatchdog!: () => void;
    const timer = {} as ReturnType<typeof setTimeout>;
    const setTimeout = vi.fn((callback: () => void) => {
      triggerWatchdog = callback;
      return timer;
    }) as unknown as typeof globalThis.setTimeout;
    const clearTimeout = vi.fn() as unknown as typeof globalThis.clearTimeout;
    const exitCode = process.exitCode;
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit ${code ?? ""}`);
      });

    try {
      const closing = shutdownGateway(app, "SIGINT", { clearTimeout, setTimeout });
      expect(() => triggerWatchdog()).toThrow("exit 1");
      expect(exit).toHaveBeenCalledWith(1);
      release();
      await closing;
    } finally {
      exit.mockRestore();
      process.exitCode = exitCode;
    }
  });
});
