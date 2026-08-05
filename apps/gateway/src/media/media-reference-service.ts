import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash, randomToken } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MEDIA_REFERENCE_PATTERN = /^media_[A-Za-z0-9_-]{22}$/u;
const MEDIA_REFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_MEDIA_REFERENCES_PER_USER = 1_024;
const MAX_REFERENCE_CREATION_ATTEMPTS = 8;

const artworkSchema = z.strictObject({
  backdropItemId: z.string().regex(IDENTIFIER_PATTERN).nullable(),
  posterItemId: z.string().regex(IDENTIFIER_PATTERN).nullable(),
});
const itemIdSchema = z.string().regex(IDENTIFIER_PATTERN);
const referenceTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const episodeNumberSchema = z.int().nonnegative().max(100_000).nullable();

const storedMediaReferenceV1Schema = z.strictObject({
  artwork: artworkSchema,
  itemId: itemIdSchema,
  schemaVersion: z.literal(1),
});

const storedMediaReferenceV2Schema = z
  .strictObject({
    artwork: artworkSchema,
    episodeNumber: episodeNumberSchema,
    itemId: itemIdSchema,
    kind: z.enum(["movie", "series", "episode", "other"]),
    schemaVersion: z.literal(2),
    seasonNumber: episodeNumberSchema,
    title: referenceTitleSchema,
    year: z.int().min(1870).max(2200).nullable(),
  })
  .superRefine((reference, context) => {
    const hasEpisodeNumbers = reference.seasonNumber !== null && reference.episodeNumber !== null;
    if ((reference.kind === "episode") !== hasEpisodeNumbers) {
      context.addIssue({
        code: "custom",
        message: "Only episode references can include complete episode coordinates.",
        path: ["episodeNumber"],
      });
    }
  });

const storedMediaReferenceV3Schema = z
  .strictObject({
    artwork: artworkSchema,
    episodeNumber: episodeNumberSchema,
    itemId: itemIdSchema,
    kind: z.enum(["movie", "series", "episode", "extra", "other", "person"]),
    schemaVersion: z.literal(3),
    seasonNumber: episodeNumberSchema,
    title: referenceTitleSchema,
    year: z.int().min(1870).max(2200).nullable(),
  })
  .superRefine((reference, context) => {
    const hasEpisodeNumbers = reference.seasonNumber !== null && reference.episodeNumber !== null;
    if ((reference.kind === "episode") !== hasEpisodeNumbers) {
      context.addIssue({
        code: "custom",
        message: "Only episode references can include complete episode coordinates.",
        path: ["episodeNumber"],
      });
    }
  });

const storedMediaReferenceSchema = z.union([
  storedMediaReferenceV3Schema,
  storedMediaReferenceV2Schema,
  storedMediaReferenceV1Schema,
]);
type StoredMediaReference = z.infer<typeof storedMediaReferenceSchema>;

export interface MediaReferenceInput {
  artwork: {
    backdropItemId: string | null;
    posterItemId: string | null;
  };
  episodeNumber: number | null;
  itemId: string;
  kind: "episode" | "extra" | "movie" | "other" | "person" | "series";
  seasonNumber: number | null;
  title: string;
  year: number | null;
}

export interface MediaReferenceLinkContext {
  linkId: string;
  linkRevision: number;
  userId: string;
}

export interface ResolvedMediaReference {
  artwork: z.infer<typeof artworkSchema>;
  episodeNumber: number | null;
  id: string;
  itemId: string;
  kind: "episode" | "extra" | "movie" | "other" | "person" | "series";
  schemaVersion: 1 | 2 | 3;
  seasonNumber: number | null;
  title: string | null;
  year: number | null;
  toJSON(): never;
}

export interface MediaReferenceDependencies {
  clock?: () => Date;
  createToken?: () => string;
}

export class MediaReferenceError extends Error {
  public readonly code = "media_reference_unavailable";

  public constructor(options?: ErrorOptions) {
    super("The media reference is no longer available.", options);
    this.name = "MediaReferenceError";
  }
}

interface StoredReferenceRow {
  encryptedPayload: string;
  id: string;
}

function assertLinkContext(context: MediaReferenceLinkContext) {
  if (
    !IDENTIFIER_PATTERN.test(context.userId) ||
    !IDENTIFIER_PATTERN.test(context.linkId) ||
    !Number.isSafeInteger(context.linkRevision) ||
    context.linkRevision < 0 ||
    context.linkRevision > 2_147_483_647
  ) {
    throw new MediaReferenceError();
  }
}

function validOperationTime(now: Date) {
  const value = now.getTime();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new MediaReferenceError();
  }
  return value;
}

function referenceContext(referenceId: string) {
  return `media_reference:jellyfin:${referenceId}`;
}

function storedPayload(input: MediaReferenceInput): StoredMediaReference {
  return storedMediaReferenceV3Schema.parse({
    artwork: input.artwork,
    episodeNumber: input.episodeNumber,
    itemId: input.itemId,
    kind: input.kind,
    schemaVersion: 3,
    seasonNumber: input.seasonNumber,
    title: input.title,
    year: input.year,
  });
}

function resolvedReference(id: string, payload: StoredMediaReference): ResolvedMediaReference {
  const normalized =
    payload.schemaVersion === 2 || payload.schemaVersion === 3
      ? payload
      : {
          ...payload,
          episodeNumber: null,
          kind: "other" as const,
          seasonNumber: null,
          title: null,
          year: null,
        };
  const reference = Object.create(null) as ResolvedMediaReference;
  for (const [key, value] of Object.entries({
    artwork: normalized.artwork,
    episodeNumber: normalized.episodeNumber,
    id,
    itemId: normalized.itemId,
    kind: normalized.kind,
    schemaVersion: normalized.schemaVersion,
    seasonNumber: normalized.seasonNumber,
    title: normalized.title,
    year: normalized.year,
  })) {
    Object.defineProperty(reference, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  Object.defineProperty(reference, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => {
      throw new TypeError("Resolved media references cannot be serialized.");
    },
    writable: false,
  });
  return Object.freeze(reference);
}

export class MediaReferenceService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: Pick<AppConfig, "encryptionKey">;
  readonly #createToken: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: MediaReferenceDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createToken = dependencies.createToken ?? (() => randomToken(16));
  }

  public createOrRefresh(
    context: MediaReferenceLinkContext,
    inputs: readonly MediaReferenceInput[],
  ): string[] {
    assertLinkContext(context);
    if (inputs.length > 50) throw new MediaReferenceError();
    let payloads: StoredMediaReference[];
    try {
      payloads = inputs.map(storedPayload);
    } catch (error) {
      throw new MediaReferenceError({ cause: error });
    }
    if (new Set(payloads.map(({ itemId }) => itemId)).size !== payloads.length) {
      throw new MediaReferenceError();
    }
    const now = validOperationTime(this.#clock());
    const expiresAt = now + MEDIA_REFERENCE_TTL_MS;
    if (!Number.isSafeInteger(expiresAt)) throw new MediaReferenceError();

    try {
      return this.#database.sqlite
        .transaction(() => {
          this.#database.sqlite
            .prepare(
              `delete from media_references
               where user_id = ?
                 and (expires_at <= ? or service_identity_link_id <> ? or link_revision <> ?)`,
            )
            .run(context.userId, now, context.linkId, context.linkRevision);

          const references = payloads.map((payload) =>
            this.#upsertReference(context, payload, now, expiresAt),
          );
          this.#enforceUserLimit(context.userId, references, now);
          return references;
        })
        .immediate();
    } catch (error) {
      if (error instanceof MediaReferenceError) throw error;
      throw new MediaReferenceError({ cause: error });
    }
  }

  public resolve(context: MediaReferenceLinkContext, referenceId: string): ResolvedMediaReference {
    assertLinkContext(context);
    if (!MEDIA_REFERENCE_PATTERN.test(referenceId)) throw new MediaReferenceError();
    const now = validOperationTime(this.#clock());

    try {
      return this.#database.sqlite
        .transaction(() => {
          const row = this.#database.sqlite
            .prepare(
              `select id, encrypted_payload as encryptedPayload
               from media_references
               where id = ?
                 and user_id = ?
                 and service_identity_link_id = ?
                 and link_revision = ?
                 and expires_at > ?`,
            )
            .get(referenceId, context.userId, context.linkId, context.linkRevision, now) as
            StoredReferenceRow | undefined;
          if (!row || !MEDIA_REFERENCE_PATTERN.test(row.id)) throw new MediaReferenceError();

          const decrypted = this.#cipher.decryptWithMetadata(
            row.encryptedPayload,
            referenceContext(row.id),
          );
          const payload = storedMediaReferenceSchema.parse(JSON.parse(decrypted.plaintext));
          const refreshedExpiry = now + MEDIA_REFERENCE_TTL_MS;
          const encryptedPayload = decrypted.needsReencryption
            ? this.#cipher.encrypt(JSON.stringify(payload), referenceContext(row.id))
            : row.encryptedPayload;
          const updated = this.#database.sqlite
            .prepare(
              `update media_references
               set encrypted_payload = ?, last_used_at = ?, expires_at = ?, updated_at = ?
               where id = ?
                 and user_id = ?
                 and service_identity_link_id = ?
                 and link_revision = ?`,
            )
            .run(
              encryptedPayload,
              now,
              refreshedExpiry,
              now,
              row.id,
              context.userId,
              context.linkId,
              context.linkRevision,
            );
          if (updated.changes !== 1) throw new MediaReferenceError();
          return resolvedReference(row.id, payload);
        })
        .immediate();
    } catch (error) {
      if (error instanceof MediaReferenceError) throw error;
      throw new MediaReferenceError({ cause: error });
    }
  }

  #upsertReference(
    context: MediaReferenceLinkContext,
    payload: StoredMediaReference,
    now: number,
    expiresAt: number,
  ) {
    const digest = privacyHash(
      "media_item",
      `${context.linkId}\0${context.linkRevision}\0${payload.itemId}`,
      this.#config.encryptionKey,
    );
    const existing = this.#database.sqlite
      .prepare(
        `select id, encrypted_payload as encryptedPayload
         from media_references
         where service_identity_link_id = ? and link_revision = ? and item_digest = ?`,
      )
      .get(context.linkId, context.linkRevision, digest) as StoredReferenceRow | undefined;
    if (existing) {
      if (!MEDIA_REFERENCE_PATTERN.test(existing.id)) throw new MediaReferenceError();
      const existingPayload = storedMediaReferenceSchema.parse(
        JSON.parse(this.#cipher.decrypt(existing.encryptedPayload, referenceContext(existing.id))),
      );
      const existingIsExtra =
        existingPayload.schemaVersion === 3 && existingPayload.kind === "extra";
      const payloadIsExtra = payload.schemaVersion === 3 && payload.kind === "extra";
      if (existingIsExtra !== payloadIsExtra) {
        throw new MediaReferenceError();
      }
      const encryptedPayload = this.#cipher.encrypt(
        JSON.stringify(payload),
        referenceContext(existing.id),
      );
      const updated = this.#database.sqlite
        .prepare(
          `update media_references
           set encrypted_payload = ?, last_used_at = ?, expires_at = ?, updated_at = ?
           where id = ? and user_id = ?`,
        )
        .run(encryptedPayload, now, expiresAt, now, existing.id, context.userId);
      if (updated.changes !== 1) throw new MediaReferenceError();
      return existing.id;
    }

    for (let attempt = 0; attempt < MAX_REFERENCE_CREATION_ATTEMPTS; attempt += 1) {
      const id = `media_${this.#createToken()}`;
      if (!MEDIA_REFERENCE_PATTERN.test(id)) throw new MediaReferenceError();
      const encryptedPayload = this.#cipher.encrypt(JSON.stringify(payload), referenceContext(id));
      try {
        this.#database.sqlite
          .prepare(
            `insert into media_references (
              id, user_id, service_identity_link_id, link_revision, item_digest,
              encrypted_payload, last_used_at, expires_at, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            context.userId,
            context.linkId,
            context.linkRevision,
            digest,
            encryptedPayload,
            now,
            expiresAt,
            now,
            now,
          );
        return id;
      } catch (error) {
        const collision = this.#database.sqlite
          .prepare("select 1 from media_references where id = ?")
          .get(id);
        if (!collision) throw error;
      }
    }
    throw new MediaReferenceError();
  }

  #enforceUserLimit(userId: string, protectedIds: readonly string[], now: number) {
    const row = this.#database.sqlite
      .prepare("select count(*) as count from media_references where user_id = ?")
      .get(userId) as { count: number };
    if (row.count <= MAX_MEDIA_REFERENCES_PER_USER) return;
    const excess = row.count - MAX_MEDIA_REFERENCES_PER_USER;
    const placeholders = protectedIds.map(() => "?").join(", ") || "''";
    this.#database.sqlite
      .prepare(
        `delete from media_references
         where id in (
           select id from media_references
           where user_id = ? and last_used_at <= ? and id not in (${placeholders})
           order by last_used_at asc, id asc
           limit ?
         )`,
      )
      .run(userId, now, ...protectedIds, excess);
    const remaining = this.#database.sqlite
      .prepare("select count(*) as count from media_references where user_id = ?")
      .get(userId) as { count: number };
    if (remaining.count > MAX_MEDIA_REFERENCES_PER_USER) throw new MediaReferenceError();
  }
}
