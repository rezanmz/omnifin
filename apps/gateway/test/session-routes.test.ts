import { sessionResponseSchema } from "@omnifin/contracts/auth";
import { apiErrorSchema } from "@omnifin/contracts/errors";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  LOCAL_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_CSRF_HEADER,
} from "../src/auth/session-cookie.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";

const initialTime = new Date("2026-07-25T12:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 6),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 60 * 60 * 1_000,
      inactivityTtlMs: 10 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

function createDependencies() {
  let now = new Date(initialTime);
  let identifier = 0;
  let token = 0;
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    dependencies: {
      clock: () => new Date(now),
      createId: () => `route-fixture-${(identifier += 1)}`,
      createToken: () => Buffer.alloc(32, (token += 1)).toString("base64url"),
    },
  };
}

function sessionCookie(token: string) {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function setCookieHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join("; ") : (value ?? "");
}

describe("session routes", () => {
  it("returns an explicit unauthenticated response without creating browser state", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/auth/session" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(sessionResponseSchema.parse(response.json())).toEqual({
        csrfToken: null,
        principal: null,
      });
    } finally {
      await app.close();
    }
  });

  it("returns the principal and CSRF proof while rotating only the opaque cookie", async () => {
    const timing = createDependencies();
    const app = await createApp({
      config: testConfig(),
      database: openDatabase(":memory:"),
      sessionDependencies: timing.dependencies,
    });
    try {
      const issued = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      timing.advance(6 * 60 * 1_000);

      const response = await app.inject({
        headers: { cookie: sessionCookie(issued.sessionToken) },
        method: "GET",
        url: "/v1/auth/session",
      });
      const body = sessionResponseSchema.parse(response.json());
      const rotatedCookie = setCookieHeader(response.headers["set-cookie"]);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        csrfToken: issued.csrfToken,
        principal: {
          accountState: "recovery",
          authenticationMethod: { kind: "recovery" },
        },
      });
      expect(response.body).not.toContain(issued.sessionToken);
      expect(rotatedCookie).toMatch(/^__Host-omnifin_session=/);
      expect(rotatedCookie).toContain("Path=/");
      expect(rotatedCookie).toContain("HttpOnly");
      expect(rotatedCookie).toContain("Secure");
      expect(rotatedCookie).toContain("SameSite=Lax");
      expect(rotatedCookie).toContain("Expires=");
      expect(rotatedCookie).not.toContain("Domain=");
      expect(rotatedCookie).not.toContain(issued.sessionToken);
    } finally {
      await app.close();
    }
  });

  it("does not clear an unknown hash that may be stale after a concurrent rotation", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    try {
      const response = await app.inject({
        headers: { cookie: sessionCookie(Buffer.alloc(32, 88).toString("base64url")) },
        method: "GET",
        url: "/v1/auth/session",
      });

      expect(response.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(response.json())).toEqual({
        csrfToken: null,
        principal: null,
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("clears a malformed cookie using the hardened host-only attributes", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    try {
      const response = await app.inject({
        headers: { cookie: sessionCookie("malformed") },
        method: "GET",
        url: "/v1/auth/session",
      });

      const clearedCookie = setCookieHeader(response.headers["set-cookie"]);
      expect(clearedCookie).toMatch(/^__Host-omnifin_session=/);
      expect(clearedCookie).toContain("Path=/");
      expect(clearedCookie).toContain("HttpOnly");
      expect(clearedCookie).toContain("Secure");
      expect(clearedCookie).toContain("SameSite=Lax");
      expect(clearedCookie).not.toContain("Domain=");
      expect(clearedCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    } finally {
      await app.close();
    }
  });

  it("keeps parallel rotation-boundary reads authenticated without clearing the fresh cookie", async () => {
    const timing = createDependencies();
    const app = await createApp({
      config: testConfig(),
      database: openDatabase(":memory:"),
      sessionDependencies: timing.dependencies,
    });
    try {
      const issued = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      timing.advance(6 * 60 * 1_000);
      const headers = { cookie: sessionCookie(issued.sessionToken) };

      const rotating = await app.inject({ headers, method: "GET", url: "/v1/auth/session" });
      const racing = await app.inject({ headers, method: "GET", url: "/v1/auth/session" });

      expect(sessionResponseSchema.parse(rotating.json()).principal).not.toBeNull();
      expect(rotating.headers["set-cookie"]).toBeTruthy();
      expect(sessionResponseSchema.parse(racing.json()).principal).not.toBeNull();
      expect(racing.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("ignores the explicit local-development cookie name in secure deployments", async () => {
    const app = await createApp({ config: testConfig(), database: openDatabase(":memory:") });
    try {
      const untrusted = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const expected = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const response = await app.inject({
        headers: {
          cookie: `${LOCAL_SESSION_COOKIE_NAME}=${untrusted.sessionToken}; ${SESSION_COOKIE_NAME}=${expected.sessionToken}`,
        },
        method: "GET",
        url: "/v1/auth/session",
      });

      expect(sessionResponseSchema.parse(response.json()).principal?.sessionId).toBe(
        expected.principal.sessionId,
      );
    } finally {
      await app.close();
    }
  });

  it("uses a distinct non-Secure cookie name only for explicit local development", async () => {
    const timing = createDependencies();
    const config = {
      ...testConfig(),
      baseUrl: new URL("http://localhost:3000"),
      insecureLoopbackPreview: true,
      secureCookies: false,
    };
    const app = await createApp({
      config,
      database: openDatabase(":memory:"),
      sessionDependencies: timing.dependencies,
    });
    try {
      const issued = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      timing.advance(6 * 60 * 1_000);
      const response = await app.inject({
        headers: { cookie: `${LOCAL_SESSION_COOKIE_NAME}=${issued.sessionToken}` },
        method: "GET",
        url: "/v1/auth/session",
      });
      const cookie = setCookieHeader(response.headers["set-cookie"]);

      expect(cookie).toMatch(/^omnifin_local_session=/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Secure");
      expect(cookie).not.toContain("Domain=");
    } finally {
      await app.close();
    }
  });

  it("requires the exact public origin and a server-validated CSRF proof for logout", async () => {
    const timing = createDependencies();
    const database = openDatabase(":memory:");
    const app = await createApp({
      config: testConfig(),
      database,
      sessionDependencies: timing.dependencies,
    });
    try {
      const issued = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const cookie = sessionCookie(issued.sessionToken);

      const wrongOrigin = await app.inject({
        headers: {
          cookie,
          origin: "https://omnifin.example.attacker.test",
          [SESSION_CSRF_HEADER]: issued.csrfToken,
        },
        method: "DELETE",
        url: "/v1/auth/session",
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(apiErrorSchema.parse(wrongOrigin.json()).error.code).toBe("origin_denied");

      const missingCsrf = await app.inject({
        headers: { cookie, origin: "https://omnifin.example" },
        method: "DELETE",
        url: "/v1/auth/session",
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(missingCsrf.json()).error.code).toBe("csrf_denied");

      const wrongCsrf = await app.inject({
        headers: {
          cookie,
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: Buffer.alloc(32, 77).toString("base64url"),
        },
        method: "DELETE",
        url: "/v1/auth/session",
      });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(apiErrorSchema.parse(wrongCsrf.json()).error.code).toBe("csrf_denied");

      const loggedOut = await app.inject({
        headers: {
          cookie,
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: issued.csrfToken,
        },
        method: "DELETE",
        url: "/v1/auth/session",
      });
      expect(loggedOut.statusCode).toBe(204);
      expect(loggedOut.body).toBe("");
      expect(loggedOut.headers["cache-control"]).toBe("no-store");
      const clearedCookie = setCookieHeader(loggedOut.headers["set-cookie"]);
      expect(clearedCookie).toContain("HttpOnly");
      expect(clearedCookie).toContain("Secure");
      expect(clearedCookie).toContain("SameSite=Lax");

      const audit = database.sqlite
        .prepare(
          `select event_type as eventType, outcome
           from audit_events
           order by created_at, rowid`,
        )
        .all();
      expect(audit).toEqual([
        { eventType: "auth.session.created", outcome: "success" },
        { eventType: "auth.session.csrf_denied", outcome: "denied" },
        { eventType: "auth.session.logout", outcome: "success" },
      ]);

      const afterLogout = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/v1/auth/session",
      });
      expect(sessionResponseSchema.parse(afterLogout.json())).toEqual({
        csrfToken: null,
        principal: null,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects logout without a valid session before the handler can mutate state", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      const response = await app.inject({
        headers: {
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: Buffer.alloc(32, 55).toString("base64url"),
        },
        method: "DELETE",
        url: "/v1/auth/session",
      });

      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe("csrf_denied");
      expect(database.sqlite.prepare("select count(*) as count from audit_events").get()).toEqual({
        count: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("requires CSRF and clears the current browser after logout-all", async () => {
    const database = openDatabase(":memory:");
    const app = await createApp({ config: testConfig(), database });
    try {
      const issued = app.sessionService.createSession({
        attribution: { authMethod: "recovery" },
      });
      const cookie = sessionCookie(issued.sessionToken);
      const denied = await app.inject({
        headers: { cookie, origin: "https://omnifin.example" },
        method: "DELETE",
        url: "/v1/auth/sessions",
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorSchema.parse(denied.json()).error.code).toBe("csrf_denied");

      const response = await app.inject({
        headers: {
          cookie,
          origin: "https://omnifin.example",
          [SESSION_CSRF_HEADER]: issued.csrfToken,
        },
        method: "DELETE",
        url: "/v1/auth/sessions",
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(setCookieHeader(response.headers["set-cookie"])).toMatch(
        /__Host-omnifin_session=.*(?:Expires=Thu, 01 Jan 1970|Max-Age=0)/i,
      );
      expect(
        database.sqlite
          .prepare(
            "select count(*) as count from audit_events where event_type = 'auth.session.logout_all'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });
});
