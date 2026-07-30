import { describe, expect, it } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  DiscoveryArtworkReferenceError,
  DiscoveryArtworkReferenceService,
} from "../src/discovery/artwork-reference-service.js";

const encryptionKey = Buffer.alloc(32, 83);
const initialTime = new Date("2026-07-29T12:00:00.000Z");

function seededDatabase() {
  const database = openDatabase(":memory:");
  database.migrate();
  database.sqlite.exec(`
    insert into users (id, display_name, role, status)
    values
      ('viewer-user', 'Viewer', 'viewer', 'active'),
      ('other-user', 'Other viewer', 'viewer', 'active');

    insert into connector_configs (
      id, type, display_name, base_url, encrypted_credentials, enabled
    ) values (
      'seerr-main', 'seerr', 'Seerr', 'https://seerr.example.test', 'encrypted', 1
    );
  `);
  return database;
}

function service(database: DatabaseHandle, clock: () => Date = () => initialTime) {
  return new DiscoveryArtworkReferenceService(database, { encryptionKey }, clock);
}

const artwork = {
  kind: "poster" as const,
  path: "/t/p/original/private-poster.webp",
};

describe("DiscoveryArtworkReferenceService", () => {
  it("stores an encrypted, deterministic reference and resolves it only for its user", () => {
    const database = seededDatabase();
    try {
      const references = service(database).create("viewer-user", "seerr-main", [artwork]);
      expect(references).toHaveLength(1);
      expect(references[0]).toMatch(/^discovery_art_[A-Za-z0-9_-]{22}$/u);
      expect(service(database).create("viewer-user", "seerr-main", [artwork])).toEqual(references);

      const row = database.sqlite
        .prepare(
          `select id, item_digest as itemDigest, encrypted_payload as encryptedPayload
           from discovery_artwork_references`,
        )
        .get() as { encryptedPayload: string; id: string; itemDigest: string };
      expect(row.id).toBe(references[0]);
      expect(row.itemDigest).toHaveLength(22);
      expect(JSON.stringify(row)).not.toContain("private-poster");
      expect(service(database).resolve("viewer-user", references[0]!)).toEqual({
        connectorId: "seerr-main",
        id: references[0],
        kind: "poster",
        path: artwork.path,
      });
      expect(() => service(database).resolve("other-user", references[0]!)).toThrow(
        DiscoveryArtworkReferenceError,
      );
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("expires references after one day and prunes them on the next feed", () => {
    const database = seededDatabase();
    let currentTime = initialTime.getTime();
    const artworkService = service(database, () => new Date(currentTime));
    try {
      const reference = artworkService.create("viewer-user", "seerr-main", [artwork])[0]!;
      currentTime += 24 * 60 * 60 * 1_000;
      expect(() => artworkService.resolve("viewer-user", reference)).toThrow(
        DiscoveryArtworkReferenceError,
      );

      const refreshed = artworkService.create("viewer-user", "seerr-main", [
        { kind: "backdrop", path: "/t/p/original/new-backdrop.jpg" },
      ]);
      expect(refreshed).toHaveLength(1);
      expect(
        database.sqlite.prepare("select count(*) as count from discovery_artwork_references").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("fails closed for malformed inputs, excessive batches, and tampered storage", () => {
    const database = seededDatabase();
    const artworkService = service(database);
    try {
      const reference = artworkService.create("viewer-user", "seerr-main", [artwork])[0]!;
      database.sqlite
        .prepare("update discovery_artwork_references set encrypted_payload = ? where id = ?")
        .run("v2.corrupt.value.tag", reference);
      expect(() => artworkService.resolve("viewer-user", reference)).toThrow(
        DiscoveryArtworkReferenceError,
      );

      const unsafePath = "https://upstream.example/private-poster.jpg";
      let failure: unknown;
      try {
        artworkService.create("viewer-user", "seerr-main", [{ kind: "poster", path: unsafePath }]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DiscoveryArtworkReferenceError);
      expect((failure as Error).message).not.toContain(unsafePath);
      expect(() =>
        artworkService.create(
          "viewer-user",
          "seerr-main",
          Array.from({ length: 145 }, () => artwork),
        ),
      ).toThrow(DiscoveryArtworkReferenceError);
      expect(() => artworkService.resolve("viewer-user", "private-poster.jpg")).toThrow(
        DiscoveryArtworkReferenceError,
      );
    } finally {
      database.close();
    }
  });

  it("detects a validly encrypted payload whose integrity digest no longer matches", () => {
    const database = seededDatabase();
    const artworkService = service(database);
    try {
      const reference = artworkService.create("viewer-user", "seerr-main", [artwork])[0]!;
      database.sqlite
        .prepare("update discovery_artwork_references set item_digest = ? where id = ?")
        .run("x".repeat(22), reference);
      expect(() => artworkService.resolve("viewer-user", reference)).toThrow(
        DiscoveryArtworkReferenceError,
      );
    } finally {
      database.close();
    }
  });
});
