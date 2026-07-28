import { RadarrAdapter } from "@omnifin/connectors/adapters/radarr";
import { SonarrAdapter } from "@omnifin/connectors/adapters/sonarr";
import type {
  AcquisitionCalendarReader,
  AcquisitionCalendarSourceEvent,
} from "@omnifin/connectors/calendar";
import { SafeConnectorError } from "@omnifin/connectors/http/safe-http-client";
import type { ApiKeyConnectorConfig } from "@omnifin/connectors/types";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  ACQUISITION_CALENDAR_MAX_SOURCES,
  acquisitionCalendarEventSchema,
  acquisitionCalendarQuerySchema,
  acquisitionCalendarResponseSchema,
  type AcquisitionCalendarEvent,
  type AcquisitionCalendarQuery,
  type AcquisitionCalendarResponse,
  type AcquisitionCalendarSource,
} from "@omnifin/contracts/calendar";
import type { AcquisitionService } from "@omnifin/contracts/acquisition";
import {
  connectorCredentialInputSchema,
  connectorHealthSchema,
  type PartialFailure,
} from "@omnifin/contracts/connectors";
import { X509Certificate } from "node:crypto";
import { z, ZodError } from "zod";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { constantTimeTextEqual, EnvelopeCipher, privacyHash } from "../security/crypto.js";

const CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

interface CalendarConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  displayName: string;
  encryptedCredentials: string;
  healthState: string;
  id: string;
  insecureHttpApproved: number;
  tlsPolicy: string;
  type: string;
}

interface StoredConnectorSecrets {
  credentials: unknown;
  schemaVersion: 1;
  tlsCaCertificatePem?: unknown;
}

interface ConnectorSelection {
  rows: CalendarConnectorRow[];
  truncated: boolean;
}

interface CalendarSourceResult {
  events: AcquisitionCalendarEvent[];
  source: Omit<AcquisitionCalendarSource, "eventCount">;
  sourceTruncated: boolean;
}

const cursorPayloadSchema = z.strictObject({
  endAt: z.iso.datetime({ offset: true }),
  eventAt: z.iso.datetime({ offset: true }),
  eventId: acquisitionCalendarEventSchema.shape.id,
  startAt: z.iso.datetime({ offset: true }),
  version: z.literal(1),
});
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export interface AcquisitionCalendarContext {
  principal: SessionPrincipal;
}

export interface AcquisitionCalendarAdapterFactoryInput extends ApiKeyConnectorConfig {
  service: AcquisitionService;
}

export interface AcquisitionCalendarDependencies {
  clock?: () => Date;
  createAdapter?: (input: AcquisitionCalendarAdapterFactoryInput) => AcquisitionCalendarReader;
}

export type AcquisitionCalendarErrorReason = "cursor_invalid" | "storage_failure";

export class AcquisitionCalendarError extends Error {
  public readonly reason: AcquisitionCalendarErrorReason;

  public constructor(reason: AcquisitionCalendarErrorReason, options?: ErrorOptions) {
    super("The acquisition calendar could not be retrieved.", options);
    this.name = "AcquisitionCalendarError";
    this.reason = reason;
  }
}

class CalendarConnectorIntegrityError extends Error {}
class CalendarSourceResponseError extends Error {}

function isAcquisitionService(value: string): value is AcquisitionService {
  return value === "radarr" || value === "sonarr";
}

function credentialContext(service: AcquisitionService, connectorId: string) {
  return `connector_credentials:${service}:${connectorId}`;
}

function safeDisplayName(value: string, service: AcquisitionService) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned || (service === "radarr" ? "Radarr" : "Sonarr")).slice(0, 160);
}

function hasCalendarCapability(row: CalendarConnectorRow, service: AcquisitionService) {
  try {
    const decoded = JSON.parse(row.capabilitySnapshotJson) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const record = decoded as Record<string, unknown>;
    if (record.schemaVersion !== 1) return false;
    const health = connectorHealthSchema.safeParse(record.health);
    return (
      health.success &&
      health.data.connectorId === row.id &&
      health.data.service === service &&
      health.data.status === "healthy" &&
      row.healthState === "healthy" &&
      health.data.capabilities.includes("acquisition.calendar")
    );
  } catch {
    return false;
  }
}

function connectorSecrets(
  row: CalendarConnectorRow,
  service: AcquisitionService,
  cipher: EnvelopeCipher,
) {
  try {
    const decoded = JSON.parse(
      cipher.decrypt(row.encryptedCredentials, credentialContext(service, row.id)),
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
    throw new CalendarConnectorIntegrityError("invalid", { cause: error });
  }
}

function defaultAdapter(input: AcquisitionCalendarAdapterFactoryInput): AcquisitionCalendarReader {
  const { service, ...config } = input;
  return service === "radarr" ? new RadarrAdapter(config) : new SonarrAdapter(config);
}

function safeFailure(
  service: AcquisitionService,
  displayName: string,
  error: unknown,
  occurredAt: Date,
): PartialFailure {
  if (error instanceof SafeConnectorError && error.service === service) {
    return error.toPartialFailure(occurredAt);
  }
  if (error instanceof CalendarConnectorIntegrityError) {
    return {
      code: "configuration_invalid",
      message: `${displayName} calendar configuration could not be used.`,
      occurredAt: occurredAt.toISOString(),
      operation: "acquisition.calendar",
      retryable: false,
      service,
    };
  }
  if (error instanceof CalendarSourceResponseError || error instanceof ZodError) {
    return {
      code: "response_invalid",
      message: `${displayName} returned calendar data that could not be safely interpreted.`,
      occurredAt: occurredAt.toISOString(),
      operation: "acquisition.calendar",
      retryable: false,
      service,
    };
  }
  return {
    code: "upstream_error",
    message: `${displayName} calendar is temporarily unavailable.`,
    occurredAt: occurredAt.toISOString(),
    operation: "acquisition.calendar",
    retryable: true,
    service,
  };
}

function compareEvents(left: AcquisitionCalendarEvent, right: AcquisitionCalendarEvent) {
  const byTime = Date.parse(left.eventAt) - Date.parse(right.eventAt);
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

function isAfterCursor(event: AcquisitionCalendarEvent, cursor: CursorPayload) {
  const byTime = Date.parse(event.eventAt) - Date.parse(cursor.eventAt);
  return byTime > 0 || (byTime === 0 && event.id.localeCompare(cursor.eventId) > 0);
}

function summary(events: readonly AcquisitionCalendarEvent[]) {
  return {
    available: events.filter((event) => event.availability === "available").length,
    episodes: events.filter((event) => event.kind === "episode").length,
    missing: events.filter((event) => event.availability === "missing").length,
    movies: events.filter((event) => event.kind === "movie").length,
    queued: events.filter((event) => event.availability === "queued").length,
    total: events.length,
  };
}

export class AcquisitionCalendarService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAdapter: NonNullable<AcquisitionCalendarDependencies["createAdapter"]>;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: AcquisitionCalendarDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAdapter = dependencies.createAdapter ?? defaultAdapter;
  }

  public async read(
    rawQuery: AcquisitionCalendarQuery,
    context: AcquisitionCalendarContext,
    signal?: AbortSignal,
  ): Promise<AcquisitionCalendarResponse> {
    requirePermission(context.principal, "media.view");
    const query = acquisitionCalendarQuerySchema.parse(rawQuery);
    const cursor = query.cursor ? this.#decodeCursor(query.cursor, query) : null;
    const selection = this.#connectors();
    const results = await Promise.all(
      selection.rows.map((row) => this.#readSource(row, query, signal)),
    );
    const allEvents = results
      .flatMap((result) => result.events)
      .toSorted(compareEvents)
      .filter((event) => cursor === null || isAfterCursor(event, cursor));
    const events = allEvents.slice(0, query.limit);
    const nextCursor =
      allEvents.length > events.length && events.length > 0
        ? this.#encodeCursor(events.at(-1)!, query)
        : null;
    const returnedBySource = new Map<string, number>();
    for (const event of events) {
      returnedBySource.set(event.sourceId, (returnedBySource.get(event.sourceId) ?? 0) + 1);
    }
    const sources = results.map((result) => ({
      ...result.source,
      eventCount: returnedBySource.get(result.source.id) ?? 0,
    }));
    const failures = sources
      .map((source) => source.failure)
      .filter((failure): failure is PartialFailure => failure !== null);
    return acquisitionCalendarResponseSchema.parse({
      endAt: query.end,
      events,
      failures,
      generatedAt: this.#clock().toISOString(),
      nextCursor,
      sourceTruncated: selection.truncated || results.some((result) => result.sourceTruncated),
      sources,
      startAt: query.start,
      state:
        sources.length === 0 ? "unconfigured" : failures.length === 0 ? "complete" : "degraded",
      summary: summary(events),
    });
  }

  async #readSource(
    row: CalendarConnectorRow,
    query: AcquisitionCalendarQuery,
    signal?: AbortSignal,
  ): Promise<CalendarSourceResult> {
    const service = row.type as AcquisitionService;
    const displayName = safeDisplayName(row.displayName, service);
    const sourceId = `calendar_source_${privacyHash(
      "acquisition_calendar_source",
      row.id,
      this.#config.encryptionKey,
    )}` as const;
    const occurredAt = this.#clock();
    try {
      const secrets = connectorSecrets(row, service, this.#cipher);
      const tlsPolicy =
        row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed"
          ? row.tlsPolicy
          : undefined;
      if (
        !tlsPolicy ||
        ![0, 1].includes(row.insecureHttpApproved) ||
        !CONNECTOR_IDENTIFIER_PATTERN.test(row.id) ||
        !row.displayName.trim() ||
        row.displayName.length > 160
      ) {
        throw new CalendarConnectorIntegrityError("invalid");
      }
      const adapter = this.#createAdapter({
        apiKey: secrets.apiKey,
        baseUrl: row.baseUrl,
        clock: { monotonicNow: () => performance.now(), now: this.#clock },
        connectorId: row.id,
        displayName,
        insecureHttpApproved: row.insecureHttpApproved === 1,
        service,
        tlsPolicy,
        ...(secrets.tlsCaCertificatePem === undefined
          ? {}
          : { tlsCaCertificatePem: secrets.tlsCaCertificatePem }),
      });
      const calendar = await adapter.readAcquisitionCalendar(
        { endAt: query.end, startAt: query.start },
        signal,
      );
      const eventIds = new Set<string>();
      const events = calendar.events.map((event) => {
        const normalized = this.#publicEvent(row, displayName, sourceId, event);
        if (eventIds.has(normalized.id)) {
          throw new CalendarSourceResponseError("duplicate calendar event");
        }
        eventIds.add(normalized.id);
        return normalized;
      });
      return {
        events,
        source: {
          displayName,
          failure: null,
          id: sourceId,
          service,
          status: "healthy",
        },
        sourceTruncated: calendar.truncated,
      };
    } catch (error) {
      const failure = safeFailure(service, displayName, error, occurredAt);
      return {
        events: [],
        source: {
          displayName,
          failure,
          id: sourceId,
          service,
          status: "unavailable",
        },
        sourceTruncated: false,
      };
    }
  }

  #publicEvent(
    row: CalendarConnectorRow,
    displayName: string,
    sourceId: AcquisitionCalendarEvent["sourceId"],
    event: AcquisitionCalendarSourceEvent,
  ) {
    const { externalId, ...publicEvent } = event;
    return acquisitionCalendarEventSchema.parse({
      ...publicEvent,
      id: `calendar_${privacyHash(
        "acquisition_calendar_event",
        `${row.id}\u0000${externalId}`,
        this.#config.encryptionKey,
      )}`,
      sourceId,
      sourceName: displayName,
    });
  }

  #encodeCursor(event: AcquisitionCalendarEvent, query: AcquisitionCalendarQuery) {
    const payload = Buffer.from(
      JSON.stringify({
        endAt: query.end,
        eventAt: event.eventAt,
        eventId: event.id,
        startAt: query.start,
        version: 1,
      } satisfies CursorPayload),
      "utf8",
    ).toString("base64url");
    const signature = privacyHash(
      "acquisition_calendar_cursor",
      payload,
      this.#config.encryptionKey,
    );
    return `${payload}.${signature}`;
  }

  #decodeCursor(value: string, query: AcquisitionCalendarQuery) {
    try {
      const parts = value.split(".");
      if (parts.length !== 2) throw new Error("invalid");
      const [payload, signature] = parts;
      if (!payload || !signature || !CURSOR_SIGNATURE_PATTERN.test(signature)) {
        throw new Error("invalid");
      }
      const expected = privacyHash(
        "acquisition_calendar_cursor",
        payload,
        this.#config.encryptionKey,
      );
      if (!constantTimeTextEqual(signature, expected)) throw new Error("invalid");
      const decodedBytes = Buffer.from(payload, "base64url");
      if (!constantTimeTextEqual(payload, decodedBytes.toString("base64url"))) {
        throw new Error("invalid");
      }
      const decoded = cursorPayloadSchema.parse(JSON.parse(decodedBytes.toString("utf8")));
      if (decoded.startAt !== query.start || decoded.endAt !== query.end) {
        throw new Error("invalid");
      }
      return decoded;
    } catch (error) {
      throw new AcquisitionCalendarError("cursor_invalid", { cause: error });
    }
  }

  #connectors(): ConnectorSelection {
    try {
      const rows = this.#database.sqlite
        .prepare(
          `select
             id,
             type,
             display_name as displayName,
             base_url as baseUrl,
             encrypted_credentials as encryptedCredentials,
             capability_snapshot_json as capabilitySnapshotJson,
             health_state as healthState,
             tls_policy as tlsPolicy,
             insecure_http_approved as insecureHttpApproved
           from connector_configs
           where type in ('radarr', 'sonarr') and enabled = 1
           order by id asc
           limit 101`,
        )
        .all() as CalendarConnectorRow[];
      const capable = rows.filter(
        (row) => isAcquisitionService(row.type) && hasCalendarCapability(row, row.type),
      );
      return {
        rows: capable.slice(0, ACQUISITION_CALENDAR_MAX_SOURCES),
        truncated: capable.length > ACQUISITION_CALENDAR_MAX_SOURCES,
      };
    } catch (error) {
      throw new AcquisitionCalendarError("storage_failure", { cause: error });
    }
  }
}
