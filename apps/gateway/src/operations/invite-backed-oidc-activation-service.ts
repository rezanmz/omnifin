import { randomUUID } from "node:crypto";
import type { VerifiedOidcGrant } from "../auth/oidc/protocol.js";
import type { InvitationService } from "../auth/invitation-service.js";
import type { OidcIdentityService } from "../auth/oidc/identity-service.js";
import type { OidcSignInService } from "../auth/oidc/sign-in-service.js";
import type {
  SessionService,
  IssuedSession,
  ValidatedOidcPairingSession,
} from "../auth/session-service.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, randomToken } from "../security/crypto.js";
import { JellyfinActivationOperationRepository } from "./jellyfin-activation-operation.js";
import {
  JellyfinActivationSaga,
  type JellyfinActivationSagaDependencies,
  type JellyfinActivationSagaResult,
} from "./jellyfin-activation-saga.js";

export type InviteBackedOidcActivationDisposition = "active" | "pending_link";

export interface InviteBackedOidcActivationResult {
  readonly disposition: InviteBackedOidcActivationDisposition;
  readonly session: IssuedSession;
  readonly saga: JellyfinActivationSagaResult;
  toJSON(): never;
}

export interface InviteBackedOidcActivationDependencies extends JellyfinActivationSagaDependencies {
  createId?: () => string;
}

function internalResult(
  disposition: InviteBackedOidcActivationDisposition,
  session: IssuedSession,
  saga: JellyfinActivationSagaResult,
): InviteBackedOidcActivationResult {
  const result = Object.create(null) as InviteBackedOidcActivationResult;
  Object.defineProperties(result, {
    disposition: { enumerable: false, value: disposition },
    session: { enumerable: false, value: session },
    saga: { enumerable: false, value: saga },
    toJSON: {
      enumerable: false,
      value: () => {
        throw new TypeError("Invite-backed activation results are internal-only");
      },
    },
  });
  return Object.freeze(result);
}

function accessTokenContext(linkId: string) {
  return `service_identity_access_token:jellyfin:${linkId}`;
}

export class InviteBackedOidcActivationService {
  readonly #config: Pick<AppConfig, "encryptionKey">;
  readonly #database: DatabaseHandle;
  readonly #identity: OidcIdentityService;
  readonly #sessions: SessionService;
  readonly #saga: JellyfinActivationSaga;
  readonly #cipher: EnvelopeCipher;
  readonly #createId: () => string;
  readonly #clock: () => number;
  readonly #dependencies: InviteBackedOidcActivationDependencies;
  readonly #leaseOwner: string;

  public constructor(
    database: DatabaseHandle,
    config: Pick<AppConfig, "encryptionKey" | "session">,
    dependencies: InviteBackedOidcActivationDependencies,
    identity: OidcIdentityService,
    invitations: InvitationService,
    sessions: SessionService,
    _signIn: OidcSignInService,
  ) {
    this.#database = database;
    this.#leaseOwner = dependencies.leaseOwner ?? `activation-${randomUUID()}`;
    this.#dependencies = { ...dependencies, leaseOwner: this.#leaseOwner };
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#identity = identity;
    this.#sessions = sessions;
    this.#createId = dependencies.createId ?? (() => randomToken(16));
    this.#clock = dependencies.clock ?? Date.now;
    this.#saga = new JellyfinActivationSaga(database, config, this.#dependencies);
  }

  public async complete(input: {
    grant: VerifiedOidcGrant;
    handoffToken: unknown;
    invitationId: string;
    currentSessionToken?: unknown;
    ipAddress?: string;
    requestId?: string;
    userAgent?: string;
  }): Promise<
    InviteBackedOidcActivationResult | { readonly status: "denied"; readonly reason: string }
  > {
    let operationId: string | undefined;
    let pendingSession: IssuedSession | undefined;
    let pairing: ValidatedOidcPairingSession | undefined;
    const now = this.#clock();
    const admission = this.#database.sqlite
      .transaction(() => {
        const existing = this.#database.sqlite
          .prepare(
            `select o.id as operationId, o.user_id as userId, o.external_identity_id as externalIdentityId,
                    o.state, o.activation_status as activationStatus
             from jellyfin_activation_operations o
             join invitations i on i.activation_operation_id = o.id
             where i.id = ? and i.activation_operation_id = o.id`,
          )
          .get(input.invitationId) as
          | {
              activationStatus: "pending" | "completed";
              externalIdentityId: string;
              operationId: string;
              state: string;
              userId: string;
            }
          | undefined;
        if (existing) {
          const identity = this.#identity.resolveInExistingTransaction({ grant: input.grant });
          if (identity.status === "denied") return identity;
          if (
            identity.attribution.userId !== existing.userId ||
            identity.attribution.externalIdentityId !== existing.externalIdentityId
          )
            return { status: "denied" as const, reason: "invalid_request" as const };
          if (existing.activationStatus === "completed")
            return { status: "denied" as const, reason: "invalid_request" as const };
          const resumed =
            input.currentSessionToken === undefined
              ? null
              : this.#sessions.resumeValidatedOidcPairingSession(
                  input.currentSessionToken,
                  existing.userId,
                  existing.externalIdentityId,
                );
          if (!resumed) return { status: "denied" as const, reason: "invalid_request" as const };
          operationId = existing.operationId;
          pairing = resumed;
          return { identity, session: undefined, target: this.#exactTarget() };
        }
        const identity = this.#identity.resolveInExistingTransaction(
          { grant: input.grant, ...(input.requestId ? { requestId: input.requestId } : {}) },
          { registration: { handoffToken: input.handoffToken, invitationId: input.invitationId } },
        );
        if (identity.status === "denied") return identity;
        const session = this.#sessions.createSession({
          attribution: identity.attribution,
          ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        });
        pendingSession = session;
        pairing =
          this.#sessions.beginValidatedOidcPairingSession(
            this.#sessions.validateSessionCsrf(session.sessionToken, session.csrfToken)!,
          ) ?? undefined;
        const target = this.#exactTarget();
        if (!target || !pairing) return { identity, session, target: null };
        operationId = `jellyfin_${this.#createId()}`;
        const repository = new JellyfinActivationOperationRepository(
          this.#database.sqlite,
          this.#config.encryptionKey,
        );
        repository.reserveInExistingTransaction({
          id: operationId,
          invitationId: input.invitationId,
          userId: identity.attribution.userId,
          externalIdentityId: identity.attribution.externalIdentityId,
          connectorId: target.connectorId,
          connectorConfigGeneration: target.configGeneration,
          connectorInstanceGeneration: target.instanceGeneration,
          connectorInstanceIdentityHash: target.instanceIdentityHash,
          provisioningRevision: target.provisioningRevision,
          leaseOwner: this.#leaseOwner,
          leaseExpiresAt: now + 1,
          now,
        });
        return { identity, session, target };
      })
      .immediate();
    if ("status" in admission && admission.status === "denied") return admission;
    if (!operationId || !pairing || !pendingSession) {
      return internalResult(
        "pending_link",
        pendingSession ?? (admission as { session: IssuedSession }).session,
        {
          disposition: "manual_pairing",
          reason: "connector_unavailable",
        } as JellyfinActivationSagaResult,
      );
    }
    const saga = await this.#saga.run(operationId);
    if (saga.disposition !== "activated_ready")
      return internalResult("pending_link", pendingSession, saga);
    try {
      const issued = this.#finalize(operationId, pairing, input);
      return internalResult("active", issued, saga);
    } catch {
      return internalResult("pending_link", pendingSession, saga);
    }
  }

  #exactTarget() {
    const rows = this.#database.sqlite
      .prepare(
        `select c.id, c.config_generation as configGeneration,
                c.instance_generation as instanceGeneration,
                c.instance_identity_hash as instanceIdentityHash,
                c.base_url as baseUrl, c.tls_policy as tlsPolicy,
                c.insecure_http_approved as insecureHttpApproved,
                p.revision as provisioningRevision
         from connector_configs c join jellyfin_provisioning_configs p on p.connector_id = c.id
         where c.type = 'jellyfin' and c.enabled = 1`,
      )
      .all() as Array<{
      id: string;
      configGeneration: number;
      instanceGeneration: number;
      instanceIdentityHash: string | null;
      provisioningRevision: number;
      baseUrl: string;
      tlsPolicy: string;
      insecureHttpApproved: number;
    }>;
    const row = rows[0];
    return rows.length === 1 &&
      row !== undefined &&
      typeof row.baseUrl === "string" &&
      row.baseUrl.length > 0 &&
      row.baseUrl.length <= 2048 &&
      (row.tlsPolicy === "strict" || row.tlsPolicy === "allow_self_signed") &&
      (row.insecureHttpApproved === 0 || row.insecureHttpApproved === 1)
      ? {
          connectorId: row.id,
          configGeneration: row.configGeneration,
          instanceGeneration: row.instanceGeneration,
          instanceIdentityHash: row.instanceIdentityHash,
          provisioningRevision: row.provisioningRevision,
        }
      : null;
  }

  #finalize(
    operationId: string,
    pairing: ValidatedOidcPairingSession,
    input: { requestId?: string; ipAddress?: string; userAgent?: string },
  ) {
    return this.#database.sqlite
      .transaction(() => {
        const repository = new JellyfinActivationOperationRepository(
          this.#database.sqlite,
          this.#config.encryptionKey,
        );
        const operation = repository.read(operationId);
        const invitation = operation
          ? (this.#database.sqlite
              .prepare(
                `select activation_operation_id as activationOperationId, consumed_at as consumedAt,
                        revoked_at as revokedAt from invitations where id = ?`,
              )
              .get(operation.invitationId) as
              | {
                  activationOperationId: string | null;
                  consumedAt: number | null;
                  revokedAt: number | null;
                }
              | undefined)
          : undefined;
        const identity = operation
          ? (this.#database.sqlite
              .prepare("select user_id as userId from external_identities where id = ?")
              .get(operation.externalIdentityId) as { userId: string } | undefined)
          : undefined;
        const provisioning = operation
          ? (this.#database.sqlite
              .prepare(
                `select c.type, c.enabled, c.config_generation as configGeneration,
                        c.instance_generation as instanceGeneration,
                        c.instance_identity_hash as instanceIdentityHash,
                        p.revision as provisioningRevision
                 from connector_configs c join jellyfin_provisioning_configs p on p.connector_id = c.id
                 where c.id = ?`,
              )
              .get(operation.connectorId) as
              | {
                  configGeneration: number;
                  enabled: number;
                  instanceGeneration: number;
                  instanceIdentityHash: string | null;
                  provisioningRevision: number;
                  type: string;
                }
              | undefined)
          : undefined;
        const existingLink = operation
          ? this.#database.sqlite
              .prepare(
                "select id from service_identity_links where user_id = ? and service = 'jellyfin'",
              )
              .get(operation.userId)
          : undefined;
        if (
          !operation ||
          operation.state !== "auth_pending" ||
          operation.activationStatus !== "pending" ||
          !invitation ||
          invitation.activationOperationId !== operation.id ||
          invitation.consumedAt === null ||
          invitation.revokedAt !== null ||
          !identity ||
          identity.userId !== operation.userId ||
          existingLink ||
          !provisioning ||
          provisioning.type !== "jellyfin" ||
          provisioning.enabled !== 1 ||
          provisioning.configGeneration !== operation.connectorConfigGeneration ||
          provisioning.instanceGeneration !== operation.connectorInstanceGeneration ||
          provisioning.instanceIdentityHash !== operation.connectorInstanceIdentityHash ||
          provisioning.provisioningRevision !== operation.provisioningRevision
        )
          throw new Error("activation unavailable");
        const artifact = repository.readStageArtifact(operationId);
        if (
          typeof artifact.accessToken !== "string" ||
          artifact.accessToken.length === 0 ||
          typeof artifact.serverId !== "string" ||
          artifact.serverId.length === 0 ||
          typeof artifact.username !== "string" ||
          artifact.username.length === 0 ||
          Object.keys(artifact).some(
            (key) => !["createdId", "serverId", "username", "accessToken"].includes(key),
          )
        )
          throw new Error("activation artifact unavailable");
        if (
          pairing.userId !== operation.userId ||
          pairing.externalIdentityId !== operation.externalIdentityId
        )
          throw new Error("activation binding mismatch");
        const linkId = this.#createId();
        const encrypted = this.#cipher.encrypt(artifact.accessToken, accessTokenContext(linkId));
        const now = this.#clock();
        this.#database.sqlite
          .prepare(
            `insert into service_identity_links
        (id,user_id,service,connector_id,connector_instance_generation,external_server_id,external_user_id,
         external_username,external_display_name,encrypted_access_token,provisioned_by_activation_id,device_id,
         token_created_at,health_state,last_verified_at,revision,created_at,updated_at)
        values (?,?,'jellyfin',?,?,?,?,?,?,?,?,?,'linked',?,0,?,?)`,
          )
          .run(
            linkId,
            operation.userId,
            operation.connectorId,
            operation.connectorInstanceGeneration,
            artifact.serverId,
            artifact.createdId,
            artifact.username,
            artifact.username,
            encrypted,
            operation.id,
            "omnifin-activation-saga",
            now,
            now,
            now,
            now,
          );
        if (
          this.#database.sqlite
            .prepare(
              "update users set status = 'active', updated_at = ? where id = ? and status = 'pending_link'",
            )
            .run(now, operation.userId).changes !== 1
        )
          throw new Error("user finalization failed");
        const issued = this.#sessions.completeValidatedOidcPairingSession(pairing, linkId, input);
        repository.completeActivation({
          id: operation.id,
          linkId,
          now,
          expectedRevision: operation.revision,
        });
        return issued;
      })
      .immediate();
  }
}
