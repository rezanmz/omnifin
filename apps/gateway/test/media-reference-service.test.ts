import { describe, expect, it } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  MediaReferenceError,
  MediaReferenceService,
} from "../src/media/media-reference-service.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const encryptionKey = Buffer.alloc(32, 91);
const context = { linkId: "link-1", linkRevision: 3, userId: "user-1" };

function seededDatabase() {
  const database = openDatabase(":memory:");
  database.migrate();
  database.sqlite.exec(`
    insert into users (id, display_name, role, status)
    values
      ('user-1', 'Riley', 'viewer', 'active'),
      ('user-2', 'Morgan', 'viewer', 'active');

    insert into connector_configs (
      id, type, display_name, base_url, encrypted_credentials, enabled
    ) values (
      'jellyfin-home', 'jellyfin', 'Home Jellyfin',
      'https://jellyfin.example.test', 'encrypted', 1
    );

    insert into service_identity_links (
      id, user_id, service, connector_id, external_server_id, external_user_id,
      external_username, external_display_name, encrypted_access_token, device_id,
      token_created_at, health_state, revision, created_at, updated_at
    ) values
      (
        'link-1', 'user-1', 'jellyfin', 'jellyfin-home', 'server-1', 'external-1',
        'riley', 'Riley', 'encrypted-token', 'device-1', 1000, 'linked', 3, 1000, 1000
      ),
      (
        'link-2', 'user-2', 'jellyfin', 'jellyfin-home', 'server-1', 'external-2',
        'morgan', 'Morgan', 'encrypted-token', 'device-2', 1000, 'linked', 1, 1000, 1000
      );
  `);
  return database;
}

function service(
  database: DatabaseHandle,
  options: { clock?: () => Date; tokens?: string[] } = {},
) {
  const tokens = [...(options.tokens ?? ["a".repeat(22), "b".repeat(22), "c".repeat(22)])];
  return new MediaReferenceService(
    database,
    { encryptionKey },
    {
      clock: options.clock ?? (() => new Date(2_000)),
      createToken: () => tokens.shift() ?? "z".repeat(22),
    },
  );
}

const media = {
  artwork: {
    backdropItemId: "series-upstream-1",
    posterItemId: "series-upstream-1",
  },
  episodeNumber: 3,
  itemId: "episode-upstream-1",
  kind: "episode" as const,
  seasonNumber: 2,
  title: "Northern Lights",
  year: 2026,
};

describe("MediaReferenceService", () => {
  it("creates a stable opaque reference while encrypting every upstream identifier", () => {
    const database = seededDatabase();
    try {
      const references = service(database).createOrRefresh(context, [media]);
      expect(references).toEqual([`media_${"a".repeat(22)}`]);
      expect(service(database).createOrRefresh(context, [media])).toEqual(references);

      const row = database.sqlite
        .prepare(
          `select id, item_digest as itemDigest, encrypted_payload as encryptedPayload
           from media_references`,
        )
        .get() as { encryptedPayload: string; id: string; itemDigest: string };
      expect(row.id).toBe(references[0]);
      expect(row.itemDigest).toHaveLength(22);
      expect(JSON.stringify(row)).not.toMatch(/episode-upstream|series-upstream/u);
      expect(database.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("resolves only for the exact user, identity link, and link revision", () => {
    const database = seededDatabase();
    try {
      const reference = service(database).createOrRefresh(context, [media])[0]!;
      const resolved = service(database).resolve(context, reference);
      expect(resolved).toMatchObject({
        artwork: media.artwork,
        episodeNumber: 3,
        id: reference,
        itemId: media.itemId,
        kind: "episode",
        schemaVersion: 3,
        seasonNumber: 2,
        title: "Northern Lights",
        year: 2026,
      });
      expect(Object.keys(resolved)).toEqual([]);
      expect(() => JSON.stringify(resolved)).toThrow(/cannot be serialized/i);
      expect(() => service(database).resolve({ ...context, userId: "user-2" }, reference)).toThrow(
        MediaReferenceError,
      );
      expect(() => service(database).resolve({ ...context, linkId: "link-2" }, reference)).toThrow(
        MediaReferenceError,
      );
      expect(() => service(database).resolve({ ...context, linkRevision: 4 }, reference)).toThrow(
        MediaReferenceError,
      );
    } finally {
      database.close();
    }
  });

  it("stores local bonus videos as a distinct playable reference kind", () => {
    const database = seededDatabase();
    try {
      const extra = { ...media, episodeNumber: null, kind: "extra" as const, seasonNumber: null };
      const reference = service(database).createOrRefresh(context, [extra])[0]!;
      expect(service(database).resolve(context, reference)).toMatchObject({
        itemId: media.itemId,
        kind: "extra",
        schemaVersion: 3,
      });
    } finally {
      database.close();
    }
  });

  it("never reclassifies an existing title reference as a local extra", () => {
    const database = seededDatabase();
    try {
      const mediaService = service(database);
      const reference = mediaService.createOrRefresh(context, [media])[0]!;
      const conflictingExtra = {
        ...media,
        episodeNumber: null,
        kind: "extra" as const,
        seasonNumber: null,
      };

      expect(() => mediaService.createOrRefresh(context, [conflictingExtra])).toThrow(
        MediaReferenceError,
      );
      expect(mediaService.resolve(context, reference)).toMatchObject({
        itemId: media.itemId,
        kind: "episode",
      });
    } finally {
      database.close();
    }
  });

  it("keeps legacy version-one references playable but ineligible for inferred operations", () => {
    const database = seededDatabase();
    try {
      const reference = service(database).createOrRefresh(context, [media])[0]!;
      const legacyPayload = {
        artwork: media.artwork,
        itemId: media.itemId,
        schemaVersion: 1,
      };
      database.sqlite
        .prepare("update media_references set encrypted_payload = ? where id = ?")
        .run(
          new EnvelopeCipher(encryptionKey).encrypt(
            JSON.stringify(legacyPayload),
            `media_reference:jellyfin:${reference}`,
          ),
          reference,
        );

      expect(service(database).resolve(context, reference)).toMatchObject({
        episodeNumber: null,
        itemId: media.itemId,
        kind: "other",
        schemaVersion: 1,
        seasonNumber: null,
        title: null,
        year: null,
      });
    } finally {
      database.close();
    }
  });

  it("expires references and prunes stale link revisions on the next feed", () => {
    const database = seededDatabase();
    let now = 2_000;
    const references = service(database, { clock: () => new Date(now) }).createOrRefresh(context, [
      media,
    ]);
    try {
      now += 7 * 24 * 60 * 60 * 1_000;
      expect(() =>
        service(database, { clock: () => new Date(now) }).resolve(context, references[0]!),
      ).toThrow(MediaReferenceError);

      const newContext = { ...context, linkRevision: 4 };
      database.sqlite
        .prepare("update service_identity_links set revision = 4 where id = 'link-1'")
        .run();
      service(database, {
        clock: () => new Date(now),
        tokens: ["d".repeat(22)],
      }).createOrRefresh(newContext, [{ ...media, itemId: "episode-upstream-2" }]);
      expect(
        database.sqlite.prepare("select count(*) as count from media_references").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("fails closed for corrupt ciphertext, malformed input, and identifier collisions", () => {
    const database = seededDatabase();
    try {
      const mediaService = service(database, {
        tokens: ["a".repeat(22), "a".repeat(22), "b".repeat(22)],
      });
      const first = mediaService.createOrRefresh(context, [media])[0]!;
      const second = mediaService.createOrRefresh(context, [
        { ...media, itemId: "episode-upstream-2" },
      ])[0]!;
      expect(first).toBe(`media_${"a".repeat(22)}`);
      expect(second).toBe(`media_${"b".repeat(22)}`);

      database.sqlite
        .prepare(
          "update media_references set encrypted_payload = 'v2.corrupt.value.tag' where id = ?",
        )
        .run(first);
      expect(() => mediaService.resolve(context, first)).toThrow(MediaReferenceError);
      let invalidInputFailure: unknown;
      try {
        mediaService.createOrRefresh(context, [{ ...media, itemId: "unsafe/item" }]);
      } catch (error) {
        invalidInputFailure = error;
      }
      expect(invalidInputFailure).toBeInstanceOf(MediaReferenceError);
      expect((invalidInputFailure as Error).message).not.toContain("unsafe/item");
      expect(() => mediaService.resolve(context, "episode-upstream-1")).toThrow(
        MediaReferenceError,
      );
      expect(() => mediaService.createOrRefresh(context, [media, media])).toThrow(
        MediaReferenceError,
      );
    } finally {
      database.close();
    }
  });
});
