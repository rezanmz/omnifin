import { createHmac, randomUUID } from "node:crypto";
import type { JellyfinProvisioningAdminClient } from "@omnifin/connectors/auth/jellyfin-provisioning-admin-client";
import type { ConnectorTargetConfig } from "@omnifin/connectors/types";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher } from "../security/crypto.js";
import { connectorAdminRevision } from "../connectors/admin-service.js";
import {
  JellyfinActivationOperationRepository,
  type JellyfinActivationOperation,
  type JellyfinActivationStageArtifact,
} from "./jellyfin-activation-operation.js";

const DEVICE_ID = "omnifin-activation-saga";
const LEASE_MS = 15_000;
const STAGE_ATTEMPTS = 3;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PASSWORD_PATTERN = /^[A-Za-z0-9._~!$%&*+=?@-]{32,128}$/u;

export type JellyfinActivationDisposition = "activated_ready" | "in_progress" | "manual_pairing";

export type JellyfinActivationReason =
  | "authentication_failed"
  | "binding_changed"
  | "connector_unavailable"
  | "create_failed"
  | "create_outcome_uncertain"
  | "cleanup_uncertain"
  | "identity_invalid"
  | "invalid_state"
  | "invite_expired"
  | "link_exists"
  | "policy_failed"
  | "response_invalid"
  | "user_not_pending";

const CLEANUP_CAPABILITY = Symbol("jellyfin-activation-cleanup-capability");

export class JellyfinActivationCleanupCapability {
  readonly [CLEANUP_CAPABILITY] = true;
  readonly #operationId: string;

  constructor(operationId: string) {
    this.#operationId = operationId;
    Object.freeze(this);
  }

  get operationId() {
    return this.#operationId;
  }

  public toJSON() {
    throw new TypeError("Jellyfin activation cleanup capabilities are internal-only");
  }
}

export interface JellyfinActivationSagaResult {
  readonly disposition: JellyfinActivationDisposition;
  readonly reason: JellyfinActivationReason | null;
}

export interface JellyfinActivationSagaDependencies {
  clock?: () => number;
  createClient?: (target: ConnectorTargetConfig) => JellyfinProvisioningAdminClient;
  createId?: () => string;
  leaseOwner?: string;
}

export type JellyfinActivationCleanupResult =
  | { readonly disposition: "cleanup_confirmed" }
  | { readonly disposition: "cleanup_uncertain"; readonly reason: "cleanup_uncertain" }
  | { readonly disposition: "cleanup_in_progress" }
  | { readonly disposition: "cleanup_rejected"; readonly reason: JellyfinActivationReason };

function internalCleanupResult<T extends JellyfinActivationCleanupResult>(result: T): T {
  Object.defineProperty(result, "toJSON", {
    enumerable: false,
    value: () => {
      throw new TypeError("Jellyfin activation cleanup results are internal-only");
    },
  });
  return Object.freeze(result);
}

interface ConnectorRow {
  baseUrl: string;
  configGeneration: number;
  encryptedCredentials: string;
  enabled: number;
  id: string;
  insecureHttpApproved: number;
  instanceGeneration: number;
  instanceIdentityHash: string | null;
  tlsPolicy: "strict" | "allow_self_signed";
  type: string;
}

interface ProvisioningRow {
  connectorInstanceGeneration: number;
  connectorInstanceIdentityHash: string | null;
  connectorRevision: string;
  encryptedConfiguration: string;
  revision: number;
}

interface ProvisioningState {
  credential: { kind: "access_token"; accessToken: string } | { kind: "api_key"; apiKey: string };
  enabled: boolean;
  protocolVersion: "10.10" | "10.11";
  schemaVersion: 2;
  template: { policy: Record<string, unknown> } | null;
}

interface Binding {
  client: JellyfinProvisioningAdminClient;
  connector: ConnectorRow;
  credential: string;
  policy: Record<string, unknown>;
  serverId: string | null;
}

function internalResult(
  disposition: JellyfinActivationDisposition,
  reason: JellyfinActivationReason | null = null,
): JellyfinActivationSagaResult {
  const result = { disposition, reason } satisfies JellyfinActivationSagaResult;
  Object.defineProperty(result, "toJSON", {
    enumerable: false,
    value: () => {
      throw new TypeError("Jellyfin activation saga results are internal-only");
    },
  });
  return Object.freeze(result);
}

function failureReason(error: unknown, createStage = false): JellyfinActivationReason {
  const candidate = error as { cancellationSource?: unknown; code?: unknown; retryable?: unknown };
  if (
    candidate.cancellationSource === "timeout" ||
    candidate.cancellationSource === "runtime_drain" ||
    candidate.cancellationSource === "response_closed" ||
    candidate.cancellationSource === "response_error" ||
    candidate.code === "transport_error" ||
    candidate.code === "timeout"
  ) {
    return "create_outcome_uncertain";
  }
  return createStage ? "create_failed" : "response_invalid";
}

export class JellyfinActivationSaga {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => number;
  readonly #createClient: (target: ConnectorTargetConfig) => JellyfinProvisioningAdminClient;
  readonly #createId: () => string;
  readonly #database: DatabaseHandle;
  readonly #encryptionKey: Buffer;
  readonly #leaseOwner: string;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey">,
    dependencies: JellyfinActivationSagaDependencies = {},
  ) {
    this.#database = database;
    this.#encryptionKey = config.encryptionKey;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? Date.now;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#leaseOwner = dependencies.leaseOwner ?? `activation-${randomUUID()}`;
    this.#createClient =
      dependencies.createClient ??
      (() => {
        throw new Error("Jellyfin activation client dependency is not configured");
      });
  }

  public async run(operationId: string): Promise<JellyfinActivationSagaResult> {
    const repository = new JellyfinActivationOperationRepository(
      this.#database.sqlite,
      this.#encryptionKey,
    );
    const operation = repository.read(operationId);
    if (!operation) return internalResult("manual_pairing", "invalid_state");
    if (operation.state === "manual_required" || operation.state === "tombstoned") {
      return internalResult("manual_pairing", this.#safeReason(operation.failureCode));
    }
    if (operation.state === "auth_pending") return internalResult("activated_ready");
    if (operation.state === "create_dispatched" && operation.createdIdRecordedAt === null) {
      if (operation.leaseExpiresAt !== null && operation.leaseExpiresAt >= this.#clock()) {
        return internalResult("in_progress");
      }
      try {
        repository.markCreateOutcomeUncertain(operation.id, this.#clock());
      } catch {
        // A concurrent caller won the terminal transition.
      }
      return internalResult("manual_pairing", "create_outcome_uncertain");
    }
    if (
      operation.state !== "reserved" &&
      operation.state !== "created" &&
      operation.state !== "policy_pending"
    ) {
      return this.#manual(repository, operation, "invalid_state");
    }
    if (operation.state === "reserved") return this.#create(repository, operation);
    return this.#runKnownId(repository, operation);
  }

  public createConfirmedCleanupCapability(operationId: string) {
    return new JellyfinActivationCleanupCapability(operationId);
  }

  public async confirmedCleanup(
    capability: JellyfinActivationCleanupCapability,
  ): Promise<JellyfinActivationCleanupResult> {
    if (
      !(capability instanceof JellyfinActivationCleanupCapability) ||
      capability[CLEANUP_CAPABILITY] !== true
    ) {
      return internalCleanupResult({ disposition: "cleanup_rejected", reason: "invalid_state" });
    }
    const repository = new JellyfinActivationOperationRepository(
      this.#database.sqlite,
      this.#encryptionKey,
    );
    const operation = repository.read(capability.operationId);
    if (
      !operation ||
      operation.state !== "manual_required" ||
      operation.failureCode === "cleanup_uncertain"
    ) {
      return internalCleanupResult({ disposition: "cleanup_rejected", reason: "invalid_state" });
    }
    let artifact: JellyfinActivationStageArtifact;
    try {
      artifact = repository.readStageArtifact(operation.id);
    } catch {
      return internalCleanupResult({ disposition: "cleanup_rejected", reason: "invalid_state" });
    }
    const link = this.#database.sqlite
      .prepare(
        "select 1 from service_identity_links where provisioned_by_activation_id = ? limit 1",
      )
      .get(operation.id);
    if (link)
      return internalCleanupResult({ disposition: "cleanup_rejected", reason: "link_exists" });
    const existingReservation = repository.readCleanupReservation(operation.id);
    if (existingReservation) {
      if (existingReservation.state === "dispatched") {
        if (existingReservation.leaseExpiresAt >= this.#clock()) {
          return internalCleanupResult({ disposition: "cleanup_in_progress" });
        }
        repository.expireCleanupReservation(operation.id, this.#clock());
        this.#auditCleanup(operation, "uncertain");
        return internalCleanupResult({
          disposition: "cleanup_rejected",
          reason: "cleanup_uncertain",
        });
      } else {
        return internalCleanupResult({
          disposition: "cleanup_rejected",
          reason: "cleanup_uncertain",
        });
      }
    }
    const binding = await this.#binding(operation, true, false);
    if ("reason" in binding)
      return internalCleanupResult({ disposition: "cleanup_rejected", reason: binding.reason });
    let reserved: JellyfinActivationOperation;
    try {
      reserved = repository.reserveCleanup({
        id: operation.id,
        leaseOwner: `cleanup-${randomUUID()}`,
        leaseExpiresAt: this.#clock() + LEASE_MS,
        now: this.#clock(),
      });
    } catch {
      return internalCleanupResult({ disposition: "cleanup_in_progress" });
    }
    const reservedRevision = reserved.revision;
    const owner = reserved.leaseOwner!;
    const rebound = await this.#binding(reserved, true, false);
    if ("reason" in rebound) {
      try {
        repository.markCleanupUncertain(reserved.id, this.#clock(), owner, reservedRevision);
      } catch {
        // Another trusted cleanup caller may have recorded the uncertainty.
      }
      this.#auditCleanup(operation, "uncertain");
      return internalCleanupResult({ disposition: "cleanup_rejected", reason: rebound.reason });
    }
    try {
      await rebound.client.deleteUser({
        accessToken: rebound.credential,
        deviceId: DEVICE_ID,
        userId: artifact.createdId,
      });
      repository.completeConfirmedCleanup(reserved.id, this.#clock(), owner, reservedRevision);
      this.#auditCleanup(operation, "confirmed");
      return internalCleanupResult({ disposition: "cleanup_confirmed" });
    } catch {
      try {
        repository.markCleanupUncertain(reserved.id, this.#clock(), owner, reservedRevision);
      } catch {
        // Another trusted cleanup caller may have recorded the uncertainty.
      }
      this.#auditCleanup(operation, "uncertain");
      return internalCleanupResult({
        disposition: "cleanup_uncertain",
        reason: "cleanup_uncertain",
      });
    }
  }

  async #create(
    repository: JellyfinActivationOperationRepository,
    operation: JellyfinActivationOperation,
  ): Promise<JellyfinActivationSagaResult> {
    const beforeFence = await this.#binding(operation, false);
    if ("reason" in beforeFence) return this.#manual(repository, operation, beforeFence.reason);
    const now = this.#clock();
    if (
      operation.leaseExpiresAt === null ||
      operation.leaseOwner === null ||
      operation.leaseExpiresAt >= now
    ) {
      return internalResult("in_progress");
    }
    let fenced: JellyfinActivationOperation;
    try {
      fenced = repository.claimLease({
        id: operation.id,
        expectedOwner: operation.leaseOwner,
        expectedExpiresAt: operation.leaseExpiresAt,
        leaseOwner: this.#leaseOwner,
        leaseExpiresAt: now + LEASE_MS,
        now,
      });
      repository.dispatchCreate({ id: fenced.id, leaseOwner: this.#leaseOwner, now });
    } catch {
      return internalResult("in_progress");
    }

    const binding = await this.#binding(repository.read(operation.id)!, true);
    if ("reason" in binding)
      return this.#manual(repository, repository.read(operation.id)!, binding.reason);
    const credentials = this.#credentials(operation.id);
    try {
      const createdId = await binding.client.createUser({
        accessToken: binding.credential,
        deviceId: DEVICE_ID,
        password: credentials.password,
        username: credentials.username,
      });
      if (createdId.length < 1 || createdId.length > 256)
        throw new Error("invalid create response");
      repository.recordCreatedIdArtifact({ id: operation.id, createdId, now: this.#clock() });
      repository.recordStageArtifact({
        id: operation.id,
        artifact: { createdId, password: credentials.password, username: credentials.username },
        state: "created",
        now: this.#clock(),
      });
    } catch (error) {
      return this.#manual(repository, repository.read(operation.id)!, failureReason(error, true));
    }
    return this.#runKnownId(repository, repository.read(operation.id)!);
  }

  async #runKnownId(
    repository: JellyfinActivationOperationRepository,
    operation: JellyfinActivationOperation,
  ): Promise<JellyfinActivationSagaResult> {
    let artifact: JellyfinActivationStageArtifact;
    try {
      artifact = repository.readStageArtifact(operation.id);
    } catch {
      return internalResult("in_progress");
    }
    const binding = await this.#binding(operation, true);
    if ("reason" in binding) return this.#manual(repository, operation, binding.reason);
    const credentials = this.#credentials(operation.id);

    if (operation.state === "created") {
      try {
        operation = repository.acquireStageLease({
          id: operation.id,
          leaseOwner: this.#leaseOwner,
          leaseExpiresAt: this.#clock() + LEASE_MS,
          now: this.#clock(),
        });
      } catch {
        return internalResult("in_progress");
      }
      for (let attempt = 0; attempt < STAGE_ATTEMPTS; attempt += 1) {
        const current = await this.#binding(operation, true);
        if ("reason" in current) return this.#manual(repository, operation, current.reason);
        try {
          operation = repository.beginStageAttempt({
            id: operation.id,
            leaseOwner: this.#leaseOwner,
            now: this.#clock(),
            state: "created",
          });
          await current.client.applyUserPolicy({
            accessToken: current.credential,
            deviceId: DEVICE_ID,
            policy: current.policy,
            userId: artifact.createdId,
          });
          repository.recordStageArtifact({
            id: operation.id,
            artifact,
            state: "policy_pending",
            now: this.#clock(),
          });
          operation = repository.read(operation.id)!;
          break;
        } catch (error) {
          if (attempt === STAGE_ATTEMPTS - 1) {
            return this.#manual(repository, operation, failureReason(error));
          }
        }
      }
    }

    let current = repository.read(operation.id)!;
    if (current.state === "auth_pending") return internalResult("activated_ready");
    try {
      current = repository.acquireStageLease({
        id: current.id,
        leaseOwner: this.#leaseOwner,
        leaseExpiresAt: this.#clock() + LEASE_MS,
        now: this.#clock(),
      });
    } catch {
      return internalResult("in_progress");
    }
    artifact = repository.readStageArtifact(operation.id);
    for (let attempt = 0; attempt < STAGE_ATTEMPTS; attempt += 1) {
      const latest = await this.#binding(current, true);
      if ("reason" in latest) return this.#manual(repository, current, latest.reason);
      try {
        current = repository.beginStageAttempt({
          id: current.id,
          leaseOwner: this.#leaseOwner,
          now: this.#clock(),
          state: "policy_pending",
        });
        const authentication = await latest.client.authenticateCreatedUser({
          deviceId: DEVICE_ID,
          password: credentials.password,
          username: credentials.username,
        });
        if (
          authentication.userId !== artifact.createdId ||
          authentication.serverId !== latest.serverId
        ) {
          return this.#manual(repository, current, "response_invalid");
        }
        repository.recordStageArtifact({
          id: current.id,
          artifact: { ...artifact, accessToken: authentication.accessToken },
          state: "auth_pending",
          now: this.#clock(),
        });
        return internalResult("activated_ready");
      } catch (error) {
        if (attempt === STAGE_ATTEMPTS - 1) {
          return this.#manual(repository, current, failureReason(error));
        }
      }
    }
    return internalResult("in_progress");
  }

  async #binding(
    operation: JellyfinActivationOperation,
    verifyServerIdentity: boolean,
    checkLocalState = true,
  ): Promise<Binding | { reason: JellyfinActivationReason }> {
    const connector = this.#database.sqlite
      .prepare(
        `select id, type, base_url as baseUrl, encrypted_credentials as encryptedCredentials,
         insecure_http_approved as insecureHttpApproved, tls_policy as tlsPolicy, enabled,
         instance_generation as instanceGeneration, config_generation as configGeneration,
         instance_identity_hash as instanceIdentityHash
         from connector_configs where id = ?`,
      )
      .get(operation.connectorId) as ConnectorRow | undefined;
    if (!connector || connector.type !== "jellyfin" || connector.enabled !== 1) {
      return { reason: "connector_unavailable" };
    }
    const local = this.#database.sqlite
      .prepare(
        `select u.status as userStatus,
                exists(select 1 from service_identity_links link
                       where link.user_id = u.id and link.service = 'jellyfin') as linkExists,
                e.user_id as identityUserId
         from users u
         left join external_identities e on e.id = ?
         where u.id = ?`,
      )
      .get(operation.externalIdentityId, operation.userId) as
      { identityUserId: string | null; linkExists: number; userStatus: string } | undefined;
    const invitation = this.#database.sqlite
      .prepare(
        "select id, consumed_at as consumedAt, revoked_at as revokedAt from invitations where id = ?",
      )
      .get(operation.invitationId) as
      { consumedAt: number | null; id: string; revokedAt: number | null } | undefined;
    if (checkLocalState && (!local || local.userStatus !== "pending_link"))
      return { reason: "user_not_pending" };
    if (checkLocalState && (local?.linkExists ?? 1) !== 0) return { reason: "link_exists" };
    if (
      (checkLocalState && (local?.identityUserId ?? null) !== operation.userId) ||
      !invitation ||
      invitation.consumedAt !== null ||
      invitation.revokedAt !== null
    ) {
      return { reason: "identity_invalid" };
    }
    if (
      this.#clock() >=
      (
        this.#database.sqlite
          .prepare("select expires_at as expiresAt from invitations where id = ?")
          .get(operation.invitationId) as { expiresAt: number }
      ).expiresAt
    ) {
      return { reason: "invite_expired" };
    }
    const provisioning = this.#database.sqlite
      .prepare(
        `select connector_revision as connectorRevision,
                connector_instance_generation as connectorInstanceGeneration,
                connector_instance_identity_hash as connectorInstanceIdentityHash,
                encrypted_configuration as encryptedConfiguration, revision
         from jellyfin_provisioning_configs where connector_id = ?`,
      )
      .get(operation.connectorId) as ProvisioningRow | undefined;
    if (
      !provisioning ||
      provisioning.revision !== operation.provisioningRevision ||
      provisioning.connectorRevision !== connectorAdminRevision(connector) ||
      provisioning.connectorInstanceGeneration !== connector.instanceGeneration ||
      provisioning.connectorInstanceIdentityHash !== connector.instanceIdentityHash ||
      operation.connectorConfigGeneration !== connector.configGeneration ||
      operation.connectorInstanceGeneration !== connector.instanceGeneration ||
      operation.connectorInstanceIdentityHash !== connector.instanceIdentityHash
    ) {
      return { reason: "binding_changed" };
    }
    let state: ProvisioningState;
    try {
      state = JSON.parse(
        this.#cipher.decrypt(
          provisioning.encryptedConfiguration,
          `jellyfin_provisioning:${connector.id}:${provisioning.connectorRevision}:${provisioning.connectorInstanceGeneration}:${provisioning.connectorInstanceIdentityHash ?? "none"}`,
        ),
      ) as ProvisioningState;
    } catch {
      return { reason: "binding_changed" };
    }
    if (!state.enabled || state.schemaVersion !== 2 || state.template === null) {
      return { reason: "binding_changed" };
    }
    const credential =
      state.credential.kind === "access_token"
        ? state.credential.accessToken
        : state.credential.apiKey;
    let tlsCaCertificatePem: string | undefined;
    try {
      const envelope = JSON.parse(
        this.#cipher.decrypt(
          connector.encryptedCredentials,
          `connector_credentials:jellyfin:${connector.id}`,
        ),
      ) as { tlsCaCertificatePem?: unknown };
      if (typeof envelope.tlsCaCertificatePem === "string")
        tlsCaCertificatePem = envelope.tlsCaCertificatePem;
    } catch {
      return { reason: "connector_unavailable" };
    }
    const target: ConnectorTargetConfig = {
      connectorId: connector.id,
      displayName: connector.id,
      baseUrl: connector.baseUrl,
      insecureHttpApproved: connector.insecureHttpApproved === 1,
      tlsPolicy: connector.tlsPolicy,
      ...(tlsCaCertificatePem === undefined ? {} : { tlsCaCertificatePem }),
    };
    const client = this.#createClient(target);
    if (!verifyServerIdentity) {
      return { client, connector, credential, policy: state.template.policy, serverId: null };
    }
    let serverId: string;
    try {
      serverId = await client.readServerIdentity();
    } catch {
      return { reason: "connector_unavailable" };
    }
    if (
      connector.instanceIdentityHash === null ||
      createHmac("sha256", this.#encryptionKey)
        .update("omnifin:v1:connector-instance-identity\0", "utf8")
        .update(serverId, "utf8")
        .digest("base64url") !== connector.instanceIdentityHash
    ) {
      return { reason: "binding_changed" };
    }
    return { client, connector, credential, policy: state.template.policy, serverId };
  }

  #credentials(operationId: string) {
    const digest = createHmac("sha256", this.#encryptionKey)
      .update(`omnifin:v1:jellyfin-activation-credentials:${operationId}`, "utf8")
      .digest("base64url");
    const username = `omnifin-${operationId.slice(-16)}`;
    const password = `${digest}A1!`.slice(0, 64);
    if (!USERNAME_PATTERN.test(username) || !PASSWORD_PATTERN.test(password)) {
      throw new Error("generated activation credentials are invalid");
    }
    return { password, username };
  }

  #manual(
    repository: JellyfinActivationOperationRepository,
    operation: JellyfinActivationOperation,
    reason: JellyfinActivationReason,
  ) {
    try {
      repository.markManualRequired({
        id: operation.id,
        failureCode: reason,
        incrementRetry: false,
        now: this.#clock(),
      });
      this.#audit(operation, reason);
    } catch {
      // Another caller may have won the CAS. The safe disposition is unchanged.
    }
    return internalResult("manual_pairing", reason);
  }

  #safeReason(value: string | null): JellyfinActivationReason | null {
    return value && /^[a-z_]+$/u.test(value) ? (value as JellyfinActivationReason) : null;
  }

  #audit(operation: JellyfinActivationOperation, reason: JellyfinActivationReason) {
    this.#database.sqlite
      .prepare(
        `insert into audit_events (id, event_type, outcome, target_type, target_id, metadata_json, created_at)
         values (?, 'activation.saga.manual_required', 'failure', 'jellyfin_activation', ?, ?, ?)`,
      )
      .run(
        this.#createId(),
        operation.id,
        JSON.stringify({
          connectorConfigGeneration: operation.connectorConfigGeneration,
          connectorInstanceGeneration: operation.connectorInstanceGeneration,
          reason,
          state: operation.state,
        }),
        this.#clock(),
      );
  }

  #auditCleanup(operation: JellyfinActivationOperation, outcome: "confirmed" | "uncertain") {
    try {
      this.#database.sqlite
        .prepare(
          `insert into audit_events (id, event_type, outcome, target_type, target_id, metadata_json, created_at)
           values (?, ?, ?, 'jellyfin_activation', ?, ?, ?)`,
        )
        .run(
          this.#createId(),
          `activation.cleanup.${outcome}`,
          outcome === "confirmed" ? "success" : "failure",
          operation.id,
          JSON.stringify({ outcome, state: operation.state }),
          this.#clock(),
        );
    } catch {
      // The upstream outcome is authoritative; audit failure cannot trigger another DELETE.
    }
  }
}
