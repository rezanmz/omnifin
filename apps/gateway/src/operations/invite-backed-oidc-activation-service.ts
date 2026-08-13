import { randomUUID } from "node:crypto";
import type { VerifiedOidcGrant } from "../auth/oidc/protocol.js";
import type { OidcIdentityService } from "../auth/oidc/identity-service.js";
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
  /** @internal Test-only lifecycle hook for changing persisted state after saga return. */
  afterSagaReturn?: () => void;
  createId?: () => string;
  finalizationFailpoint?: (
    stage:
      | "before_link"
      | "after_link_insert"
      | "after_user_activation"
      | "after_session_replacement"
      | "after_operation_completion",
  ) => void;
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
    sessions: SessionService,
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
             where i.id = ? and i.activation_operation_id = o.id
               and o.invitation_claimed_at = i.consumed_at
               and i.revoked_at is null and i.expires_at > ${now}`,
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
        const invitation = this.#database.sqlite
          .prepare(
            `select consumed_at as consumedAt, expires_at as expiresAt, revoked_at as revokedAt
             from invitations where id = ?`,
          )
          .get(input.invitationId) as
          { consumedAt: number | null; expiresAt: number; revokedAt: number | null } | undefined;
        if (
          !invitation ||
          invitation.consumedAt === null ||
          invitation.revokedAt !== null ||
          invitation.consumedAt >= invitation.expiresAt ||
          now >= invitation.expiresAt
        )
          throw new Error("activation invitation binding unavailable");
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
          invitationClaimedAt: invitation.consumedAt,
          pendingOidcSessionId: pairing.sessionId,
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
    this.#dependencies.afterSagaReturn?.();
    if (saga.disposition !== "activated_ready")
      return internalResult("pending_link", pendingSession, saga);
    try {
      const issued = this.#finalize(operationId, pairing, input);
      return internalResult("active", issued, saga);
    } catch {
      return internalResult("pending_link", pendingSession, saga);
    }
  }

  public async resume(input: {
    grant: VerifiedOidcGrant;
    activationOperationId: string;
    pendingOidcSessionId: string;
    ipAddress?: string;
    requestId?: string;
    userAgent?: string;
  }) {
    const resolved = this.#database.sqlite
      .transaction(() => {
        const repository = new JellyfinActivationOperationRepository(
          this.#database.sqlite,
          this.#config.encryptionKey,
        );
        const operation = repository.read(input.activationOperationId);
        if (
          !operation ||
          operation.pendingOidcSessionId !== input.pendingOidcSessionId ||
          operation.state !== "auth_pending" ||
          operation.activationStatus !== "pending"
        )
          return null;
        const identity = this.#identity.verifyExistingIdentityInExistingTransaction(input.grant);
        if (
          !identity ||
          identity.userId !== operation.userId ||
          identity.externalIdentityId !== operation.externalIdentityId
        )
          return null;
        const pairing = this.#sessions.resumeValidatedOidcPairingSessionById(
          input.pendingOidcSessionId,
          operation.userId,
          operation.externalIdentityId,
          identity.providerId,
          operation.pendingOidcSessionId,
        );
        return pairing ? { operationId: operation.id, pairing } : null;
      })
      .immediate();
    if (!resolved) return null;
    const saga = await this.#saga.run(resolved.operationId);
    this.#dependencies.afterSagaReturn?.();
    if (saga.disposition !== "activated_ready") return null;
    try {
      return internalResult(
        "active",
        this.#finalize(resolved.operationId, resolved.pairing, input),
        saga,
      );
    } catch {
      return null;
    }
  }

  public resumeCandidate(sessionToken: unknown, providerId: string) {
    const session = this.#sessions.resolveIssuedOidcPairingSessionForProvider(
      sessionToken,
      providerId,
    );
    if (!session) return null;
    const rows = this.#database.sqlite
      .prepare(
        `select o.id as operationId, o.user_id as userId, o.external_identity_id as externalIdentityId,
                o.pending_oidc_session_id as pendingOidcSessionId
         from jellyfin_activation_operations o
         where o.state = 'auth_pending' and o.activation_status = 'pending'
           and o.pending_oidc_session_id = ?
           and o.user_id = ?
           and o.external_identity_id = ?
           and exists (select 1 from invitations i where i.id = o.invitation_id
                       and i.activation_operation_id = o.id and i.revoked_at is null
                       and i.consumed_at = o.invitation_claimed_at and i.expires_at > ?)
           and o.id = o.id`,
      )
      .all(session.sessionId, session.userId, session.externalIdentityId, this.#clock()) as Array<{
      operationId: string;
      userId: string;
      externalIdentityId: string;
      pendingOidcSessionId: string;
    }>;
    return rows.length === 1 ? rows[0] : null;
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
        const now = this.#clock();
        const repository = new JellyfinActivationOperationRepository(
          this.#database.sqlite,
          this.#config.encryptionKey,
        );
        const operation = repository.read(operationId);
        const invitation = operation
          ? (this.#database.sqlite
              .prepare(
                `select activation_operation_id as activationOperationId, consumed_at as consumedAt,
                        expires_at as expiresAt, revoked_at as revokedAt from invitations where id = ?`,
              )
              .get(operation.invitationId) as
              | {
                  activationOperationId: string | null;
                  consumedAt: number | null;
                  expiresAt: number;
                  revokedAt: number | null;
                }
              | undefined)
          : undefined;
        const identity = operation
          ? (this.#database.sqlite
              .prepare(
                "select user_id as userId, provider_id as providerId from external_identities where id = ?",
              )
              .get(operation.externalIdentityId) as
              { providerId: string; userId: string } | undefined)
          : undefined;
        const provider = identity
          ? (this.#database.sqlite
              .prepare(
                `select id, enabled, issuer, client_id as clientId, discovery_state as discoveryState,
                        discovery_checked_at as discoveryCheckedAt, discovery_capabilities_json as discoveryCapabilitiesJson
                 from oidc_providers where id = ?`,
              )
              .get(identity.providerId) as
              | {
                  clientId: string;
                  discoveryCapabilitiesJson: string;
                  discoveryCheckedAt: number | null;
                  discoveryState: string;
                  enabled: number;
                  id: string;
                  issuer: string;
                }
              | undefined)
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
          operation.invitationClaimedAt === null ||
          invitation.consumedAt !== operation.invitationClaimedAt ||
          now >= invitation.expiresAt ||
          operation.invitationClaimedAt >= invitation.expiresAt ||
          invitation.revokedAt !== null ||
          !identity ||
          identity.userId !== operation.userId ||
          pairing.oidcProviderId !== identity.providerId ||
          !provider ||
          provider.id !== identity.providerId ||
          provider.enabled !== 1 ||
          provider.discoveryState !== "ready" ||
          provider.discoveryCheckedAt === null ||
          provider.issuer.length === 0 ||
          provider.clientId.length === 0 ||
          provider.discoveryCapabilitiesJson === "{}" ||
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
        this.#dependencies.finalizationFailpoint?.("before_link");
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
          pairing.externalIdentityId !== operation.externalIdentityId ||
          pairing.sessionId !== operation.pendingOidcSessionId
        )
          throw new Error("activation binding mismatch");
        const livePairing = this.#sessions.resumeValidatedOidcPairingSessionById(
          pairing.sessionId,
          operation.userId,
          operation.externalIdentityId,
          identity.providerId,
          operation.pendingOidcSessionId,
        );
        if (!livePairing || livePairing.serviceIdentityLinkId !== null)
          throw new Error("activation session unavailable");
        const linkId = this.#createId();
        const encrypted = this.#cipher.encrypt(artifact.accessToken, accessTokenContext(linkId));
        this.#database.sqlite
          .prepare(
            `insert into service_identity_links
        (id,user_id,service,connector_id,connector_instance_generation,external_server_id,external_user_id,
         external_username,external_display_name,encrypted_access_token,provisioned_by_activation_id,device_id,
         token_created_at,health_state,last_verified_at,revision,created_at,updated_at)
        values (?, ?, 'jellyfin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, 0, ?, ?)`,
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
        this.#dependencies.finalizationFailpoint?.("after_link_insert");
        if (
          this.#database.sqlite
            .prepare(
              "update users set status = 'active', updated_at = ? where id = ? and status = 'pending_link'",
            )
            .run(now, operation.userId).changes !== 1
        )
          throw new Error("user finalization failed");
        this.#dependencies.finalizationFailpoint?.("after_user_activation");
        const issued = this.#sessions.completeValidatedOidcPairingSession(
          livePairing,
          linkId,
          input,
        );
        this.#dependencies.finalizationFailpoint?.("after_session_replacement");
        repository.completeActivation({
          id: operation.id,
          linkId,
          now,
          expectedRevision: operation.revision,
        });
        this.#dependencies.finalizationFailpoint?.("after_operation_completion");
        return issued;
      })
      .immediate();
  }
}
