import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import {
  connectorCredentialInputSchema,
  connectorPublicUiUrlSchema,
} from "@omnifin/contracts/connectors";
import { X509Certificate } from "node:crypto";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher } from "../security/crypto.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SERVARR_TITLE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,299}$/u;

export type ConnectedService = "radarr" | "sonarr";

export type ConnectedServiceIdentity =
  | {
      kind: "movie";
      providerIds: { imdb: string | null; tmdb: number | null };
    }
  | {
      kind: "series";
      providerIds: { tmdb: number | null; tvdb: number | null };
    };

export interface ConnectedServiceTarget {
  publicUiUrl: string;
  service: ConnectedService;
  titleSlug: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

const connectedServiceRowSchema = z.strictObject({
  baseUrl: z.string().trim().min(1).max(2_048),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  enabled: z.literal(1),
  encryptedCredentials: z.string().min(1).max(65_536),
  id: z.string().regex(IDENTIFIER_PATTERN),
  insecureHttpApproved: z.union([z.literal(0), z.literal(1)]),
  publicUiUrl: connectorPublicUiUrlSchema,
  tlsPolicy: z.enum(["strict", "allow_self_signed"]),
  type: z.enum(["radarr", "sonarr"]),
});
type ConnectedServiceRow = z.infer<typeof connectedServiceRowSchema>;

export interface ConnectedServiceNavigationDependencies {
  clock?: () => Date;
  createRadarrAdapter?: (
    input: ApiKeyConnectorConfig,
  ) => Pick<RadarrAdapter, "resolveLibraryMovieNavigation">;
  createSonarrAdapter?: (
    input: ApiKeyConnectorConfig,
  ) => Pick<SonarrAdapter, "resolveLibrarySeriesNavigation">;
}

export class ConnectedServiceNavigationError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Connected service navigation is unavailable.", options);
    this.name = "ConnectedServiceNavigationError";
  }
}

export class ConnectedServiceNavigationService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #createRadarrAdapter: NonNullable<
    ConnectedServiceNavigationDependencies["createRadarrAdapter"]
  >;
  readonly #createSonarrAdapter: NonNullable<
    ConnectedServiceNavigationDependencies["createSonarrAdapter"]
  >;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: ConnectedServiceNavigationDependencies = {},
  ) {
    this.#database = database;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createRadarrAdapter =
      dependencies.createRadarrAdapter ?? ((input) => new RadarrAdapter(input));
    this.#createSonarrAdapter =
      dependencies.createSonarrAdapter ?? ((input) => new SonarrAdapter(input));
  }

  public async resolve(
    identity: ConnectedServiceIdentity,
    signal?: AbortSignal,
  ): Promise<ConnectedServiceTarget | null> {
    const service = identity.kind === "movie" ? "radarr" : "sonarr";
    if (
      (identity.kind === "movie" &&
        identity.providerIds.imdb === null &&
        identity.providerIds.tmdb === null) ||
      (identity.kind === "series" &&
        identity.providerIds.tvdb === null &&
        identity.providerIds.tmdb === null)
    ) {
      return null;
    }
    let rows: ConnectedServiceRow[];
    try {
      rows = (
        this.#database.sqlite
          .prepare(
            `select id, type, display_name as displayName, base_url as baseUrl, enabled,
                    encrypted_credentials as encryptedCredentials,
                    tls_policy as tlsPolicy, insecure_http_approved as insecureHttpApproved,
                    public_ui_url as publicUiUrl
               from connector_configs
              where type = ? and enabled = 1 and public_ui_url is not null
              order by id asc
              limit 11`,
          )
          .all(service) as unknown[]
      ).map((row) => connectedServiceRowSchema.parse(row));
    } catch (error) {
      throw new ConnectedServiceNavigationError({ cause: error });
    }
    if (rows.length === 0) return null;
    if (rows.length > 10) throw new ConnectedServiceNavigationError();

    try {
      const matches = await Promise.all(
        rows.map(async (row): Promise<ConnectedServiceTarget | null> => {
          if (row.type !== service) throw new ConnectedServiceNavigationError();
          const { apiKey, tlsCaCertificatePem } = this.#secrets(row);
          const config = {
            apiKey,
            baseUrl: row.baseUrl,
            clock: { monotonicNow: () => performance.now(), now: this.#clock },
            connectorId: row.id,
            displayName: row.displayName,
            insecureHttpApproved: row.insecureHttpApproved === 1,
            tlsPolicy: row.tlsPolicy,
            ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
          } satisfies ApiKeyConnectorConfig;
          const navigation =
            identity.kind === "movie"
              ? await this.#createRadarrAdapter(config).resolveLibraryMovieNavigation(
                  identity.providerIds,
                  signal,
                )
              : await this.#createSonarrAdapter(config).resolveLibrarySeriesNavigation(
                  identity.providerIds,
                  signal,
                );
          return navigation === null
            ? null
            : {
                publicUiUrl: row.publicUiUrl,
                service,
                titleSlug: navigation.titleSlug,
              };
        }),
      );
      const resolved = matches.filter((match): match is ConnectedServiceTarget => match !== null);
      if (resolved.length > 1) throw new ConnectedServiceNavigationError();
      return resolved[0] ?? null;
    } catch (error) {
      if (error instanceof ConnectedServiceNavigationError) throw error;
      throw new ConnectedServiceNavigationError({ cause: error });
    }
  }

  #secrets(row: ConnectedServiceRow) {
    try {
      const decoded = JSON.parse(
        this.#cipher.decrypt(
          row.encryptedCredentials,
          `connector_credentials:${row.type}:${row.id}`,
        ),
      ) as unknown;
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new Error("invalid");
      }
      const record = decoded as Record<string, unknown>;
      const versioned = record.schemaVersion === 1;
      if (
        versioned &&
        Object.keys(record).some(
          (key) => !["credentials", "schemaVersion", "tlsCaCertificatePem"].includes(key),
        )
      ) {
        throw new Error("invalid");
      }
      const stored = versioned
        ? (record as unknown as StoredConnectorSecrets)
        : ({ credentials: decoded, schemaVersion: 1 } satisfies StoredConnectorSecrets);
      const credentials = connectorCredentialInputSchema.parse(stored.credentials);
      if (credentials.kind !== "api_key") throw new Error("invalid");
      const tlsCaCertificatePem = stored.tlsCaCertificatePem;
      if (tlsCaCertificatePem !== undefined) {
        if (typeof tlsCaCertificatePem !== "string" || row.tlsPolicy !== "allow_self_signed") {
          throw new Error("invalid");
        }
        const certificate = new X509Certificate(tlsCaCertificatePem);
        if (!certificate.ca) throw new Error("invalid");
      }
      return {
        apiKey: credentials.apiKey,
        ...(typeof tlsCaCertificatePem === "string" ? { tlsCaCertificatePem } : {}),
      };
    } catch (error) {
      throw new ConnectedServiceNavigationError({ cause: error });
    }
  }
}

export function connectedServiceDestination(
  target: ConnectedServiceTarget,
  expectedService: ConnectedService,
) {
  if (target.service !== expectedService || !SERVARR_TITLE_SLUG_PATTERN.test(target.titleSlug)) {
    throw new ConnectedServiceNavigationError();
  }
  const base = new URL(connectorPublicUiUrlSchema.parse(target.publicUiUrl));
  const destination = new URL(
    `${target.service === "radarr" ? "movie" : "series"}/${encodeURIComponent(target.titleSlug)}`,
    base,
  );
  if (destination.href.length > 2_304) throw new ConnectedServiceNavigationError();
  return destination;
}
