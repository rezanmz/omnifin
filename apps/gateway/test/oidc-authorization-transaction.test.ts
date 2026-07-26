import { calculatePKCECodeChallenge } from "openid-client";
import { describe, expect, it } from "vitest";
import {
  canonicalLocalReturnPath,
  canonicalOidcCallbackUri,
  LOCAL_OIDC_BROWSER_BINDING_COOKIE_NAME,
  OIDC_BROWSER_BINDING_COOKIE_NAME,
  OidcAuthorizationTransactionError,
  OidcAuthorizationTransactionService,
  type CreateOidcAuthorizationTransactionInput,
  type OidcAuthorizationTransactionDependencies,
  writeOidcBrowserBindingCookie,
} from "../src/auth/oidc/authorization-transaction.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { authTransactions, oidcProviders } from "../src/db/schema.js";
import { EnvelopeCipher, hashToken } from "../src/security/crypto.js";
import type { OidcProviderRuntimeBinding } from "../src/auth/oidc/provider-registry.js";

const initialTime = new Date("2026-07-25T12:00:00.000Z");

function transactionConfig(
  overrides: Partial<Pick<AppConfig, "baseUrl" | "environment" | "secureCookies">> = {},
) {
  return {
    baseUrl: new URL("https://omnifin.example"),
    encryptionKey: Buffer.alloc(32, 12),
    environment: "test" as const,
    secureCookies: true,
    ...overrides,
  };
}

function seedProvider(database: DatabaseHandle, id = "oidc-home") {
  database.db
    .insert(oidcProviders)
    .values({
      clientId: "omnifin",
      displayName: "Home identity",
      id,
      issuer: `https://${id}.example.test/application/o/omnifin/`,
      slug: id,
    })
    .run();
}

function opaqueToken(fill: number) {
  return Buffer.alloc(32, fill).toString("base64url");
}

const providerRuntimeBinding = opaqueToken(200) as OidcProviderRuntimeBinding;

class TestOidcAuthorizationTransactionService extends OidcAuthorizationTransactionService {
  public override create(
    input: Omit<CreateOidcAuthorizationTransactionInput, "providerRuntimeBinding"> & {
      providerRuntimeBinding?: OidcProviderRuntimeBinding;
    },
  ) {
    return super.create({ providerRuntimeBinding, ...input });
  }
}

function createHarness(database: DatabaseHandle) {
  let now = new Date(initialTime);
  let identifier = 0;
  let state = 0;
  let binding = 40;
  let verifier = 80;
  let nonce = 120;
  const dependencies: OidcAuthorizationTransactionDependencies = {
    clock: () => new Date(now),
    createBrowserBinding: () => opaqueToken((binding += 1)),
    createCodeVerifier: () => opaqueToken((verifier += 1)),
    createId: () => `oidc-transaction-${(identifier += 1)}`,
    createNonce: () => opaqueToken((nonce += 1)),
    createState: () => opaqueToken((state += 1)),
  };
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    service: new TestOidcAuthorizationTransactionService(
      database,
      transactionConfig(),
      dependencies,
    ),
  };
}

function expectInvalidTransaction(action: () => unknown, rejectedValues: string[] = []) {
  try {
    action();
    throw new Error("Expected the transaction to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(OidcAuthorizationTransactionError);
    expect(error).toMatchObject({ code: "oidc_transaction_invalid" });
    const visibleError = `${String(error)}\n${error instanceof Error ? (error.stack ?? "") : ""}`;
    for (const value of rejectedValues) {
      if (value.length > 0) expect(visibleError).not.toContain(value);
    }
  }
}

async function expectUnavailableTransaction(
  action: () => Promise<unknown>,
  rejectedValues: string[] = [],
) {
  try {
    await action();
    throw new Error("Expected transaction creation to be unavailable.");
  } catch (error) {
    expect(error).toBeInstanceOf(OidcAuthorizationTransactionError);
    expect(error).toMatchObject({ code: "oidc_transaction_unavailable" });
    const visibleError = `${String(error)}\n${error instanceof Error ? (error.stack ?? "") : ""}`;
    for (const value of rejectedValues) {
      if (value.length > 0) expect(visibleError).not.toContain(value);
    }
  }
}

async function expectInvalidTransactionAsync(
  action: () => Promise<unknown>,
  rejectedValues: string[] = [],
) {
  try {
    await action();
    throw new Error("Expected the transaction to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(OidcAuthorizationTransactionError);
    expect(error).toMatchObject({ code: "oidc_transaction_invalid" });
    const visibleError = `${String(error)}\n${error instanceof Error ? (error.stack ?? "") : ""}`;
    for (const value of rejectedValues) {
      if (value.length > 0) expect(visibleError).not.toContain(value);
    }
  }
}

describe("OidcAuthorizationTransactionService", () => {
  it("creates and consumes a ten-minute PKCE transaction without persisting browser secrets", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);

      const created = await service.create({
        providerId: "oidc-home",
        returnPath: "/library?tab=movies",
      });
      const stored = database.db.select().from(authTransactions).get();

      expect(created).toMatchObject({
        codeChallengeMethod: "S256",
        expiresAt: new Date("2026-07-25T12:10:00.000Z"),
        providerId: "oidc-home",
        providerRuntimeBinding,
        redirectUri: "https://omnifin.example/api/auth/oidc/callback/oidc-home",
        returnPath: "/library?tab=movies",
      });
      expect(created.state).toHaveLength(43);
      expect(created.browserBindingToken).toHaveLength(43);
      expect(created.nonce).toHaveLength(43);
      expect(created.codeChallenge).toBe(await calculatePKCECodeChallenge(opaqueToken(81)));
      expect(stored).toMatchObject({
        browserBindingHash: hashToken(created.browserBindingToken),
        providerId: "oidc-home",
        stateHash: hashToken(created.state),
      });
      const persisted = JSON.stringify(stored);
      expect(persisted).not.toContain(created.state);
      expect(persisted).not.toContain(created.browserBindingToken);
      expect(persisted).not.toContain(created.nonce);
      expect(persisted).not.toContain(opaqueToken(81));
      expect(stored?.encryptedCodeVerifier).toMatch(/^v2\./);
      expect(stored?.encryptedNonce).toMatch(/^v2\./);

      const consumed = service.consume({
        browserBindingToken: created.browserBindingToken,
        providerId: "oidc-home",
        state: created.state,
      });

      expect(consumed).toMatchObject({
        codeVerifier: opaqueToken(81),
        expectedState: created.state,
        nonce: created.nonce,
        providerRuntimeBinding,
        redirectUri: created.redirectUri,
        returnPath: created.returnPath,
      });
      expect(database.db.select().from(authTransactions).get()?.consumedAt).toEqual(initialTime);
      const cipher = new EnvelopeCipher(transactionConfig().encryptionKey);
      expect(
        cipher.decrypt(
          stored?.encryptedCodeVerifier ?? "",
          `oidc-transaction:${stored?.id}:code-verifier`,
        ),
      ).toBe(opaqueToken(81));
      expect(
        JSON.parse(
          cipher.decrypt(stored?.encryptedNonce ?? "", `oidc-transaction:${stored?.id}:nonce`),
        ),
      ).toEqual({
        nonce: created.nonce,
        providerId: "oidc-home",
        providerRuntimeBinding,
        schemaVersion: 1,
      });
    } finally {
      database.close();
    }
  });

  it("reuses one browser binding while keeping parallel tabs independently consumable", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);

      const first = await service.create({ providerId: "oidc-home", returnPath: "/first" });
      const second = await service.create({
        browserBindingToken: first.browserBindingToken,
        providerId: "oidc-home",
        returnPath: "/second",
      });

      expect(second.browserBindingToken).toBe(first.browserBindingToken);
      expect(second.state).not.toBe(first.state);
      expect(
        database.db
          .select()
          .from(authTransactions)
          .all()
          .map((row) => row.browserBindingHash),
      ).toEqual([hashToken(first.browserBindingToken), hashToken(first.browserBindingToken)]);
      expect(
        service.consume({
          browserBindingToken: second.browserBindingToken,
          providerId: "oidc-home",
          state: second.state,
        }).returnPath,
      ).toBe("/second");
      expect(
        service.consume({
          browserBindingToken: first.browserBindingToken,
          providerId: "oidc-home",
          state: first.state,
        }).returnPath,
      ).toBe("/first");
    } finally {
      database.close();
    }
  });

  it("replaces a malformed binding cookie and uses hardened production generators by default", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const service = new TestOidcAuthorizationTransactionService(database, transactionConfig());

      const created = await service.create({
        browserBindingToken: "malformed-cookie",
        providerId: "oidc-home",
      });

      expect(created.browserBindingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(
        service.consume({
          browserBindingToken: created.browserBindingToken,
          providerId: "oidc-home",
          state: created.state,
        }).codeVerifier,
      ).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    } finally {
      database.close();
    }
  });

  it("rejects replay without revealing whether the state was previously valid", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);
      const created = await service.create({ providerId: "oidc-home" });
      const input = {
        browserBindingToken: created.browserBindingToken,
        providerId: "oidc-home",
        state: created.state,
      };

      service.consume(input);

      expectInvalidTransaction(() => service.consume(input), [created.state]);
    } finally {
      database.close();
    }
  });

  it("binds state to the exact provider without consuming a valid transaction on mix-up", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      seedProvider(database, "oidc-work");
      const { service } = createHarness(database);
      const created = await service.create({ providerId: "oidc-home" });

      expectInvalidTransaction(
        () =>
          service.consume({
            browserBindingToken: created.browserBindingToken,
            providerId: "oidc-work",
            state: created.state,
          }),
        [created.state],
      );
      expect(
        service.consume({
          browserBindingToken: created.browserBindingToken,
          providerId: "oidc-home",
          state: created.state,
        }).providerId,
      ).toBe("oidc-home");
    } finally {
      database.close();
    }
  });

  it("rejects a stolen state presented without the originating browser binding", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);
      const victim = await service.create({ providerId: "oidc-home" });
      const attacker = await service.create({ providerId: "oidc-home" });

      expectInvalidTransaction(
        () =>
          service.consume({
            browserBindingToken: attacker.browserBindingToken,
            providerId: "oidc-home",
            state: victim.state,
          }),
        [victim.state, attacker.browserBindingToken],
      );
      expect(
        service.consume({
          browserBindingToken: victim.browserBindingToken,
          providerId: "oidc-home",
          state: victim.state,
        }).transactionId,
      ).toBe("oidc-transaction-1");
    } finally {
      database.close();
    }
  });

  it("burns an exactly expired transaction so a later wall-clock rollback cannot revive it", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const harness = createHarness(database);
      const created = await harness.service.create({ providerId: "oidc-home" });
      harness.advance(10 * 60 * 1_000);

      expectInvalidTransaction(
        () =>
          harness.service.consume({
            browserBindingToken: created.browserBindingToken,
            providerId: "oidc-home",
            state: created.state,
          }),
        [created.state],
      );
      expect(database.db.select().from(authTransactions).all()).toHaveLength(0);

      harness.advance(-5 * 60 * 1_000);
      expectInvalidTransaction(
        () =>
          harness.service.consume({
            browserBindingToken: created.browserBindingToken,
            providerId: "oidc-home",
            state: created.state,
          }),
        [created.state],
      );
    } finally {
      database.close();
    }
  });

  it("burns a future-created transaction observed after wall-clock rollback", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const harness = createHarness(database);
      const created = await harness.service.create({ providerId: "oidc-home" });
      harness.advance(-60 * 1_000);

      expectInvalidTransaction(
        () =>
          harness.service.consume({
            browserBindingToken: created.browserBindingToken,
            providerId: "oidc-home",
            state: created.state,
          }),
        [created.state],
      );
      expect(database.db.select().from(authTransactions).all()).toHaveLength(0);

      harness.advance(2 * 60 * 1_000);
      expectInvalidTransaction(
        () =>
          harness.service.consume({
            browserBindingToken: created.browserBindingToken,
            providerId: "oidc-home",
            state: created.state,
          }),
        [created.state],
      );
    } finally {
      database.close();
    }
  });

  it("fails malformed callback inputs through one bounded public error", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);
      const created = await service.create({ providerId: "oidc-home" });
      const malformedValues = ["invalid provider/segment", "not-base64url", "a".repeat(5_000)];

      for (const value of malformedValues) {
        expectInvalidTransaction(
          () =>
            service.consume({
              browserBindingToken: value,
              providerId: value,
              state: value,
            }),
          [value],
        );
      }
      expect(database.db.select().from(authTransactions).get()?.consumedAt).toBeNull();
      expect(
        service.consume({
          browserBindingToken: created.browserBindingToken,
          providerId: "oidc-home",
          state: created.state,
        }).providerId,
      ).toBe("oidc-home");
    } finally {
      database.close();
    }
  });

  it("rejects malformed transaction creation payloads before persistence", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);
      const oversizedProvider = "p".repeat(129);

      await expectInvalidTransactionAsync(() => service.create(null as never));
      await expectInvalidTransactionAsync(
        () => service.create({ providerId: oversizedProvider }),
        [oversizedProvider],
      );
      await expectInvalidTransactionAsync(() =>
        service.create({
          providerId: "oidc-home",
          providerRuntimeBinding: "malformed" as OidcProviderRuntimeBinding,
        }),
      );
      const strictService = new OidcAuthorizationTransactionService(database, transactionConfig());
      await expectInvalidTransactionAsync(() =>
        strictService.create({ providerId: "oidc-home" } as never),
      );
      await expectInvalidTransactionAsync(() =>
        service.create({ providerId: "oidc-home", returnPath: null as never }),
      );
      expect(database.db.select().from(authTransactions).all()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("consumes a transaction even when field-bound ciphertext fails integrity checks", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);
      const created = await service.create({ providerId: "oidc-home" });
      const stored = database.db.select().from(authTransactions).get();
      database.sqlite
        .prepare(
          `update auth_transactions
           set encrypted_code_verifier = ?, encrypted_nonce = ?
           where id = ?`,
        )
        .run(stored?.encryptedNonce, stored?.encryptedCodeVerifier, stored?.id);

      const input = {
        browserBindingToken: created.browserBindingToken,
        providerId: "oidc-home",
        state: created.state,
      };
      expectInvalidTransaction(
        () => service.consume(input),
        [created.browserBindingToken, created.nonce, created.state],
      );

      expect(database.db.select().from(authTransactions).get()?.consumedAt).toEqual(initialTime);
      expectInvalidTransaction(() => service.consume(input), [created.state]);
    } finally {
      database.close();
    }
  });

  it("fails closed after atomically consuming a legacy nonce-only encrypted payload", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);
      const created = await service.create({ providerId: "oidc-home" });
      const stored = database.db.select().from(authTransactions).get();
      const legacyPayload = new EnvelopeCipher(transactionConfig().encryptionKey).encrypt(
        created.nonce,
        `oidc-transaction:${stored?.id}:nonce`,
      );
      database.sqlite
        .prepare("update auth_transactions set encrypted_nonce = ? where id = ?")
        .run(legacyPayload, stored?.id);

      const input = {
        browserBindingToken: created.browserBindingToken,
        providerId: "oidc-home",
        state: created.state,
      };
      expectInvalidTransaction(() => service.consume(input), [created.nonce, created.state]);
      expect(database.db.select().from(authTransactions).get()?.consumedAt).toEqual(initialTime);
      expectInvalidTransaction(() => service.consume(input), [created.state]);
    } finally {
      database.close();
    }
  });

  it("rejects absolute, scheme-relative, backslash, control, and nested encoded return targets", () => {
    const attacks = [
      "",
      "https://attacker.example/callback",
      "//attacker.example/callback",
      "\\\\attacker.example\\callback",
      "/\\attacker.example/callback",
      "/%5cattacker.example/callback",
      "/%255cattacker.example/callback",
      "/%2f%2fattacker.example/callback",
      "/%252f%252fattacker.example/callback",
      "/%25%32%66%25%32%66attacker.example/callback",
      "/%25%35%63attacker.example/callback",
      "/%25%30%64attacker.example/callback",
      "/%0d%0aLocation:%20https:%2f%2fattacker.example",
      "/%ff",
      "/malformed%2",
      `/${"a".repeat(2_048)}`,
    ];

    for (const attack of attacks) {
      expectInvalidTransaction(() => canonicalLocalReturnPath(attack), [attack]);
    }
    expect(canonicalLocalReturnPath("/")).toBe("/");
    expect(canonicalLocalReturnPath("/library?tab=movies#recent")).toBe(
      "/library?tab=movies#recent",
    );
    expect(canonicalLocalReturnPath("/search?q=100%25%20ready")).toBe("/search?q=100%25%20ready");
    expect(canonicalLocalReturnPath("/search?q=%25%32%35ready")).toBe("/search?q=%25%32%35ready");
  });

  it("derives the callback only from the configured public origin and fixed rewrite path", () => {
    const configuredBase = new URL("https://omnifin.example/private/base/path/");

    expect(canonicalOidcCallbackUri(configuredBase, "tenant:home")).toBe(
      "https://omnifin.example/api/auth/oidc/callback/tenant%3Ahome",
    );
    expect(configuredBase.toString()).toBe("https://omnifin.example/private/base/path/");
  });

  it("writes an exact host-only secure binding cookie and an isolated loopback fallback", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const secureHarness = createHarness(database);
      const secureTransaction = await secureHarness.service.create({ providerId: "oidc-home" });
      const captured: Array<{
        name: string;
        options: {
          domain?: string;
          expires?: Date;
          httpOnly?: boolean;
          path?: string;
          sameSite?: string;
          secure?: boolean;
        };
        value: string;
      }> = [];
      const reply = {
        setCookie(name: string, value: string, options: (typeof captured)[number]["options"]) {
          captured.push({ name, options, value });
          return reply;
        },
      };

      writeOidcBrowserBindingCookie(
        reply,
        transactionConfig(),
        secureTransaction.browserBindingToken,
        secureTransaction.expiresAt,
      );
      expect(captured[0]).toEqual({
        name: OIDC_BROWSER_BINDING_COOKIE_NAME,
        options: {
          expires: secureTransaction.expiresAt,
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: true,
        },
        value: secureTransaction.browserBindingToken,
      });
      expect(captured[0]?.options).not.toHaveProperty("domain");

      const localConfig = transactionConfig({
        baseUrl: new URL("http://127.0.0.1:3000"),
        environment: "development",
        secureCookies: false,
      });
      const localService = new TestOidcAuthorizationTransactionService(database, localConfig, {
        createBrowserBinding: () => opaqueToken(201),
        createCodeVerifier: () => opaqueToken(202),
        createId: () => "oidc-local-transaction",
        createNonce: () => opaqueToken(203),
        createState: () => opaqueToken(204),
      });
      const localTransaction = await localService.create({ providerId: "oidc-home" });
      writeOidcBrowserBindingCookie(
        reply,
        localConfig,
        localTransaction.browserBindingToken,
        localTransaction.expiresAt,
      );
      expect(captured[1]).toMatchObject({
        name: LOCAL_OIDC_BROWSER_BINDING_COOKIE_NAME,
        options: { httpOnly: true, path: "/", sameSite: "lax", secure: false },
      });
      expect(captured[1]?.options).not.toHaveProperty("domain");
    } finally {
      database.close();
    }
  });

  it("rejects insecure public, production fallback, and Secure-over-HTTP configurations", () => {
    const database = openDatabase(":memory:");
    try {
      const invalidConfigurations = [
        transactionConfig({
          baseUrl: new URL("http://media.example"),
          environment: "development",
          secureCookies: false,
        }),
        transactionConfig({
          baseUrl: new URL("http://localhost:3000"),
          environment: "production",
          secureCookies: false,
        }),
        transactionConfig({
          baseUrl: new URL("http://localhost:3000"),
          environment: "development",
          secureCookies: true,
        }),
      ];

      for (const config of invalidConfigurations) {
        expect(() => new OidcAuthorizationTransactionService(database, config)).toThrow(
          expect.objectContaining({ code: "oidc_transaction_unavailable" }),
        );
      }
    } finally {
      database.close();
    }
  });

  it("retries identifier and state collisions without reusing a collided authorization secret", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const ids = ["transaction-1", "transaction-1", "transaction-2", "transaction-2"];
      const states = [opaqueToken(1), opaqueToken(1), opaqueToken(1), opaqueToken(2)];
      let index = -1;
      const service = new TestOidcAuthorizationTransactionService(database, transactionConfig(), {
        clock: () => new Date(initialTime),
        createBrowserBinding: () => opaqueToken(44),
        createCodeVerifier: () => opaqueToken(90 + Math.max(index, 0)),
        createId: () => ids[(index += 1)] ?? "unexpected-identifier",
        createNonce: () => opaqueToken(130 + Math.max(index, 0)),
        createState: () => states[index] ?? opaqueToken(250),
      });

      const first = await service.create({ providerId: "oidc-home" });
      const second = await service.create({
        browserBindingToken: first.browserBindingToken,
        providerId: "oidc-home",
      });

      expect(first.state).toBe(opaqueToken(1));
      expect(second.state).toBe(opaqueToken(2));
      expect(database.db.select().from(authTransactions).all()).toHaveLength(2);
      expect(
        service.consume({
          browserBindingToken: second.browserBindingToken,
          providerId: "oidc-home",
          state: second.state,
        }).codeVerifier,
      ).toBe(opaqueToken(93));
    } finally {
      database.close();
    }
  });

  it("cleans expired rows in a bounded deterministic batch", () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      seedProvider(database);
      const { service } = createHarness(database);
      const createdAt = new Date(initialTime.getTime() - 20 * 60 * 1_000);
      const expiresAt = new Date(initialTime.getTime() - 10 * 60 * 1_000);
      database.db
        .insert(authTransactions)
        .values(
          Array.from({ length: 70 }, (_, index) => ({
            browserBindingHash: hashToken(opaqueToken(200)),
            createdAt,
            encryptedCodeVerifier: "v2.fixture-code-verifier",
            encryptedNonce: "v2.fixture-nonce",
            expiresAt,
            id: `expired-${String(index).padStart(3, "0")}`,
            providerId: "oidc-home",
            redirectUri: "https://omnifin.example/api/auth/oidc/callback/oidc-home",
            returnPath: "/",
            stateHash: hashToken(opaqueToken(index + 1)),
          })),
        )
        .run();

      expect(service.cleanupExpired()).toBe(64);
      expect(database.db.select().from(authTransactions).all()).toHaveLength(6);
      expect(service.cleanupExpired(256)).toBe(6);
      expect(database.db.select().from(authTransactions).all()).toHaveLength(0);
      expect(() => service.cleanupExpired(257)).toThrow(
        expect.objectContaining({ code: "oidc_transaction_unavailable" }),
      );
    } finally {
      database.close();
    }
  });

  it("redacts provider, state, binding, verifier, nonce, and return target from failures", async () => {
    const database = openDatabase(":memory:");
    try {
      database.migrate();
      const privateProvider = "private-provider";
      const privateBinding = opaqueToken(221);
      const privateVerifier = opaqueToken(222);
      const privateNonce = opaqueToken(223);
      const privateState = opaqueToken(224);
      const privateReturnPath = "/private?continuation=classified";
      const service = new TestOidcAuthorizationTransactionService(database, transactionConfig(), {
        clock: () => new Date(initialTime),
        createBrowserBinding: () => privateBinding,
        createCodeVerifier: () => privateVerifier,
        createId: () => "private-transaction",
        createNonce: () => privateNonce,
        createState: () => privateState,
      });

      await expectUnavailableTransaction(
        () => service.create({ providerId: privateProvider, returnPath: privateReturnPath }),
        [
          privateProvider,
          privateBinding,
          privateVerifier,
          privateNonce,
          privateState,
          privateReturnPath,
        ],
      );
    } finally {
      database.close();
    }
  });
});
