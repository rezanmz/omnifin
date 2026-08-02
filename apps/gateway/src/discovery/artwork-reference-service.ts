import { discoveryArtworkReferenceIdSchema } from "@omnifin/contracts/discovery";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";

const ARTWORK_REFERENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ARTWORK_REFERENCES_PER_USER = 2_048;
const MAX_ARTWORK_REFERENCES_PER_FEED = 144;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const artworkPathSchema = z
  .string()
  .trim()
  .min(6)
  .max(300)
  .regex(/^\/[A-Za-z0-9/_-]+\.(?:jpe?g|png|webp)$/iu)
  .refine((value) => !value.includes("..") && !value.includes("//"));
const storedArtworkReferenceSchema = z.strictObject({
  kind: z.enum(["backdrop", "poster", "profile"]),
  path: artworkPathSchema,
  schemaVersion: z.literal(1),
});

export interface DiscoveryArtworkReferenceInput {
  kind: "backdrop" | "poster" | "profile";
  path: string;
}

export interface ResolvedDiscoveryArtworkReference {
  connectorId: string;
  id: string;
  kind: "backdrop" | "poster" | "profile";
  path: string;
}

interface StoredReferenceRow {
  connectorId: string;
  encryptedPayload: string;
  id: string;
  itemDigest: string;
}

export class DiscoveryArtworkReferenceError extends Error {
  public constructor(options?: ErrorOptions) {
    super("The discovery artwork reference is no longer available.", options);
    this.name = "DiscoveryArtworkReferenceError";
  }
}

function referenceContext(referenceId: string) {
  return `discovery_artwork_reference:${referenceId}`;
}

function operationTime(clock: () => Date) {
  const value = clock().getTime();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new DiscoveryArtworkReferenceError();
  }
  return value;
}

export class DiscoveryArtworkReferenceService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: Pick<AppConfig, "encryptionKey">;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    clock: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = clock;
  }

  public create(
    userIdInput: string,
    connectorIdInput: string,
    inputs: readonly DiscoveryArtworkReferenceInput[],
  ) {
    let userId: string;
    let connectorId: string;
    let payloads: z.infer<typeof storedArtworkReferenceSchema>[];
    try {
      userId = identifierSchema.parse(userIdInput);
      connectorId = identifierSchema.parse(connectorIdInput);
      if (inputs.length > MAX_ARTWORK_REFERENCES_PER_FEED) {
        throw new DiscoveryArtworkReferenceError();
      }
      payloads = inputs.map((input) =>
        storedArtworkReferenceSchema.parse({ ...input, schemaVersion: 1 }),
      );
    } catch (error) {
      if (error instanceof DiscoveryArtworkReferenceError) throw error;
      throw new DiscoveryArtworkReferenceError({ cause: error });
    }
    const now = operationTime(this.#clock);
    const expiresAt = now + ARTWORK_REFERENCE_TTL_MS;

    try {
      return this.#database.sqlite.transaction(() => {
        this.#database.sqlite
          .prepare("delete from discovery_artwork_references where expires_at <= ?")
          .run(now);
        const references = payloads.map((payload) => {
          const itemDigest = privacyHash(
            "discovery_artwork",
            `${connectorId}\0${payload.kind}\0${payload.path}`,
            this.#config.encryptionKey,
          );
          const id = discoveryArtworkReferenceIdSchema.parse(
            `discovery_art_${privacyHash(
              "discovery_artwork",
              `${userId}\0${connectorId}\0${payload.kind}\0${payload.path}`,
              this.#config.encryptionKey,
            )}`,
          );
          const encryptedPayload = this.#cipher.encrypt(
            JSON.stringify(payload),
            referenceContext(id),
          );
          const result = this.#database.sqlite
            .prepare(
              `insert into discovery_artwork_references (
                 id, user_id, connector_id, item_digest, encrypted_payload,
                 last_used_at, expires_at, created_at, updated_at
               ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
               on conflict(id) do update set
                 encrypted_payload = excluded.encrypted_payload,
                 last_used_at = excluded.last_used_at,
                 expires_at = excluded.expires_at,
                 updated_at = excluded.updated_at
               where discovery_artwork_references.user_id = excluded.user_id
                 and discovery_artwork_references.connector_id = excluded.connector_id
                 and discovery_artwork_references.item_digest = excluded.item_digest`,
            )
            .run(id, userId, connectorId, itemDigest, encryptedPayload, now, expiresAt, now, now);
          if (result.changes !== 1) throw new DiscoveryArtworkReferenceError();
          return id;
        });
        this.#database.sqlite
          .prepare(
            `delete from discovery_artwork_references
             where user_id = ? and id in (
               select id from discovery_artwork_references
               where user_id = ?
               order by last_used_at desc, id asc
               limit -1 offset ?
             )`,
          )
          .run(userId, userId, MAX_ARTWORK_REFERENCES_PER_USER);
        return references;
      })();
    } catch (error) {
      if (error instanceof DiscoveryArtworkReferenceError) throw error;
      throw new DiscoveryArtworkReferenceError({ cause: error });
    }
  }

  public resolve(userIdInput: string, referenceIdInput: string) {
    let userId: string;
    let referenceId: string;
    try {
      userId = identifierSchema.parse(userIdInput);
      referenceId = discoveryArtworkReferenceIdSchema.parse(referenceIdInput);
    } catch (error) {
      throw new DiscoveryArtworkReferenceError({ cause: error });
    }
    const now = operationTime(this.#clock);
    try {
      return this.#database.sqlite.transaction(() => {
        const row = this.#database.sqlite
          .prepare(
            `select
               id,
               connector_id as connectorId,
               item_digest as itemDigest,
               encrypted_payload as encryptedPayload
             from discovery_artwork_references
             where id = ? and user_id = ? and expires_at > ?`,
          )
          .get(referenceId, userId, now) as StoredReferenceRow | undefined;
        if (!row) throw new DiscoveryArtworkReferenceError();
        const payload = storedArtworkReferenceSchema.parse(
          JSON.parse(this.#cipher.decrypt(row.encryptedPayload, referenceContext(referenceId))),
        );
        const expectedDigest = privacyHash(
          "discovery_artwork",
          `${row.connectorId}\0${payload.kind}\0${payload.path}`,
          this.#config.encryptionKey,
        );
        if (expectedDigest !== row.itemDigest) throw new DiscoveryArtworkReferenceError();
        this.#database.sqlite
          .prepare(
            `update discovery_artwork_references
             set last_used_at = ?, updated_at = ?
             where id = ? and user_id = ? and expires_at > ?`,
          )
          .run(now, now, referenceId, userId, now);
        return Object.freeze({
          connectorId: row.connectorId,
          id: referenceId,
          kind: payload.kind,
          path: payload.path,
        } satisfies ResolvedDiscoveryArtworkReference);
      })();
    } catch (error) {
      if (error instanceof DiscoveryArtworkReferenceError) throw error;
      throw new DiscoveryArtworkReferenceError({ cause: error });
    }
  }
}
