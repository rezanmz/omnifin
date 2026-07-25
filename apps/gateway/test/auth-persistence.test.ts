import { roleMappingSchema } from "@omnifin/contracts/auth";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import {
  externalIdentities,
  oidcProviders,
  roleMappings,
  sessions,
  users,
} from "../src/db/schema.js";
import { privacyHash } from "../src/security/crypto.js";

describe("authentication persistence invariants", () => {
  it("round-trips the complete role-mapping contract without losing claim semantics", () => {
    const database = openDatabase(":memory:");
    database.migrate();
    database.db
      .insert(oidcProviders)
      .values({
        clientId: "omnifin",
        displayName: "Home identity",
        id: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        slug: "home",
      })
      .run();

    const mapping = roleMappingSchema.parse({
      id: "operators",
      providerId: "oidc-home",
      claimPath: ["realm_access", "groups"],
      operator: "contains_all",
      values: ["media-operators", "trusted"],
      role: "operator",
      priority: 100,
      enabled: true,
    });
    database.db
      .insert(roleMappings)
      .values({
        id: mapping.id,
        providerId: mapping.providerId,
        claimPathJson: JSON.stringify(mapping.claimPath),
        operator: mapping.operator,
        valuesJson: JSON.stringify(mapping.values),
        role: mapping.role,
        priority: mapping.priority,
        enabled: mapping.enabled,
      })
      .run();

    const stored = database.db.select().from(roleMappings).get();
    expect(
      roleMappingSchema.parse({
        ...stored,
        claimPath: JSON.parse(stored?.claimPathJson ?? "null"),
        values: JSON.parse(stored?.valuesJson ?? "null"),
      }),
    ).toEqual(mapping);
    database.close();
  });

  it("binds an OIDC session to its provider, external identity, and private upstream sid", () => {
    const database = openDatabase(":memory:");
    database.migrate();
    database.db
      .insert(users)
      .values({ id: "user-1", displayName: "Riley", status: "active" })
      .run();
    database.db
      .insert(oidcProviders)
      .values({
        clientId: "omnifin",
        displayName: "Home identity",
        id: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        slug: "home",
      })
      .run();
    database.db
      .insert(externalIdentities)
      .values({
        id: "identity-1",
        userId: "user-1",
        providerId: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        subject: "subject-1",
        lastLoginAt: new Date("2026-07-25T12:00:00.000Z"),
      })
      .run();

    const sidHash = privacyHash("upstream-session-identifier", Buffer.alloc(32, 7));
    database.db
      .insert(sessions)
      .values({
        id: "session-1",
        tokenHash: "token-hash",
        userId: "user-1",
        authMethod: "oidc",
        oidcProviderId: "oidc-home",
        externalIdentityId: "identity-1",
        oidcSessionIdHash: sidHash,
        csrfTokenHash: "csrf-hash",
        lastSeenAt: new Date("2026-07-25T12:00:00.000Z"),
        expiresAt: new Date("2026-07-25T13:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-07-26T12:00:00.000Z"),
      })
      .run();

    expect(database.db.select().from(sessions).get()).toMatchObject({
      authMethod: "oidc",
      externalIdentityId: "identity-1",
      oidcProviderId: "oidc-home",
      oidcSessionIdHash: sidHash,
      userId: "user-1",
    });
    database.close();
  });

  it("rejects OIDC session attribution that does not match the linked identity", () => {
    const database = openDatabase(":memory:");
    database.migrate();
    database.db
      .insert(users)
      .values({ id: "user-1", displayName: "Riley", status: "active" })
      .run();
    database.db
      .insert(oidcProviders)
      .values([
        {
          clientId: "omnifin",
          displayName: "Home identity",
          id: "oidc-home",
          issuer: "https://id.example.test/application/o/omnifin/",
          slug: "home",
        },
        {
          clientId: "omnifin",
          displayName: "Work identity",
          id: "oidc-work",
          issuer: "https://work-id.example.test/application/o/omnifin/",
          slug: "work",
        },
      ])
      .run();
    database.db
      .insert(externalIdentities)
      .values({
        id: "identity-1",
        userId: "user-1",
        providerId: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        subject: "subject-1",
        lastLoginAt: new Date("2026-07-25T12:00:00.000Z"),
      })
      .run();

    expect(() =>
      database.db
        .insert(sessions)
        .values({
          id: "session-1",
          tokenHash: "token-hash",
          userId: "user-1",
          authMethod: "oidc",
          oidcProviderId: "oidc-work",
          externalIdentityId: "identity-1",
          csrfTokenHash: "csrf-hash",
          lastSeenAt: new Date("2026-07-25T12:00:00.000Z"),
          expiresAt: new Date("2026-07-25T13:00:00.000Z"),
          absoluteExpiresAt: new Date("2026-07-26T12:00:00.000Z"),
        })
        .run(),
    ).toThrow(/foreign key/i);
    database.close();
  });

  it("keeps every external identity bound to its provider's immutable issuer", () => {
    const database = openDatabase(":memory:");
    database.migrate();
    database.db
      .insert(users)
      .values({ id: "user-1", displayName: "Riley", status: "active" })
      .run();
    database.db
      .insert(oidcProviders)
      .values({
        clientId: "omnifin",
        displayName: "Home identity",
        id: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        slug: "home",
      })
      .run();

    expect(() =>
      database.db
        .insert(externalIdentities)
        .values({
          id: "identity-mismatched",
          userId: "user-1",
          providerId: "oidc-home",
          issuer: "https://other-id.example.test/application/o/omnifin/",
          subject: "subject-mismatched",
          lastLoginAt: new Date("2026-07-25T12:00:00.000Z"),
        })
        .run(),
    ).toThrow(/foreign key/i);

    database.db
      .insert(externalIdentities)
      .values({
        id: "identity-matched",
        userId: "user-1",
        providerId: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        subject: "subject-matched",
        lastLoginAt: new Date("2026-07-25T12:00:00.000Z"),
      })
      .run();
    expect(() =>
      database.sqlite
        .prepare("update oidc_providers set issuer = ? where id = ?")
        .run("https://replacement.example.test/application/o/omnifin/", "oidc-home"),
    ).toThrow(/foreign key/i);
    database.close();
  });

  it("rejects malformed role mappings and OIDC attribution on direct Jellyfin sessions", () => {
    const database = openDatabase(":memory:");
    database.migrate();
    database.db
      .insert(users)
      .values({ id: "user-1", displayName: "Riley", status: "active" })
      .run();
    database.db
      .insert(oidcProviders)
      .values({
        clientId: "omnifin",
        displayName: "Home identity",
        id: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        slug: "home",
      })
      .run();
    database.db
      .insert(externalIdentities)
      .values({
        id: "identity-1",
        userId: "user-1",
        providerId: "oidc-home",
        issuer: "https://id.example.test/application/o/omnifin/",
        subject: "subject-1",
        lastLoginAt: new Date("2026-07-25T12:00:00.000Z"),
      })
      .run();

    expect(() =>
      database.db
        .insert(roleMappings)
        .values({
          id: "invalid-mapping",
          providerId: "oidc-home",
          claimPathJson: "{}",
          operator: "equals",
          valuesJson: '["operator"]',
          role: "operator",
          priority: 1,
          enabled: true,
        })
        .run(),
    ).toThrow(/check constraint/i);
    expect(() =>
      database.db
        .insert(sessions)
        .values({
          id: "session-1",
          tokenHash: "token-hash",
          userId: "user-1",
          authMethod: "jellyfin",
          oidcProviderId: "oidc-home",
          externalIdentityId: "identity-1",
          csrfTokenHash: "csrf-hash",
          lastSeenAt: new Date("2026-07-25T12:00:00.000Z"),
          expiresAt: new Date("2026-07-25T13:00:00.000Z"),
          absoluteExpiresAt: new Date("2026-07-26T12:00:00.000Z"),
        })
        .run(),
    ).toThrow(/check constraint/i);
    database.close();
  });
});
