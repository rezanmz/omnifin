import type { SessionPrincipal } from "@omnifin/contracts/auth";
import {
  playbackIssueCreateRequestSchema,
  playbackIssueIdSchema,
  playbackIssueSchema,
  type PlaybackIssue,
  type PlaybackIssueCreateRequest,
} from "@omnifin/contracts/issues";
import { playbackSessionIdSchema } from "@omnifin/contracts/playback";
import { randomUUID } from "node:crypto";

import { requirePermission } from "../auth/authorization.js";
import type { AppConfig } from "../config.js";
import type { DatabaseHandle } from "../db/client.js";
import { EnvelopeCipher, privacyHash, randomToken } from "../security/crypto.js";

const MAX_OPEN_ISSUES_PER_USER = 100;
const MAX_ID_ATTEMPTS = 8;

interface PlaybackIssueSourceRow {
  expiresAt: number;
  mediaReferenceId: string;
  serviceIdentityLinkId: string;
  state: string;
}

export interface PlaybackIssueContext {
  ipAddress?: string;
  principal: SessionPrincipal;
  requestId?: string;
}

export interface PlaybackIssueDependencies {
  clock?: () => Date;
  createAuditId?: () => string;
  createToken?: () => string;
}

export type PlaybackIssueErrorReason =
  "integrity_failure" | "limit_reached" | "not_found" | "storage_failure";

export class PlaybackIssueError extends Error {
  public readonly reason: PlaybackIssueErrorReason;

  public constructor(reason: PlaybackIssueErrorReason, options?: ErrorOptions) {
    super(
      reason === "not_found"
        ? "The playback session is no longer available."
        : reason === "limit_reached"
          ? "Resolve an existing issue before reporting another one."
          : "The playback issue could not be recorded.",
      options,
    );
    this.name = "PlaybackIssueError";
    this.reason = reason;
  }
}

function descriptionContext(issueId: string) {
  return `media_issue_description:${issueId}`;
}

export class PlaybackIssueService {
  readonly #cipher: EnvelopeCipher;
  readonly #clock: () => Date;
  readonly #config: AppConfig;
  readonly #createAuditId: () => string;
  readonly #createToken: () => string;
  readonly #database: DatabaseHandle;

  public constructor(
    database: DatabaseHandle,
    config: AppConfig,
    dependencies: PlaybackIssueDependencies = {},
  ) {
    this.#database = database;
    this.#config = config;
    this.#cipher = new EnvelopeCipher(config.encryptionKey);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createAuditId = dependencies.createAuditId ?? randomUUID;
    this.#createToken = dependencies.createToken ?? (() => randomToken(16));
  }

  public create(
    context: PlaybackIssueContext,
    rawSessionId: string,
    rawRequest: PlaybackIssueCreateRequest,
  ): PlaybackIssue {
    const principal = requirePermission(context.principal, "playback.use");
    const sessionId = playbackSessionIdSchema.parse(rawSessionId);
    const request = playbackIssueCreateRequestSchema.parse(rawRequest);
    if (principal.accountState !== "active" || !principal.userId) {
      throw new PlaybackIssueError("not_found");
    }
    const now = this.#now();

    try {
      return this.#database.sqlite.transaction(() => {
        const source = this.#database.sqlite
          .prepare(
            `select
               expires_at as expiresAt,
               media_reference_id as mediaReferenceId,
               service_identity_link_id as serviceIdentityLinkId,
               state
             from playback_sessions
             where id = ? and user_id = ? and expires_at > ?
             limit 1`,
          )
          .get(sessionId, principal.userId, now) as PlaybackIssueSourceRow | undefined;
        if (!source || !["negotiated", "playing", "paused", "stopped"].includes(source.state)) {
          throw new PlaybackIssueError("not_found");
        }
        const principalLink = principal.linkedServices.find(
          (link) =>
            link.id === source.serviceIdentityLinkId &&
            link.service === "jellyfin" &&
            ["linked", "unavailable"].includes(link.health),
        );
        if (!principalLink) throw new PlaybackIssueError("not_found");

        const openCount = this.#database.sqlite
          .prepare(
            "select count(*) as count from media_issues where user_id = ? and state = 'open'",
          )
          .get(principal.userId) as { count: number };
        if (openCount.count >= MAX_OPEN_ISSUES_PER_USER) {
          throw new PlaybackIssueError("limit_reached");
        }

        let issueId: string | undefined;
        for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
          const candidate = playbackIssueIdSchema.safeParse(`issue_${this.#createToken()}`);
          if (!candidate.success) throw new PlaybackIssueError("integrity_failure");
          const existing =
            this.#database.sqlite
              .prepare("select 1 from media_issues where id = ? limit 1")
              .get(candidate.data) ??
            this.#database.sqlite
              .prepare("select 1 from external_issue_references where id = ? limit 1")
              .get(candidate.data);
          if (!existing) {
            issueId = candidate.data;
            break;
          }
        }
        if (!issueId) throw new PlaybackIssueError("integrity_failure");

        const positionSeconds = request.positionSeconds;
        const encryptedDescription = request.description
          ? this.#cipher.encrypt(request.description, descriptionContext(issueId))
          : null;
        this.#database.sqlite
          .prepare(
            `insert into media_issues (
               id, user_id, service_identity_link_id, media_reference_id,
               playback_session_id, category, encrypted_description,
               position_seconds, state, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(
            issueId,
            principal.userId,
            source.serviceIdentityLinkId,
            source.mediaReferenceId,
            sessionId,
            request.category,
            encryptedDescription,
            positionSeconds,
            now,
            now,
          );

        this.#database.sqlite
          .prepare(
            `insert into audit_events (
               id, actor_user_id, actor_session_id, actor_auth_method,
               event_type, outcome, target_type, target_id, request_id,
               metadata_json, ip_hash, created_at
             ) values (?, ?, ?, ?, 'media.issue.created', 'success', 'media_issue', ?, ?, ?, ?, ?)`,
          )
          .run(
            this.#auditId(),
            principal.userId,
            principal.sessionId,
            principal.authenticationMethod.kind,
            issueId,
            context.requestId ?? null,
            JSON.stringify({
              category: request.category,
              mediaReferenceId: source.mediaReferenceId,
              positionSeconds,
            }),
            context.ipAddress
              ? privacyHash("ip_address", context.ipAddress, this.#config.encryptionKey)
              : null,
            now,
          );

        return playbackIssueSchema.parse({
          category: request.category,
          createdAt: new Date(now).toISOString(),
          id: issueId,
          positionSeconds,
          status: "open",
        });
      })();
    } catch (error) {
      if (error instanceof PlaybackIssueError) throw error;
      throw new PlaybackIssueError("storage_failure", { cause: error });
    }
  }

  #auditId() {
    const value = this.#createAuditId();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(value)) {
      throw new PlaybackIssueError("integrity_failure");
    }
    return value;
  }

  #now() {
    const value = this.#clock().getTime();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new PlaybackIssueError("integrity_failure");
    }
    return value;
  }
}
