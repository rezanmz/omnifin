import {
  jellyfinProvisioningConfigSchema,
  jellyfinProvisioningReplaceRequestSchema,
  jellyfinProvisioningTemplateSummarySchema,
  type JellyfinProvisioningConfig,
  type JellyfinProvisioningReplaceRequest,
  type JellyfinProvisioningTemplateSummary,
} from "@omnifin/contracts/connectors";
import type { SessionPrincipal } from "@omnifin/contracts/auth";
import { eq } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";

import {
  JellyfinProvisioningAdminClient,
  JellyfinProvisioningUnsupportedVersionError,
  type JellyfinProvisioningAdminUser,
  type JellyfinProvisioningProtocolVersion,
} from "@omnifin/connectors/auth/jellyfin-provisioning-admin-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { jellyfinProvisioningConfigs } from "../db/schema.js";
import { requirePermission } from "../auth/authorization.js";
import { EnvelopeCipher, privacyHash } from "../security/crypto.js";
import { connectorAdminRevision } from "./admin-service.js";

const DEVICE_ID = "omnifin-provisioning-admin";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type StoredCredential =
  { kind: "access_token"; accessToken: string } | { kind: "api_key"; apiKey: string };

interface StoredProvisioningConfiguration {
  credential: StoredCredential;
  enabled: boolean;
  protocolVersion: JellyfinProvisioningProtocolVersion;
  schemaVersion: 2;
  template: {
    displayName: string;
    id: string;
    policy: Record<string, unknown>;
  } | null;
  validatedAt: number;
}

interface StoredProvisioningTombstone {
  schemaVersion: 2;
  state: "cleared";
}

type StoredProvisioningState = StoredProvisioningConfiguration | StoredProvisioningTombstone;

interface ConnectorRow {
  baseUrl: string;
  capabilitySnapshotJson: string;
  configGeneration: number;
  id: string;
  createdAt: number;
  encryptedCredentials: string;
  enabled: number;
  insecureHttpApproved: number;
  instanceGeneration: number;
  instanceIdentityHash: string | null;
  tlsPolicy: string;
  type: string;
  updatedAt: number;
}

export type JellyfinProvisioningErrorReason =
  | "configuration_invalid"
  | "connector_disabled"
  | "connector_not_found"
  | "connector_not_jellyfin"
  | "connector_not_verified"
  | "credential_not_configured"
  | "permission_denied"
  | "revision_conflict"
  | "storage_failure"
  | "template_invalid"
  | "upstream_validation_failed"
  | "unsupported_version"
  | "binding_invalid";

export class JellyfinProvisioningError extends Error {
  public readonly reason: JellyfinProvisioningErrorReason;

  public constructor(reason: JellyfinProvisioningErrorReason, options?: ErrorOptions) {
    super("Jellyfin provisioning configuration could not be completed.", options);
    this.name = "JellyfinProvisioningError";
    this.reason = reason;
  }
}

export interface JellyfinProvisioningContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface JellyfinProvisioningDependencies {
  clock?: () => Date;
  createClient?: (target: ConnectorTargetConfig) => JellyfinProvisioningAdminClient;
  createId?: () => string;
}

function provisioningContext(
  connectorId: string,
  revision: string,
  instanceGeneration: number,
  identity: string | null,
) {
  return `jellyfin_provisioning:${connectorId}:${revision}:${instanceGeneration}:${identity ?? "none"}`;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseStored(value: string): StoredProvisioningState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new JellyfinProvisioningError("storage_failure", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JellyfinProvisioningError("storage_failure");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schemaVersion === 2 &&
    record.state === "cleared" &&
    Object.keys(record).length === 2
  ) {
    return { schemaVersion: 2, state: "cleared" };
  }
  const credential = record.credential;
  const enabled = record.enabled;
  const template = record.template;
  const validatedAt = record.validatedAt;
  if (
    record.schemaVersion !== 2 ||
    typeof enabled !== "boolean" ||
    credential === null ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    (template !== null && (typeof template !== "object" || Array.isArray(template))) ||
    (record.protocolVersion !== "10.10" && record.protocolVersion !== "10.11") ||
    !validTimestamp(validatedAt)
  ) {
    throw new JellyfinProvisioningError("storage_failure");
  }
  const credentialRecord = credential as Record<string, unknown>;
  const templateRecord = template as Record<string, unknown> | null;
  const credentialParsed =
    credentialRecord.kind === "access_token"
      ? typeof credentialRecord.accessToken === "string" && credentialRecord.accessToken.length > 0
        ? credentialRecord
        : undefined
      : credentialRecord.kind === "api_key" &&
          typeof credentialRecord.apiKey === "string" &&
          credentialRecord.apiKey.length > 0
        ? credentialRecord
        : undefined;
  if (
    credentialParsed === undefined ||
    (templateRecord !== null &&
      (!validIdentifier(templateRecord.id) ||
        typeof templateRecord.displayName !== "string" ||
        templateRecord.displayName.length < 1 ||
        templateRecord.displayName.length > 160 ||
        templateRecord.policy === null ||
        typeof templateRecord.policy !== "object" ||
        Array.isArray(templateRecord.policy)))
  ) {
    throw new JellyfinProvisioningError("storage_failure");
  }
  return {
    credential: credentialParsed as StoredCredential,
    enabled,
    protocolVersion: record.protocolVersion as JellyfinProvisioningProtocolVersion,
    schemaVersion: 2,
    template:
      templateRecord === null
        ? null
        : {
            displayName: templateRecord.displayName as string,
            id: templateRecord.id as string,
            policy: templateRecord.policy as Record<string, unknown>,
          },
    validatedAt,
  };
}

function safeTemplate(user: JellyfinProvisioningAdminUser): JellyfinProvisioningTemplateSummary {
  return jellyfinProvisioningTemplateSummarySchema.parse({ displayName: user.Name, id: user.Id });
}

function templatePolicyWithoutOwnerFields(policy: Record<string, unknown>) {
  const schedules = policy.AccessSchedules;
  if (!Array.isArray(schedules)) return { ...policy };
  return {
    ...policy,
    AccessSchedules: schedules.map((schedule) => {
      if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) {
        return schedule;
      }
      const normalized = { ...(schedule as Record<string, unknown>) };
      delete normalized.Id;
      delete normalized.UserId;
      return normalized;
    }),
  };
}

function isTombstone(value: StoredProvisioningState): value is StoredProvisioningTombstone {
  return "state" in value;
}

export class JellyfinProvisioningService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createClient: (target: ConnectorTargetConfig) => JellyfinProvisioningAdminClient;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: JellyfinProvisioningDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createClient =
      dependencies.createClient ?? ((target) => new JellyfinProvisioningAdminClient(target));
    this.#createId = dependencies.createId ?? randomUUID;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
  }

  public get(
    connectorId: string,
    context: JellyfinProvisioningContext,
  ): JellyfinProvisioningConfig {
    this.#authorize(context);
    const connector = this.#connector(connectorId);
    const row = this.#row(connectorId);
    if (!row || !this.#bindingMatches(connector, row)) {
      return this.#safeEmpty(connectorId, row?.revision ?? 0, row ? "invalid" : "unvalidated");
    }
    const stored = this.#decrypt(connector, row);
    if (isTombstone(stored)) return this.#safeEmpty(connectorId, row.revision, "unvalidated");
    return this.#present(connector, row.revision, stored, connector.enabled === 1);
  }

  public async listTemplates(
    connectorId: string,
    context: JellyfinProvisioningContext,
  ): Promise<readonly JellyfinProvisioningTemplateSummary[]> {
    this.#authorize(context);
    const connector = this.#connector(connectorId);
    const row = this.#row(connectorId);
    if (connector.enabled !== 1) throw new JellyfinProvisioningError("connector_disabled");
    if (!row) throw new JellyfinProvisioningError("credential_not_configured");
    if (!this.#bindingMatches(connector, row))
      throw new JellyfinProvisioningError("binding_invalid");
    if (connector.instanceIdentityHash === null)
      throw new JellyfinProvisioningError("connector_not_verified");
    const stored = this.#decrypt(connector, row);
    if (isTombstone(stored)) throw new JellyfinProvisioningError("credential_not_configured");
    let validation: { protocolVersion: JellyfinProvisioningProtocolVersion };
    let users: readonly JellyfinProvisioningAdminUser[];
    try {
      validation = await this.#client(connector).validateAdministratorCredential({
        accessToken: this.#accessToken(stored.credential),
        credentialKind: stored.credential.kind,
        deviceId: DEVICE_ID,
        verifyServerIdentity: (serverId) => this.#serverIdentityMatches(connector, serverId),
      });
      users = await this.#client(connector).listTemplateUsers({
        accessToken: this.#accessToken(stored.credential),
        deviceId: DEVICE_ID,
        protocolVersion: validation.protocolVersion,
      });
    } catch (error) {
      throw new JellyfinProvisioningError(
        error instanceof JellyfinProvisioningUnsupportedVersionError
          ? "unsupported_version"
          : "upstream_validation_failed",
        { cause: error },
      );
    }
    return users
      .filter(
        (user) =>
          validIdentifier(user.Id) &&
          user.Name.trim().length > 0 &&
          !this.#isAdministrator(user) &&
          !this.#isDisabled(user),
      )
      .map(safeTemplate)
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
      );
  }

  public async replace(
    connectorId: string,
    input: JellyfinProvisioningReplaceRequest,
    context: JellyfinProvisioningContext,
  ): Promise<JellyfinProvisioningConfig> {
    this.#authorize(context);
    const parsed = jellyfinProvisioningReplaceRequestSchema.safeParse(input);
    if (!parsed.success || !validIdentifier(connectorId))
      throw new JellyfinProvisioningError("configuration_invalid");
    const connector = this.#connector(connectorId);
    const existing = this.#row(connectorId);
    const existingStored =
      existing && this.#bindingMatches(connector, existing)
        ? this.#decrypt(connector, existing)
        : undefined;
    const existingConfiguration =
      existingStored && !isTombstone(existingStored) ? existingStored : undefined;
    const credential = parsed.data.credential;
    let storedCredential: StoredCredential | undefined;
    let protocolVersion: JellyfinProvisioningProtocolVersion | undefined =
      existingConfiguration?.protocolVersion;
    let credentialWasValidated = false;
    if (credential.kind === "retain") {
      if (!existingConfiguration) throw new JellyfinProvisioningError("credential_not_configured");
      storedCredential = existingConfiguration.credential;
    } else if (credential.kind === "replace_password" || credential.kind === "replace_api_key") {
      const client = this.#client(connector);
      if (credential.kind === "replace_password") {
        let result: Awaited<
          ReturnType<JellyfinProvisioningAdminClient["authenticateAdministrator"]>
        >;
        try {
          const systemInfo = await client.readPublicSystemInfo();
          if (!this.#serverIdentityMatches(connector, systemInfo.serverId)) {
            throw new JellyfinProvisioningError("binding_invalid");
          }
          result = await client.authenticateAdministrator({
            deviceId: DEVICE_ID,
            password: credential.password,
            username: credential.username,
          });
        } catch (error) {
          if (error instanceof JellyfinProvisioningError) throw error;
          throw new JellyfinProvisioningError("upstream_validation_failed", { cause: error });
        }
        this.#assertAdministrator(result.User);
        storedCredential = { accessToken: result.AccessToken, kind: "access_token" };
      } else {
        storedCredential = { apiKey: credential.apiKey, kind: "api_key" };
      }
      try {
        protocolVersion = (
          await client.validateAdministratorCredential({
            accessToken: this.#accessToken(storedCredential!),
            credentialKind: storedCredential!.kind,
            deviceId: DEVICE_ID,
            verifyServerIdentity: (serverId) => this.#serverIdentityMatches(connector, serverId),
          })
        ).protocolVersion;
      } catch (error) {
        throw new JellyfinProvisioningError(
          error instanceof JellyfinProvisioningUnsupportedVersionError
            ? "unsupported_version"
            : "upstream_validation_failed",
          { cause: error },
        );
      }
      credentialWasValidated = true;
    }

    if (credential.kind !== "clear" && !storedCredential) {
      throw new JellyfinProvisioningError("credential_not_configured");
    }
    const templateId = parsed.data.templateUserId;
    let template: StoredProvisioningConfiguration["template"] =
      templateId !== null && existingConfiguration?.template?.id === templateId
        ? existingConfiguration.template
        : null;
    const localDisable = !parsed.data.enabled && credential.kind === "retain";
    if (
      credential.kind !== "clear" &&
      (parsed.data.enabled || credentialWasValidated || !localDisable)
    ) {
      if (!protocolVersion) throw new JellyfinProvisioningError("upstream_validation_failed");
      if (!credentialWasValidated) {
        try {
          protocolVersion = (
            await this.#client(connector).validateAdministratorCredential({
              accessToken: this.#accessToken(storedCredential!),
              credentialKind: storedCredential!.kind,
              deviceId: DEVICE_ID,
              verifyServerIdentity: (serverId) => this.#serverIdentityMatches(connector, serverId),
            })
          ).protocolVersion;
        } catch (error) {
          throw new JellyfinProvisioningError(
            error instanceof JellyfinProvisioningUnsupportedVersionError
              ? "unsupported_version"
              : "upstream_validation_failed",
            { cause: error },
          );
        }
      }
    }
    if (parsed.data.templateUserId !== null) {
      if (template === null) {
        if (localDisable) throw new JellyfinProvisioningError("template_invalid");
        if (!protocolVersion) throw new JellyfinProvisioningError("upstream_validation_failed");
        let user: JellyfinProvisioningAdminUser;
        try {
          user = await this.#client(connector).readTemplateUser({
            accessToken: this.#accessToken(storedCredential!),
            deviceId: DEVICE_ID,
            protocolVersion: protocolVersion!,
            userId: parsed.data.templateUserId,
          });
        } catch (error) {
          throw new JellyfinProvisioningError("template_invalid", { cause: error });
        }
        this.#assertTemplate(user);
        template = {
          displayName: user.Name,
          id: user.Id,
          policy: templatePolicyWithoutOwnerFields(user.Policy),
        };
      }
    }
    if (
      parsed.data.enabled &&
      (!template || !connector.enabled || connector.instanceIdentityHash === null)
    ) {
      throw new JellyfinProvisioningError(template ? "configuration_invalid" : "template_invalid");
    }
    if (credential.kind === "clear") {
      if (templateId !== null) throw new JellyfinProvisioningError("configuration_invalid");
      template = null;
    }
    const now = this.#now();
    const validatedAt = localDisable ? existingConfiguration!.validatedAt : now.getTime();
    const connectorRevision = connectorAdminRevision(connector);
    const binding = {
      configGeneration: connector.configGeneration,
      connectorRevision,
      instanceGeneration: connector.instanceGeneration,
      instanceIdentityHash: connector.instanceIdentityHash,
    };
    const payload =
      credential.kind === "clear"
        ? JSON.stringify({
            schemaVersion: 2,
            state: "cleared",
          } satisfies StoredProvisioningTombstone)
        : JSON.stringify({
            credential: storedCredential!,
            enabled: parsed.data.enabled,
            protocolVersion: protocolVersion!,
            schemaVersion: 2,
            template,
            validatedAt,
          } satisfies StoredProvisioningConfiguration);
    try {
      this.#database.sqlite
        .transaction(() => {
          const currentConnector = this.#connector(connectorId);
          const current = this.#row(connectorId);
          if (
            connectorAdminRevision(currentConnector) !== binding.connectorRevision ||
            currentConnector.configGeneration !== binding.configGeneration ||
            currentConnector.instanceGeneration !== binding.instanceGeneration ||
            currentConnector.instanceIdentityHash !== binding.instanceIdentityHash ||
            (current?.revision ?? 0) !== parsed.data.revision
          ) {
            throw new JellyfinProvisioningError("revision_conflict");
          }
          if (parsed.data.revision >= 2_147_483_647) {
            throw new JellyfinProvisioningError("revision_conflict");
          }
          const encrypted = this.#cipher.encrypt(
            payload,
            provisioningContext(
              connectorId,
              connectorRevision,
              currentConnector.instanceGeneration,
              currentConnector.instanceIdentityHash,
            ),
          );
          const nextRevision = parsed.data.revision + 1;
          if (current) {
            const changed = this.#database.sqlite
              .prepare(
                `update jellyfin_provisioning_configs set connector_revision = ?, connector_instance_generation = ?, connector_instance_identity_hash = ?, encrypted_configuration = ?, revision = ?, updated_at = ? where connector_id = ? and revision = ?`,
              )
              .run(
                connectorRevision,
                currentConnector.instanceGeneration,
                currentConnector.instanceIdentityHash,
                encrypted,
                nextRevision,
                now.getTime(),
                connectorId,
                parsed.data.revision,
              ).changes;
            if (changed !== 1) throw new JellyfinProvisioningError("revision_conflict");
          } else {
            this.#database.sqlite
              .prepare(
                `insert into jellyfin_provisioning_configs (connector_id, connector_revision, connector_instance_generation, connector_instance_identity_hash, encrypted_configuration, revision, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                connectorId,
                connectorRevision,
                currentConnector.instanceGeneration,
                currentConnector.instanceIdentityHash,
                encrypted,
                nextRevision,
                now.getTime(),
                now.getTime(),
              );
          }
          this.#audit(
            connectorId,
            context,
            parsed.data.enabled,
            storedCredential?.kind ?? null,
            template !== null,
            now,
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof JellyfinProvisioningError) throw error;
      throw new JellyfinProvisioningError("storage_failure", { cause: error });
    }
    return this.get(connectorId, context);
  }

  #connector(connectorId: string): ConnectorRow {
    const row = this.#database.sqlite
      .prepare(
        `select id, type, base_url as baseUrl, encrypted_credentials as encryptedCredentials, tls_policy as tlsPolicy, insecure_http_approved as insecureHttpApproved, capability_snapshot_json as capabilitySnapshotJson, enabled, instance_generation as instanceGeneration, config_generation as configGeneration, instance_identity_hash as instanceIdentityHash, created_at as createdAt, updated_at as updatedAt from connector_configs where id = ?`,
      )
      .get(connectorId) as ConnectorRow | undefined;
    if (!row) throw new JellyfinProvisioningError("connector_not_found");
    if (row.type !== "jellyfin") throw new JellyfinProvisioningError("connector_not_jellyfin");
    return row;
  }

  #row(connectorId: string) {
    return this.#database.db
      .select()
      .from(jellyfinProvisioningConfigs)
      .where(eq(jellyfinProvisioningConfigs.connectorId, connectorId))
      .get();
  }

  #bindingMatches(connector: ConnectorRow, row: typeof jellyfinProvisioningConfigs.$inferSelect) {
    return (
      row.connectorRevision === connectorAdminRevision(connector) &&
      row.connectorInstanceGeneration === connector.instanceGeneration &&
      row.connectorInstanceIdentityHash === connector.instanceIdentityHash
    );
  }

  #decrypt(connector: ConnectorRow, row: typeof jellyfinProvisioningConfigs.$inferSelect) {
    try {
      return parseStored(
        this.#cipher.decrypt(
          row.encryptedConfiguration,
          provisioningContext(
            connector.id,
            row.connectorRevision,
            row.connectorInstanceGeneration,
            row.connectorInstanceIdentityHash,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof JellyfinProvisioningError) throw error;
      throw new JellyfinProvisioningError("storage_failure", { cause: error });
    }
  }

  #target(connector: ConnectorRow): ConnectorTargetConfig {
    let parsed: { tlsCaCertificatePem?: unknown };
    try {
      if (new URL(connector.baseUrl).protocol !== "https:") {
        throw new JellyfinProvisioningError("configuration_invalid");
      }
      const envelope = JSON.parse(
        this.#cipher.decrypt(
          connector.encryptedCredentials,
          `connector_credentials:jellyfin:${connector.id}`,
        ),
      ) as { credentials?: unknown; tlsCaCertificatePem?: unknown };
      if (
        envelope.credentials !== undefined &&
        (envelope.credentials as { kind?: unknown }).kind !== "none"
      ) {
        throw new Error("jellyfin-credentials");
      }
      parsed = envelope;
    } catch (error) {
      if (error instanceof JellyfinProvisioningError) throw error;
      throw new JellyfinProvisioningError("storage_failure", { cause: error });
    }
    return {
      connectorId: connector.id,
      displayName: connector.id,
      baseUrl: connector.baseUrl,
      insecureHttpApproved: false,
      tlsPolicy: connector.tlsPolicy === "allow_self_signed" ? "allow_self_signed" : "strict",
      ...(typeof parsed.tlsCaCertificatePem === "string"
        ? { tlsCaCertificatePem: parsed.tlsCaCertificatePem }
        : {}),
    };
  }

  #client(connector: ConnectorRow) {
    return this.#createClient(this.#target(connector));
  }

  #serverIdentityMatches(connector: ConnectorRow, serverId: string) {
    return (
      connector.instanceIdentityHash !== null &&
      serverId.length >= 1 &&
      serverId.length <= 256 &&
      createHmac("sha256", this.#config.encryptionKey)
        .update("omnifin:v1:connector-instance-identity\0", "utf8")
        .update(serverId, "utf8")
        .digest("base64url") === connector.instanceIdentityHash
    );
  }

  #accessToken(credential: StoredCredential) {
    return credential.kind === "access_token" ? credential.accessToken : credential.apiKey;
  }

  #assertAdministrator(user: JellyfinProvisioningAdminUser) {
    if (this.#isDisabled(user) || !this.#isAdministrator(user))
      throw new JellyfinProvisioningError("upstream_validation_failed");
  }

  #assertTemplate(user: JellyfinProvisioningAdminUser) {
    if (
      !validIdentifier(user.Id) ||
      user.Name.trim().length === 0 ||
      this.#isDisabled(user) ||
      this.#isAdministrator(user)
    )
      throw new JellyfinProvisioningError("template_invalid");
  }

  #isAdministrator(user: JellyfinProvisioningAdminUser) {
    return user.Policy.IsAdministrator === true;
  }

  #isDisabled(user: JellyfinProvisioningAdminUser) {
    return user.Policy.IsDisabled === true;
  }

  #present(
    connector: ConnectorRow,
    revision: number,
    stored: StoredProvisioningConfiguration,
    connectorEnabled: boolean,
  ) {
    return jellyfinProvisioningConfigSchema.parse({
      connectorId: connector.id,
      credentialConfigured: true,
      credentialKind: stored.credential.kind,
      enabled: stored.enabled && connectorEnabled,
      revision,
      template:
        stored.template === null
          ? null
          : safeTemplate({
              Id: stored.template.id,
              Name: stored.template.displayName,
              Policy: stored.template.policy,
            }),
      validatedAt: new Date(stored.validatedAt).toISOString(),
      validationState: "valid",
    });
  }

  #safeEmpty(connectorId: string, revision: number, validationState: "invalid" | "unvalidated") {
    return jellyfinProvisioningConfigSchema.parse({
      connectorId,
      credentialConfigured: false,
      credentialKind: null,
      enabled: false,
      revision,
      template: null,
      validatedAt: null,
      validationState,
    });
  }

  #audit(
    connectorId: string,
    context: JellyfinProvisioningContext,
    enabled: boolean,
    credentialKind: string | null,
    templateConfigured: boolean,
    now: Date,
  ) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (id, actor_user_id, session_id, actor_session_id, actor_auth_method, event_type, outcome, target_type, target_id, request_id, metadata_json, ip_hash, created_at) values (?, ?, ?, ?, ?, 'connector.jellyfin_provisioning.updated', 'success', 'connector', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#createId(),
        context.principal.userId,
        context.principal.sessionId,
        context.principal.sessionId,
        context.principal.authenticationMethod.kind,
        connectorId,
        context.requestId ?? null,
        JSON.stringify({
          credentialConfigured: credentialKind !== null,
          credentialKind,
          enabled,
          templateConfigured,
        }),
        context.ipAddress
          ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
          : null,
        now.getTime(),
      );
  }

  #authorize(context: JellyfinProvisioningContext) {
    if (context.principal.authenticationMethod.kind === "recovery")
      requirePermission(context.principal, "recovery.jellyfin.manage");
    else requirePermission(context.principal, "connectors.manage");
  }

  #now() {
    const now = this.#clock();
    if (!validTimestamp(now.getTime())) throw new JellyfinProvisioningError("storage_failure");
    return new Date(now.getTime());
  }
}
