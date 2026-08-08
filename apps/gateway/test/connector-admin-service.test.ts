import {
  ROLE_PERMISSIONS,
  sessionPrincipalSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import type { ConnectorAdapter } from "@omnifin/connectors/types";
import { createHash, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { describe, expect, it, vi } from "vitest";

import { ConnectorAdminService } from "../src/connectors/admin-service.js";
import { SessionService } from "../src/auth/session-service.js";
import type {
  ConnectorAdapterFactoryInput,
  ConnectorAdminError,
} from "../src/connectors/admin-service.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseHandle } from "../src/db/client.js";
import { ExternalMutationJournal } from "../src/operations/external-mutation-journal.js";
import { EnvelopeCipher } from "../src/security/crypto.js";

const baseTime = Date.parse("2026-07-26T17:00:00.000Z");

function testConfig(): AppConfig {
  return {
    baseUrl: new URL("https://omnifin.example"),
    databaseUrl: ":memory:",
    encryptionKey: Buffer.alloc(32, 83),
    environment: "test",
    host: "127.0.0.1",
    insecureLoopbackPreview: false,
    jellyfinInsecureHttpApproved: false,
    logLevel: "silent",
    port: 4000,
    secureCookies: true,
    session: {
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
      inactivityTtlMs: 60 * 60 * 1_000,
      recoveryAbsoluteTtlMs: 15 * 60 * 1_000,
      rotationIntervalMs: 5 * 60 * 1_000,
    },
    trustProxyHops: 0,
  };
}

function principal(role: "admin" | "viewer" = "admin"): SessionPrincipal {
  return sessionPrincipalSchema.parse({
    absoluteExpiresAt: "2026-08-25T17:00:00.000Z",
    accountState: "active",
    authenticationMethod: { kind: "jellyfin" },
    displayName: role === "admin" ? "Administrator" : "Viewer",
    externalIdentity: null,
    inactivityExpiresAt: "2026-07-26T18:00:00.000Z",
    issuedAt: "2026-07-26T17:00:00.000Z",
    linkedServices: [
      {
        displayName: "Jellyfin user",
        externalUserId: `jellyfin-${role}`,
        health: "linked",
        id: `link-${role}`,
        lastVerifiedAt: "2026-07-26T17:00:00.000Z",
        linkedAt: "2026-07-26T17:00:00.000Z",
        service: "jellyfin",
        username: role,
      },
    ],
    permissions: ROLE_PERMISSIONS[role],
    role,
    sessionId: `session-${role}`,
    userId: `user-${role}`,
  });
}

function healthyRadarr(connectorId = "radarr-main"): ConnectorHealth {
  return {
    capabilities: ["connector.health", "connector.version"],
    checkedAt: "2026-07-26T17:01:00.000Z",
    connectorId,
    displayName: "Radarr",
    failure: null,
    latencyMs: 12,
    service: "radarr",
    status: "healthy",
    version: "5.25.0",
  };
}

function context(actor = principal()) {
  return {
    ipAddress: "203.0.113.7",
    principal: actor,
    requestId: "connector-request-001",
  };
}

function insertUser(database: DatabaseHandle, actor = principal()) {
  database.sqlite
    .prepare(
      `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
       values (?, ?, ?, 'manual', 'active', ?, ?)`,
    )
    .run(actor.userId, actor.displayName, actor.role, baseTime, baseTime);
}

function createHarness(
  options: {
    clock?: () => Date;
    createAdapter?: (input: ConnectorAdapterFactoryInput) => ConnectorAdapter;
  } = {},
) {
  const config = testConfig();
  const database = openDatabase(config.databaseUrl);
  database.migrate();
  insertUser(database);
  let clockTick = 0;
  let identifier = 0;
  const service = new ConnectorAdminService(database, config, {
    clock: () => new Date(baseTime + clockTick++),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    createId: () => `connector-audit-${++identifier}`,
    ...(options.createAdapter === undefined ? {} : { createAdapter: options.createAdapter }),
  });
  return { config, database, service };
}

const radarrRequest = {
  baseUrl: "https://radarr.example.test/api",
  credentials: { apiKey: "radarr-private-api-key", kind: "api_key" as const },
  displayName: "Radarr",
  id: "radarr-main",
  insecureHttpApproved: false,
  service: "radarr" as const,
  tlsPolicy: "strict" as const,
};

describe("connector administration service", () => {
  it("encrypts credentials, returns only a safe presentation, and audits creation", () => {
    const { config, database, service } = createHarness();
    try {
      const created = service.create(radarrRequest, context());
      const row = database.sqlite
        .prepare(
          "select encrypted_credentials as encryptedCredentials, enabled from connector_configs where id = ?",
        )
        .get(radarrRequest.id) as { encryptedCredentials: string; enabled: number };
      const audit = database.sqlite
        .prepare(
          "select event_type as eventType, metadata_json as metadataJson, ip_hash as ipHash from audit_events",
        )
        .get() as { eventType: string; metadataJson: string; ipHash: string };

      expect(created).toMatchObject({
        credentialKind: "api_key",
        credentialsConfigured: true,
        enabled: false,
        healthState: "unknown",
        publicUiUrl: null,
      });
      expect(JSON.stringify(created)).not.toContain(radarrRequest.credentials.apiKey);
      expect(row.enabled).toBe(0);
      expect(row.encryptedCredentials).not.toContain(radarrRequest.credentials.apiKey);
      expect(
        JSON.parse(
          new EnvelopeCipher(config.encryptionKey).decrypt(
            row.encryptedCredentials,
            "connector_credentials:radarr:radarr-main",
          ),
        ),
      ).toEqual({ credentials: radarrRequest.credentials, schemaVersion: 1 });
      expect(audit.eventType).toBe("connector.configuration.created");
      expect(audit.metadataJson).not.toContain(radarrRequest.credentials.apiKey);
      expect(audit.ipHash).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    } finally {
      database.close();
    }
  });

  it("stores a canonical browser URL separately without invalidating service health", async () => {
    const { database, service } = createHarness({
      createAdapter: () => ({
        capabilities: ["connector.health", "connector.version"] as const,
        probe: async () => healthyRadarr(),
        service: "radarr" as const,
      }),
    });
    try {
      const created = service.create(
        { ...radarrRequest, publicUiUrl: "https://media.example.test/radarr" },
        context(),
      );
      expect(created.publicUiUrl).toBe("https://media.example.test/radarr/");
      const probed = await service.probe(created.id, context());
      const enabled = service.update(
        created.id,
        { enabled: true, revision: probed.revision },
        context(),
      );
      const changed = service.update(
        created.id,
        {
          publicUiUrl: "https://radarr.lan/ui",
          revision: enabled.revision,
        },
        context(),
      );

      expect(changed).toMatchObject({
        enabled: true,
        healthState: "healthy",
        publicUiUrl: "https://radarr.lan/ui/",
      });
      expect(
        database.sqlite
          .prepare("select public_ui_url as publicUiUrl from connector_configs where id = ?")
          .get(created.id),
      ).toEqual({ publicUiUrl: "https://radarr.lan/ui/" });
      const cleared = service.update(
        created.id,
        { publicUiUrl: null, revision: changed.revision },
        context(),
      );
      expect(cleared.publicUiUrl).toBeNull();
      expect(
        database.sqlite
          .prepare(
            `select config_generation as configGeneration,
                    instance_generation as instanceGeneration
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toEqual({ configGeneration: 3, instanceGeneration: 0 });
      const audit = database.sqlite
        .prepare(
          "select metadata_json as metadataJson from audit_events where event_type = 'connector.configuration.updated' order by created_at desc limit 1",
        )
        .get() as { metadataJson: string };
      expect(JSON.parse(audit.metadataJson)).toMatchObject({ changedFields: ["publicUiUrl"] });
      expect(audit.metadataJson).not.toContain("radarr.lan");
    } finally {
      database.close();
    }
  });

  it("rejects browser destinations for services without connected UI actions", () => {
    const { database, service } = createHarness();
    try {
      const jellyfin = service.create(
        {
          baseUrl: "https://jellyfin.example.test",
          credentials: { kind: "none" },
          displayName: "Jellyfin",
          id: "jellyfin-main",
          insecureHttpApproved: false,
          service: "jellyfin",
          tlsPolicy: "strict",
        },
        context(),
      );

      expect(() =>
        service.update(
          jellyfin.id,
          {
            publicUiUrl: "https://jellyfin.example.test/ui",
            revision: jellyfin.revision,
          },
          context(),
        ),
      ).toThrow(expect.objectContaining({ reason: "configuration_invalid" }));
      expect(service.get(jellyfin.id, context()).publicUiUrl).toBeNull();
    } finally {
      database.close();
    }
  });

  it("enforces connector permission in the service before touching storage", () => {
    const { database, service } = createHarness();
    try {
      expect(() => service.create(radarrRequest, context(principal("viewer")))).toThrow(
        expect.objectContaining({ code: "permission_denied", statusCode: 403 }),
      );
      expect(
        database.sqlite.prepare("select count(*) as count from connector_configs").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("persists a validated capability snapshot before allowing enablement", async () => {
    const createAdapter = vi.fn(() => ({
      capabilities: ["connector.health", "connector.version"] as const,
      probe: vi.fn(async () => healthyRadarr()),
      service: "radarr" as const,
    }));
    const { database, service } = createHarness({ createAdapter });
    try {
      const created = service.create(radarrRequest, context());
      expect(() =>
        service.update("radarr-main", { enabled: true, revision: created.revision }, context()),
      ).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({
          reason: "connector_not_validated",
        }),
      );

      const probed = await service.probe("radarr-main", context());
      expect(probed.revision).toBe(created.revision);
      expect(probed).toMatchObject({ healthState: "healthy", lastProbe: { status: "healthy" } });
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: radarrRequest.credentials,
          tlsPolicy: "strict",
        }),
      );

      const enabled = service.update(
        "radarr-main",
        { enabled: true, revision: probed.revision },
        context(),
      );
      expect(enabled.enabled).toBe(true);
      const snapshot = database.sqlite
        .prepare("select capability_snapshot_json as snapshot from connector_configs where id = ?")
        .get("radarr-main") as { snapshot: string };
      expect(JSON.parse(snapshot.snapshot)).toMatchObject({
        configGeneration: 1,
        health: { capabilities: ["connector.health", "connector.version"], status: "healthy" },
        schemaVersion: 1,
      });
    } finally {
      database.close();
    }
  });

  it("disables and invalidates validation after a material change", async () => {
    const { database, service } = createHarness({
      createAdapter: () => ({
        capabilities: ["connector.health", "connector.version"] as const,
        probe: async () => healthyRadarr(),
        service: "radarr" as const,
      }),
    });
    try {
      const created = service.create(radarrRequest, context());
      const probed = await service.probe(created.id, context());
      const enabled = service.update(
        created.id,
        { enabled: true, revision: probed.revision },
        context(),
      );
      const changed = service.update(
        created.id,
        {
          baseUrl: "https://radarr-new.example.test/",
          revision: enabled.revision,
        },
        context(),
      );

      expect(changed).toMatchObject({ enabled: false, healthState: "unknown", lastProbe: null });
      expect(() =>
        service.update(created.id, { displayName: "Stale", revision: enabled.revision }, context()),
      ).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({
          reason: "revision_conflict",
        }),
      );
    } finally {
      database.close();
    }
  });

  it("requires recent validation evidence before enabling a connector", async () => {
    let currentTime = baseTime;
    const { database, service } = createHarness({
      clock: () => new Date(currentTime),
      createAdapter: () => ({
        capabilities: ["connector.health", "connector.version"] as const,
        probe: async () => ({
          ...healthyRadarr(),
          checkedAt: new Date(baseTime).toISOString(),
        }),
        service: "radarr" as const,
      }),
    });
    try {
      const created = service.create(radarrRequest, context());
      const probed = await service.probe(created.id, context());
      currentTime += 11 * 60 * 1_000;

      expect(() =>
        service.update(created.id, { enabled: true, revision: probed.revision }, context()),
      ).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({
          reason: "connector_not_validated",
        }),
      );
    } finally {
      database.close();
    }
  });

  it("stores a trusted connector CA inside the encrypted envelope and never presents it", async () => {
    const trustedCaCertificate = rootCertificates.find((pem) => {
      const certificate = new X509Certificate(pem);
      return (
        certificate.ca &&
        Date.parse(certificate.validFrom) <= baseTime &&
        Date.parse(certificate.validTo) > baseTime
      );
    });
    if (!trustedCaCertificate) throw new Error("A current runtime CA fixture is required.");
    const createAdapter = vi.fn(() => ({
      capabilities: ["connector.health", "connector.version"] as const,
      probe: async () => healthyRadarr(),
      service: "radarr" as const,
    }));
    const { config, database, service } = createHarness({ createAdapter });
    try {
      expect(() =>
        service.create(
          {
            ...radarrRequest,
            tlsCaCertificatePem: "-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n",
            tlsPolicy: "allow_self_signed",
          },
          context(),
        ),
      ).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({ reason: "configuration_invalid" }),
      );
      const created = service.create(
        {
          ...radarrRequest,
          tlsCaCertificatePem: trustedCaCertificate,
          tlsPolicy: "allow_self_signed",
        },
        context(),
      );
      expect(created).toMatchObject({
        tlsCaCertificateConfigured: true,
        tlsPolicy: "allow_self_signed",
      });
      expect(JSON.stringify(created)).not.toContain(trustedCaCertificate);

      await service.probe(created.id, context());
      expect(createAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ tlsCaCertificatePem: trustedCaCertificate }),
      );
      const row = database.sqlite
        .prepare(
          "select encrypted_credentials as encryptedCredentials from connector_configs where id = ?",
        )
        .get(created.id) as { encryptedCredentials: string };
      expect(row.encryptedCredentials).not.toContain(trustedCaCertificate);
      expect(
        JSON.parse(
          new EnvelopeCipher(config.encryptionKey).decrypt(
            row.encryptedCredentials,
            "connector_credentials:radarr:radarr-main",
          ),
        ),
      ).toMatchObject({ tlsCaCertificatePem: trustedCaCertificate });

      const probed = service.get(created.id, context());
      const strict = service.update(
        created.id,
        { revision: probed.revision, tlsPolicy: "strict" },
        context(),
      );
      expect(strict).toMatchObject({
        enabled: false,
        tlsCaCertificateConfigured: false,
        tlsPolicy: "strict",
      });
      expect(
        database.sqlite
          .prepare(
            `select config_generation as configGeneration,
                    instance_generation as instanceGeneration
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toEqual({ configGeneration: 1, instanceGeneration: 0 });
    } finally {
      database.close();
    }
  });

  it("paginates deterministically and rejects forged cursors", () => {
    const { database, service } = createHarness();
    try {
      service.create(radarrRequest, context());
      service.create(
        {
          ...radarrRequest,
          baseUrl: "https://radarr-secondary.example.test/",
          id: "radarr-secondary",
        },
        context(),
      );

      const first = service.list({ limit: 1 }, context());
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = service.list({ cursor: first.nextCursor!, limit: 1 }, context());
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(second.nextCursor).toBeNull();
      expect(() => service.list({ cursor: "Zm9v=", limit: 1 }, context())).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({
          reason: "configuration_invalid",
        }),
      );
    } finally {
      database.close();
    }
  });

  it("fails closed when encrypted credentials or snapshots lose integrity", () => {
    const { database, service } = createHarness();
    try {
      service.create(radarrRequest, context());
      database.sqlite
        .prepare("update connector_configs set encrypted_credentials = ? where id = ?")
        .run("v2.invalid.invalid.invalid", radarrRequest.id);
      expect(() => service.get(radarrRequest.id, context())).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({ reason: "integrity_failure" }),
      );

      const cipher = new EnvelopeCipher(testConfig().encryptionKey);
      database.sqlite
        .prepare(
          "update connector_configs set encrypted_credentials = ?, capability_snapshot_json = ? where id = ?",
        )
        .run(
          cipher.encrypt(
            JSON.stringify(radarrRequest.credentials),
            "connector_credentials:radarr:radarr-main",
          ),
          JSON.stringify({ schemaVersion: 2 }),
          radarrRequest.id,
        );
      expect(() => service.get(radarrRequest.id, context())).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({ reason: "integrity_failure" }),
      );
    } finally {
      database.close();
    }
  });

  it("reads legacy deployment-bootstrapped Jellyfin credentials without weakening other records", () => {
    const { config, database, service } = createHarness();
    try {
      const cipher = new EnvelopeCipher(config.encryptionKey);
      database.sqlite
        .prepare(
          `insert into connector_configs (
            id, type, display_name, base_url, encrypted_credentials,
            capability_snapshot_json, health_state, enabled, created_at, updated_at
          ) values (?, 'jellyfin', ?, ?, ?, ?, 'unknown', 1, ?, ?)`,
        )
        .run(
          "jellyfin-legacy",
          "Jellyfin",
          "https://jellyfin.example.test/",
          cipher.encrypt("{}", "connector_credentials:jellyfin:jellyfin-legacy"),
          JSON.stringify({
            authentication: { password: true, quickConnect: "unknown" },
            schemaVersion: 1,
          }),
          baseTime,
          baseTime,
        );

      expect(service.get("jellyfin-legacy", context())).toMatchObject({
        credentialKind: "none",
        credentialsConfigured: false,
        enabled: true,
        service: "jellyfin",
      });
    } finally {
      database.close();
    }
  });

  it("requires explicit approval for insecure HTTP", () => {
    const { database, service } = createHarness();
    try {
      expect(() =>
        service.create({ ...radarrRequest, baseUrl: "http://radarr.example.test/" }, context()),
      ).toThrow(
        expect.objectContaining<Partial<ConnectorAdminError>>({
          reason: "configuration_invalid",
        }),
      );
      expect(
        service.create(
          {
            ...radarrRequest,
            baseUrl: "http://radarr.example.test/",
            insecureHttpApproved: true,
          },
          context(),
        ),
      ).toMatchObject({ insecureHttpApproved: true, tlsPolicy: "strict" });
    } finally {
      database.close();
    }
  });

  it("keeps semantic no-ops and health probes revision-stable while advancing real config once", async () => {
    const { database, service } = createHarness({
      createAdapter: () => ({
        capabilities: ["connector.health", "connector.version"],
        probe: async () => healthyRadarr(),
        service: "radarr",
      }),
    });
    try {
      const created = service.create(radarrRequest, context());
      const initial = database.sqlite
        .prepare(
          `select config_generation as configGeneration,
                  instance_generation as instanceGeneration, updated_at as updatedAt
           from connector_configs where id = ?`,
        )
        .get(created.id) as {
        configGeneration: number;
        instanceGeneration: number;
        updatedAt: number;
      };
      const noOp = service.update(
        created.id,
        {
          baseUrl: "https://radarr.example.test/api/",
          credentials: radarrRequest.credentials,
          displayName: radarrRequest.displayName,
          revision: created.revision,
        },
        context(),
      );
      expect(noOp).toEqual(created);
      expect(
        database.sqlite
          .prepare(
            `select config_generation as configGeneration,
                    instance_generation as instanceGeneration, updated_at as updatedAt
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toEqual(initial);

      const probed = await service.probe(created.id, context());
      expect(probed.revision).toBe(created.revision);
      expect(
        database.sqlite
          .prepare(
            `select config_generation as configGeneration,
                    instance_generation as instanceGeneration
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toEqual({ configGeneration: 0, instanceGeneration: 0 });

      const renamed = service.update(
        created.id,
        { displayName: "Cinema Radarr", revision: probed.revision },
        context(),
      );
      expect(renamed.revision).not.toBe(created.revision);
      expect(
        database.sqlite
          .prepare(
            `select config_generation as configGeneration,
                    instance_generation as instanceGeneration
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toEqual({ configGeneration: 1, instanceGeneration: 0 });
    } finally {
      database.close();
    }
  });

  it("advances instance generation only for a canonical endpoint replacement", async () => {
    const { config, database, service } = createHarness({
      createAdapter: () => ({
        capabilities: ["connector.health", "connector.version"],
        probe: async () => healthyRadarr(),
        service: "radarr",
      }),
    });
    try {
      const created = service.create(radarrRequest, context());
      const probed = await service.probe(created.id, context());
      const enabled = service.update(
        created.id,
        { enabled: true, revision: probed.revision },
        context(),
      );
      const disabled = service.update(
        created.id,
        { enabled: false, revision: enabled.revision },
        context(),
      );
      expect(
        database.sqlite
          .prepare(
            `select config_generation as configGeneration,
                    instance_generation as instanceGeneration
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toEqual({ configGeneration: 2, instanceGeneration: 0 });

      const credentials = service.update(
        created.id,
        {
          credentials: { apiKey: "replacement-api-key", kind: "api_key" },
          revision: disabled.revision,
        },
        context(),
      );
      database.sqlite.exec(`
        insert into users (id, display_name, role, role_source, status, created_at, updated_at)
        values ('search-user', 'Search user', 'operator', 'manual', 'active', ${baseTime}, ${baseTime});
        insert into acquisition_search_operations (
          id, user_id, idempotency_key_hash, fingerprint_hash, state, created_at, updated_at
        ) values (
          'automatic-search-replacement', 'search-user', '${"a".repeat(43)}',
          '${"b".repeat(43)}', 'pending', ${baseTime}, ${baseTime}
        );
      `);
      const generations = database.sqlite
        .prepare(
          `select config_generation as configGeneration,
                  instance_generation as instanceGeneration
           from connector_configs where id = ?`,
        )
        .get(created.id) as { configGeneration: number; instanceGeneration: number };
      new ExternalMutationJournal(database.sqlite, config.encryptionKey).reserve({
        connectorConfigGeneration: generations.configGeneration,
        connectorId: created.id,
        connectorInstanceGeneration: generations.instanceGeneration,
        id: `mutation_dispatch_${"x".repeat(22)}`,
        kind: "acquisition.search",
        leaseExpiresAt: baseTime + 60_000,
        leaseOwner: "automatic-search-worker",
        normalizedRequest: { action: "automatic_search", mediaId: 42 },
        now: baseTime,
        parentOperationId: "automatic-search-replacement",
        parentOperationType: "acquisition_search_operation",
        targetDigest: "y".repeat(22),
        userId: "search-user",
      });
      const replacement = service.update(
        created.id,
        { baseUrl: "https://replacement.example.test/api", revision: credentials.revision },
        context(),
      );
      expect(replacement).toMatchObject({ enabled: false, healthState: "unknown" });
      expect(
        database.sqlite
          .prepare(
            `select config_generation as configGeneration,
                    instance_generation as instanceGeneration
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toEqual({ configGeneration: 4, instanceGeneration: 1 });
      expect(
        database.sqlite
          .prepare(
            `select state, failure_code as failureCode
             from acquisition_search_operations where id = 'automatic-search-replacement'`,
          )
          .get(),
      ).toEqual({ failureCode: "connector_instance_replaced", state: "failed" });
      expect(
        database.sqlite
          .prepare(
            `select state, failure_code as failureCode
             from external_mutation_dispatches where parent_operation_id = 'automatic-search-replacement'`,
          )
          .get(),
      ).toEqual({ failureCode: "connector_instance_replaced", state: "failed" });
      expect(
        database.sqlite
          .prepare("select count(*) as count from external_mutation_target_locks")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("hashes Jellyfin stable identity and atomically revokes old authority on replacement", async () => {
    let serverId = "server-before";
    const jellyfinHealth = (): ConnectorHealth => ({
      capabilities: ["connector.health", "connector.version"],
      checkedAt: new Date(baseTime).toISOString(),
      connectorId: "jellyfin-main",
      displayName: "Jellyfin",
      failure: null,
      latencyMs: 2,
      service: "jellyfin",
      status: "healthy",
      version: "10.10.7",
    });
    const { config, database, service } = createHarness({
      clock: () => new Date(baseTime),
      createAdapter: () => ({
        capabilities: ["connector.health", "connector.version"],
        probe: async () => jellyfinHealth(),
        probeWithIdentity: async () => ({
          health: jellyfinHealth(),
          stableInstanceIdentity: serverId,
        }),
        service: "jellyfin",
      }),
    });
    try {
      const created = service.create(
        {
          baseUrl: "https://jellyfin.example.test",
          credentials: { kind: "none" },
          displayName: "Jellyfin",
          id: "jellyfin-main",
          insecureHttpApproved: false,
          service: "jellyfin",
          tlsPolicy: "strict",
        },
        context(),
      );
      const firstProbe = await service.probe(created.id, context());
      const storedIdentity = database.sqlite
        .prepare("select instance_identity_hash as hash from connector_configs where id = ?")
        .get(created.id) as { hash: string };
      expect(storedIdentity.hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(storedIdentity.hash).not.toContain(serverId);
      const enabled = service.update(
        created.id,
        { enabled: true, revision: firstProbe.revision },
        context(),
      );
      database.sqlite
        .prepare(
          `insert into users (id, display_name, role, role_source, status, created_at, updated_at)
           values ('linked-user', 'Linked user', 'viewer', 'default', 'active', ?, ?)`,
        )
        .run(baseTime, baseTime);
      database.sqlite
        .prepare(
          `insert into service_identity_links (
             id, user_id, service, connector_id, connector_instance_generation,
             external_server_id, external_user_id, external_username, external_display_name,
             encrypted_access_token, device_id, token_created_at, health_state,
             last_verified_at, revision, created_at, updated_at
           ) values (
             'linked-user-link', 'linked-user', 'jellyfin', 'jellyfin-main', 0,
             'server-before', 'upstream-user', 'linked', 'Linked user',
             'v2.fixture-token', 'device-before', ?, 'linked', ?, 0, ?, ?
           )`,
        )
        .run(baseTime, baseTime, baseTime, baseTime);
      const sessions = new SessionService(database, config, { clock: () => new Date(baseTime) });
      const session = sessions.createSession({
        attribution: {
          authMethod: "jellyfin",
          serviceIdentityLinkId: "linked-user-link",
          userId: "linked-user",
        },
      });
      database.sqlite
        .prepare(
          `insert into jellyfin_quick_connect_transactions (
             id, connector_id, connector_instance_generation, connector_type, purpose,
             browser_binding_hash, encrypted_payload, expires_at, next_poll_at, poll_count,
             created_at
           ) values (
             'quick-before', 'jellyfin-main', 0, 'jellyfin', 'sign_in',
             ?, 'v2.fixture-payload', ?, ?, 0, ?
           )`,
        )
        .run("A".repeat(43), baseTime + 60_000, baseTime + 2_000, baseTime);

      serverId = "server-after";
      const replaced = await service.probe(created.id, context());
      expect(replaced).toMatchObject({
        enabled: false,
        healthState: "unknown",
        lastProbe: null,
        revision: enabled.revision,
      });
      expect(
        database.sqlite
          .prepare(
            `select instance_generation as instanceGeneration,
                    config_generation as configGeneration, instance_identity_hash as identityHash
             from connector_configs where id = ?`,
          )
          .get(created.id),
      ).toMatchObject({ configGeneration: 1, instanceGeneration: 1 });
      expect(
        database.sqlite
          .prepare(
            `select encrypted_access_token as token, health_state as healthState,
                    connector_instance_generation as connectorInstanceGeneration, revision
             from service_identity_links where id = 'linked-user-link'`,
          )
          .get(),
      ).toEqual({
        connectorInstanceGeneration: 0,
        healthState: "relink_required",
        revision: 1,
        token: null,
      });
      expect(
        database.sqlite.prepare("select status from users where id = 'linked-user'").get(),
      ).toEqual({
        status: "pending_link",
      });
      expect(sessions.resolveAndRefresh(session.sessionToken)).toBeNull();
      expect(
        database.sqlite
          .prepare("select count(*) as count from jellyfin_quick_connect_transactions")
          .get(),
      ).toEqual({ count: 0 });
      expect(JSON.stringify(replaced)).not.toMatch(/server-before|server-after/u);
    } finally {
      database.close();
    }
  });

  it("rejects a stale probe and accepts one pre-generation revision exactly once", async () => {
    let finishProbe: ((health: ConnectorHealth) => void) | undefined;
    const { database, service } = createHarness({
      createAdapter: () => ({
        capabilities: ["connector.health", "connector.version"],
        probe: () =>
          new Promise<ConnectorHealth>((resolve) => {
            finishProbe = resolve;
          }),
        service: "radarr",
      }),
    });
    try {
      const created = service.create(radarrRequest, context());
      const pendingProbe = service.probe(created.id, context());
      await vi.waitFor(() => expect(finishProbe).toBeTypeOf("function"));
      service.update(
        created.id,
        { displayName: "Changed while probing", revision: created.revision },
        context(),
      );
      finishProbe!(healthyRadarr());
      await expect(pendingProbe).rejects.toMatchObject({ reason: "revision_conflict" });

      database.sqlite
        .prepare(
          `update connector_configs
           set config_generation = 0, instance_generation = 0, updated_at = ?
           where id = ?`,
        )
        .run(baseTime + 500, created.id);
      const legacyRevision = createHash("sha256")
        .update(`radarr\0${created.id}\0${baseTime + 500}`, "utf8")
        .digest("base64url");
      const compatible = service.update(
        created.id,
        { displayName: "Legacy compatible", revision: legacyRevision },
        context(),
      );
      expect(compatible.displayName).toBe("Legacy compatible");
      expect(() =>
        service.update(
          created.id,
          { displayName: "Legacy replay", revision: legacyRevision },
          context(),
        ),
      ).toThrow(expect.objectContaining({ reason: "revision_conflict" }));
    } finally {
      database.close();
    }
  });
});
