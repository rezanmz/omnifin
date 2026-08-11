"use client";

import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Role, UserAccessSummary } from "@omnifin/contracts/auth";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  Check,
  CircleAlert,
  Copy,
  Clock3,
  CloudOff,
  KeyRound,
  Link2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  UsersRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import {
  UserAccessAdminClientError,
  userAccessAdminClient,
  type UserAccessAdminClient,
  type UserAccessAdminLoadOutcome,
} from "../lib/user-access-admin";
import {
  inviteAdminClient,
  type AdminInvite,
  type CreatedAdminInvite,
  type InviteAdminClient,
  type InviteLifetime,
  type InviteLoadOutcome,
} from "../lib/invite-admin";
import styles from "./user-access-control.module.css";
import { UserAccessPageShell } from "./user-access-page-shell";
import { UserRoleAssignmentWizard } from "./user-role-assignment-wizard";

const administrationQueryKey = ["user-access-administration"] as const;
const roles = ["viewer", "requester", "operator", "admin"] as const;
const roleDescriptions: Record<Role, string> = {
  admin: "Full identity, service, and policy control.",
  operator: "Manage requests, acquisition, downloads, and library care.",
  requester: "Browse, play, and submit new media requests.",
  viewer: "Browse and play within the paired Jellyfin permissions.",
};

function inviteDate(value: string | null) {
  if (!value) return "No expiry";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Expiry unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function inviteStatus(invite: AdminInvite) {
  return invite.status.charAt(0).toUpperCase() + invite.status.slice(1);
}

function InviteManagement({
  client,
  initialOutcome,
}: {
  client: InviteAdminClient;
  initialOutcome?: InviteLoadOutcome;
}) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    ...(initialOutcome === undefined
      ? {}
      : { initialData: { pages: [initialOutcome], pageParams: [null] } }),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => client.load(pageParam),
    queryKey: ["admin-invites"],
    getNextPageParam: (lastPage) => (lastPage.status === "ready" ? lastPage.nextCursor : undefined),
    retry: false,
    staleTime: initialOutcome ? Number.POSITIVE_INFINITY : 30_000,
  });
  const firstPage = query.data?.pages[0];
  const invites =
    query.data?.pages.flatMap((page) => (page.status === "ready" ? page.invites : [])) ?? [];
  const [expiry, setExpiry] = useState("604800");
  const [created, setCreated] = useState<CreatedAdminInvite | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createMutation = useMutation({
    mutationFn: () => {
      if (firstPage?.status !== "ready") throw new Error("The invitation service is not ready.");
      return client.create(Number(expiry) as InviteLifetime, firstPage.csrfToken);
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => {
      if (firstPage?.status !== "ready") throw new Error("The invitation service is not ready.");
      return client.revoke(id, firstPage.csrfToken);
    },
  });

  const create = async () => {
    setError(null);
    try {
      const invite = await createMutation.mutateAsync();
      setCreated(invite);
      setMessage("Invitation created. Copy the link now — it cannot be recovered later.");
      await queryClient.invalidateQueries({ queryKey: ["admin-invites"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The invitation could not be created.");
    }
  };
  const revoke = async () => {
    if (!revokeId) return;
    setError(null);
    try {
      await revokeMutation.mutateAsync(revokeId);
      setRevokeId(null);
      setMessage("Invitation revoked. Its link will no longer work.");
      await queryClient.invalidateQueries({ queryKey: ["admin-invites"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The invitation could not be revoked.");
    }
  };

  return (
    <section className={styles.invitePanel} aria-labelledby="invite-management-title">
      <header className={styles.inviteHeader}>
        <div>
          <p className="section-kicker">Controlled entry</p>
          <h2 id="invite-management-title">Invitations</h2>
          <p>Create a single-use link for someone new to join this Omnifin instance.</p>
        </div>
        <div className={styles.inviteCreate}>
          <label htmlFor="invite-expiry">Lifetime</label>
          <select
            id="invite-expiry"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          >
            <option value="3600">1 hour</option>
            <option value="86400">24 hours</option>
            <option value="604800">7 days</option>
            <option value="2592000">30 days</option>
          </select>
          <button
            className={styles.primaryButton}
            disabled={createMutation.isPending || firstPage?.status !== "ready"}
            onClick={() => void create()}
            type="button"
          >
            {createMutation.isPending ? (
              <LoaderCircle className={styles.spinner} aria-hidden="true" size={16} />
            ) : (
              <Link2 aria-hidden="true" size={16} />
            )}
            Create invite
          </button>
        </div>
      </header>
      <div className={styles.announcer} aria-live="polite" aria-atomic="true">
        {message ?? error ?? ""}
      </div>
      {message ? (
        <div className={styles.inviteNotice} role="status">
          <BadgeCheck aria-hidden="true" size={17} />
          <span>{message}</span>
          <button aria-label="Dismiss notification" onClick={() => setMessage(null)} type="button">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {error ? (
        <div className={styles.inviteError} role="alert">
          <CircleAlert aria-hidden="true" size={17} />
          <span>{error}</span>
          <button
            className={styles.secondaryButton}
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}

      {query.isPending ? (
        <div className={styles.inviteLoading} aria-busy="true" role="status">
          Loading invitations…
        </div>
      ) : firstPage?.status !== "ready" ? (
        <div className={styles.inviteState} role="alert">
          <CircleAlert aria-hidden="true" size={20} />
          <div>
            <strong>
              {firstPage?.status === "forbidden"
                ? "Invitation management is restricted."
                : firstPage?.status === "signed_out"
                  ? "Your administrative session ended."
                  : "Invitations are temporarily offline."}
            </strong>
            <p>No invitation was changed.</p>
          </div>
          <button
            className={styles.secondaryButton}
            onClick={() => void query.refetch()}
            type="button"
          >
            Reload
          </button>
        </div>
      ) : invites.length === 0 ? (
        <div className={styles.inviteEmpty} role="status">
          <CalendarClock aria-hidden="true" size={26} />
          <strong>No invitations yet</strong>
          <span>Create a link when you are ready to add someone.</span>
        </div>
      ) : (
        <div className={styles.inviteTableWrap}>
          <table className={styles.inviteTable}>
            <caption className="sr-only">Invitation lifecycle</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Lifetime</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id}>
                  <td>
                    <span className={styles.inviteStatus} data-status={invite.status}>
                      <span aria-hidden="true" />
                      {inviteStatus(invite)}
                    </span>
                  </td>
                  <td>{inviteDate(invite.createdAt)}</td>
                  <td>
                    {invite.status === "active"
                      ? `Expires ${inviteDate(invite.expiresAt)}`
                      : invite.status === "consumed"
                        ? "Used once"
                        : invite.status === "revoked"
                          ? "Revoked"
                          : "Expired"}
                  </td>
                  <td>
                    {invite.status === "active" ? (
                      <button
                        className={styles.textButton}
                        onClick={() => setRevokeId(invite.id)}
                        type="button"
                      >
                        Revoke
                      </button>
                    ) : (
                      <span className={styles.muted}>Closed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.hasNextPage ? (
            <button
              className={styles.secondaryButton}
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              type="button"
            >
              {query.isFetchingNextPage ? "Loading more invitations…" : "Load more invitations"}
            </button>
          ) : null}
        </div>
      )}
      {created ? (
        <div
          className={styles.reveal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-link-title"
        >
          <div className={styles.revealHeading}>
            <Link2 aria-hidden="true" size={20} />
            <div>
              <h3 id="invite-link-title">Your one-time invitation link</h3>
              <p>Copy it now. For your security, Omnifin will not show this link again.</p>
            </div>
          </div>
          <div className={styles.linkRow}>
            <code>{created.invitationUrl}</code>
            <button
              className={styles.secondaryButton}
              onClick={() => {
                void navigator.clipboard.writeText(created.invitationUrl);
                setMessage("Invitation link copied.");
              }}
              type="button"
            >
              <Copy aria-hidden="true" size={16} /> Copy link
            </button>
          </div>
          <button className={styles.textButton} onClick={() => setCreated(null)} type="button">
            I’ve copied the link
          </button>
        </div>
      ) : null}
      {revokeId ? (
        <div className={styles.confirmBackdrop}>
          <section
            className={styles.confirm}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="revoke-title"
            aria-describedby="revoke-copy"
          >
            <h3 id="revoke-title">Revoke this invitation?</h3>
            <p id="revoke-copy">
              Anyone with this link will lose access to the invitation. This cannot be undone.
            </p>
            <div>
              <button
                className={styles.secondaryButton}
                disabled={revokeMutation.isPending}
                onClick={() => setRevokeId(null)}
                type="button"
              >
                Keep invite
              </button>
              <button
                className={styles.dangerButton}
                disabled={revokeMutation.isPending}
                onClick={() => void revoke()}
                type="button"
              >
                {revokeMutation.isPending ? "Revoking…" : "Revoke invitation"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export interface UserAccessControlProperties {
  client?: UserAccessAdminClient;
  inviteClient?: InviteAdminClient;
  displayProfile?: DisplayProfile;
  embedded?: boolean;
  initialInviteOutcome?: InviteLoadOutcome;
  initialOutcome?: UserAccessAdminLoadOutcome;
}

function initials(displayName: string) {
  return displayName
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatActivity(value: string | null) {
  if (value === null) return "Never signed in";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "Activity unavailable";
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const hour = time.getUTCHours();
  return `${months[time.getUTCMonth()]} ${time.getUTCDate()}, ${time.getUTCFullYear()}, ${hour % 12 || 12}:${String(time.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"} UTC`;
}

function statusLabel(user: UserAccessSummary) {
  if (user.status === "disabled") return "Suspended";
  if (user.status === "pending_link") return "Pairing needed";
  if (user.jellyfinLinkHealth === "unavailable") return "Jellyfin offline";
  if (user.jellyfinLinkHealth === "relink_required") return "Relink needed";
  return "Active";
}

function sourceLabel(user: UserAccessSummary) {
  if (user.authenticationMethods.includes("oidc")) return "Provider managed";
  if (user.roleSource === "manual") return "Locally assigned";
  if (user.roleSource === "recovery_bootstrap") return "Bootstrap authority";
  return "Default access";
}

function userFacingError(error: unknown) {
  if (error instanceof UserAccessAdminClientError) return error.message;
  return "The account change could not be completed. No access was changed.";
}

function StatePanel({
  kind,
  onRetry,
}: {
  kind: "forbidden" | "signed_out" | "unavailable";
  onRetry: () => void;
}) {
  const content = {
    forbidden: {
      detail: "An active administrator is required. Recovery access cannot inspect user accounts.",
      icon: LockKeyhole,
      title: "This directory is restricted.",
    },
    signed_out: {
      detail: "Sign in again before reviewing or changing account authority.",
      icon: KeyRound,
      title: "Your administrative session ended.",
    },
    unavailable: {
      detail: "No access was changed. Restore the gateway connection, then try again.",
      icon: CloudOff,
      title: "The access directory is temporarily offline.",
    },
  }[kind];
  const Icon = content.icon;
  return (
    <section
      className={styles.statePanel}
      data-liquid-glass
      role={kind === "signed_out" ? "status" : "alert"}
    >
      <Icon aria-hidden="true" size={30} />
      <div>
        <h2>{content.title}</h2>
        <p>{content.detail}</p>
      </div>
      {kind === "signed_out" ? (
        <Link className={styles.primaryButton} href="/login">
          Return to sign in <ArrowRight aria-hidden="true" size={16} />
        </Link>
      ) : kind === "unavailable" ? (
        <button className={styles.secondaryButton} onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" size={16} /> Try again
        </button>
      ) : (
        <Link className={styles.secondaryButton} href="/settings">
          Back to account
        </Link>
      )}
    </section>
  );
}

function UserAccessControlContent({
  client,
  inviteClient,
  initialInviteOutcome,
  initialOutcome,
}: {
  client: UserAccessAdminClient;
  inviteClient: InviteAdminClient;
  initialInviteOutcome?: InviteLoadOutcome;
  initialOutcome?: UserAccessAdminLoadOutcome;
}) {
  const queryClient = useQueryClient();
  const outcomeQuery = useQuery({
    initialData: initialOutcome,
    queryFn: client.load,
    queryKey: administrationQueryKey,
    retry: false,
    staleTime: initialOutcome ? Number.POSITIVE_INFINITY : 30_000,
  });
  const mutation = useMutation({
    mutationFn: (action: () => Promise<void>) => action(),
  });
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialOutcome?.status === "ready" ? (initialOutcome.snapshot.users[0]?.id ?? null) : null,
  );
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [draftRole, setDraftRole] = useState<Role | null>(null);
  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [assignmentOpen, setAssignmentOpen] = useState(false);

  if (outcomeQuery.isPending) {
    return (
      <section
        aria-busy="true"
        aria-label="Loading user access administration"
        className={styles.console}
      >
        <div className={`${styles.userRail} ${styles.skeleton}`} />
        <div className={`${styles.workspace} ${styles.skeleton}`} />
      </section>
    );
  }

  const outcome = outcomeQuery.data;
  if (outcome?.status !== "ready") {
    return (
      <StatePanel
        kind={outcome?.status ?? "unavailable"}
        onRetry={() => void outcomeQuery.refetch()}
      />
    );
  }

  const { snapshot } = outcome;
  const users = snapshot.users;
  const visibleUsers = deferredQuery
    ? users.filter((user) =>
        [user.displayName, user.role, statusLabel(user), ...user.authenticationMethods]
          .join(" ")
          .toLocaleLowerCase()
          .includes(deferredQuery),
      )
    : users;
  const selected = users.find((user) => user.id === selectedId) ?? users[0] ?? null;
  const nextRole = draftRole ?? selected?.role ?? "viewer";
  const currentEnabled = selected?.status !== "disabled";
  const nextEnabled = draftEnabled ?? currentEnabled;
  const roleChanged = selected !== null && nextRole !== selected.role;
  const stateChanged = selected !== null && nextEnabled !== currentEnabled;
  const hasDraft = roleChanged || stateChanged;
  const isSelf = selected?.id === snapshot.principal.userId;
  const oidcOwned = selected?.authenticationMethods.includes("oidc") ?? false;
  const assignmentEligible =
    oidcOwned && (selected?.roleSource === "default" || selected?.roleSource === "oidc_mapping");
  const statistics = {
    active: users.filter((user) => user.status === "active").length,
    administrators: users.filter((user) => user.role === "admin" && user.status === "active")
      .length,
    sessions: users.reduce((total, user) => total + user.activeSessions, 0),
  };

  const chooseUser = (userId: string) => {
    setSelectedId(userId);
    setDraftRole(null);
    setDraftEnabled(null);
    setOperationError(null);
    setAssignmentOpen(false);
  };

  const resetDraft = () => {
    setDraftRole(null);
    setDraftEnabled(null);
    setOperationError(null);
  };

  const assignOidcRole = async (role: Role) => {
    if (!selected || mutation.isPending) return;
    setOperationError(null);
    setNotice(null);
    try {
      await mutation.mutateAsync(async () => {
        await client.assignOidcRole(
          selected.id,
          { expectedUpdatedAt: selected.updatedAt, role },
          snapshot.csrfToken,
        );
        const refreshed = await client.load();
        if (refreshed.status === "signed_out" || refreshed.status === "forbidden") {
          queryClient.setQueryData(administrationQueryKey, refreshed);
          return;
        }
        if (refreshed.status !== "ready") {
          throw new UserAccessAdminClientError(
            "unavailable",
            "session_recheck_failed",
            "The provider role was submitted, but the session could not be rechecked. Reload the directory before continuing.",
          );
        }
        queryClient.setQueryData(administrationQueryKey, refreshed);
        setAssignmentOpen(false);
        setNotice(
          "Provider role assigned for the next OIDC sign-in. Affected provider-managed sessions may have been closed.",
        );
      });
    } catch (error) {
      setOperationError(userFacingError(error));
      if (error instanceof UserAccessAdminClientError && error.kind === "session_changed") {
        queryClient.setQueryData(administrationQueryKey, {
          status: error.code === "session_signed_out" ? "signed_out" : "forbidden",
        });
      }
    }
  };

  const apply = async () => {
    if (!selected || !hasDraft || mutation.isPending) return;
    setOperationError(null);
    setNotice(null);
    try {
      await mutation.mutateAsync(async () => {
        const result = await client.update(
          selected.id,
          {
            ...(stateChanged ? { enabled: nextEnabled } : {}),
            expectedUpdatedAt: selected.updatedAt,
            ...(roleChanged ? { role: nextRole } : {}),
          },
          snapshot.csrfToken,
        );
        queryClient.setQueryData<UserAccessAdminLoadOutcome>(administrationQueryKey, (current) =>
          current?.status === "ready"
            ? {
                ...current,
                snapshot: {
                  ...current.snapshot,
                  users: current.snapshot.users.map((user) =>
                    user.id === result.user.id ? result.user : user,
                  ),
                },
              }
            : current,
        );
        setDraftRole(null);
        setDraftEnabled(null);
        setNotice(
          `${result.user.displayName} was updated. ${result.revokedSessions} active session${result.revokedSessions === 1 ? "" : "s"} closed.`,
        );
      });
    } catch (error) {
      setOperationError(userFacingError(error));
      if (error instanceof UserAccessAdminClientError && error.kind === "session_changed") {
        queryClient.setQueryData(administrationQueryKey, {
          status: error.code === "session_signed_out" ? "signed_out" : "forbidden",
        });
      }
    }
  };

  if (users.length === 0) {
    return (
      <>
        <section className={styles.statePanel} data-liquid-glass role="status">
          <UsersRound aria-hidden="true" size={30} />
          <div>
            <h2>No user identities yet.</h2>
            <p>Accounts appear here after a successful Jellyfin or OIDC sign-in.</p>
          </div>
          <Link className={styles.secondaryButton} href="/settings/identity-providers">
            Review sign-in providers
          </Link>
        </section>
        <InviteManagement
          client={inviteClient}
          {...(initialInviteOutcome === undefined ? {} : { initialOutcome: initialInviteOutcome })}
        />
      </>
    );
  }

  return (
    <>
      <div className={styles.announcer} aria-atomic="true" aria-live="polite">
        {notice ?? operationError ?? ""}
      </div>
      <section className={styles.metrics} aria-label="Access overview">
        <div data-liquid-glass>
          <span>Active identities</span>
          <strong>{statistics.active}</strong>
        </div>
        <div data-liquid-glass>
          <span>Active administrators</span>
          <strong>{statistics.administrators}</strong>
        </div>
        <div data-liquid-glass>
          <span>Open sessions</span>
          <strong>{statistics.sessions}</strong>
        </div>
      </section>

      {notice ? (
        <div className={styles.notice} data-liquid-glass role="status">
          <BadgeCheck aria-hidden="true" size={18} />
          <p>{notice}</p>
          <button aria-label="Dismiss notification" onClick={() => setNotice(null)} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      ) : null}
      {operationError ? (
        <div className={styles.operationError} data-liquid-glass role="alert">
          <CircleAlert aria-hidden="true" size={18} />
          <p>{operationError}</p>
          <button onClick={() => void outcomeQuery.refetch()} type="button">
            Reload directory
          </button>
        </div>
      ) : null}

      <section className={styles.console} aria-label="User access administration">
        <aside className={styles.userRail} data-liquid-glass>
          <div className={styles.railHeading}>
            <div>
              <p className="section-kicker">People</p>
              <h2>{users.length} identities</h2>
            </div>
            <UsersRound aria-hidden="true" size={20} />
          </div>
          <label className={styles.searchBox}>
            <span className="sr-only">Search people</span>
            <Search aria-hidden="true" size={17} />
            <input
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people or roles"
              type="search"
              value={query}
            />
          </label>
          <div className={styles.userList}>
            {visibleUsers.length === 0 ? (
              <div className={styles.noResults} role="status">
                <Search aria-hidden="true" size={20} />
                <strong>No matching identities</strong>
                <span>Try a name, role, or sign-in method.</span>
              </div>
            ) : (
              visibleUsers.map((user) => (
                <button
                  aria-current={selected?.id === user.id ? "true" : undefined}
                  className={styles.userButton}
                  data-status={user.status}
                  key={user.id}
                  onClick={() => chooseUser(user.id)}
                  type="button"
                >
                  <span className={styles.avatar} aria-hidden="true">
                    {initials(user.displayName)}
                  </span>
                  <span className={styles.userButtonCopy}>
                    <strong>{user.displayName}</strong>
                    <small>
                      {user.role} · {statusLabel(user)}
                    </small>
                  </span>
                  <span
                    className={styles.methodMarks}
                    aria-label={`${user.authenticationMethods.join(" and ")} sign-in`}
                  >
                    {user.authenticationMethods.includes("oidc") ? "O" : ""}
                    {user.authenticationMethods.includes("jellyfin") ? "J" : ""}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {selected ? (
          <article className={styles.workspace} data-liquid-glass>
            <header className={styles.workspaceHeading}>
              <div className={styles.identityHeading}>
                <span className={styles.largeAvatar} aria-hidden="true">
                  {initials(selected.displayName)}
                </span>
                <div>
                  <p className="section-kicker">Identity profile</p>
                  <h2>{selected.displayName}</h2>
                  <p>{sourceLabel(selected)}</p>
                </div>
              </div>
              <span className={styles.statusBadge} data-status={selected.status}>
                <span aria-hidden="true" /> {statusLabel(selected)}
              </span>
            </header>

            <dl className={styles.facts}>
              <div>
                <dt>Sign-in</dt>
                <dd>{selected.authenticationMethods.join(" + ").toUpperCase()}</dd>
              </div>
              <div>
                <dt>Open sessions</dt>
                <dd>{selected.activeSessions}</dd>
              </div>
              <div>
                <dt>Last active</dt>
                <dd>{formatActivity(selected.lastActiveAt)}</dd>
              </div>
            </dl>

            {isSelf ? (
              <div className={styles.contextNote}>
                <UserRoundCheck aria-hidden="true" size={18} />
                <p>
                  This is your current identity. Self-service controls stay in Account &amp; access
                  so an administrator cannot accidentally remove their own authority here.
                </p>
              </div>
            ) : oidcOwned ? (
              <div className={styles.contextNote}>
                <Sparkles aria-hidden="true" size={18} />
                <p>
                  {assignmentEligible
                    ? selected.roleSource === "oidc_mapping"
                      ? "This role comes from an OIDC claim mapping. Change provider policy in Identity providers, or assign an individual provider fallback below."
                      : "This OIDC identity currently uses the default role. You can assign an individual provider fallback below."
                    : "This OIDC identity is governed by bootstrap authority. Individual provider role assignment is unavailable here."}
                </p>
                {assignmentEligible ? (
                  <button
                    className={styles.secondaryButton}
                    disabled={isSelf || mutation.isPending}
                    onClick={() => setAssignmentOpen(true)}
                    type="button"
                  >
                    Assign individual provider role
                  </button>
                ) : null}
              </div>
            ) : null}

            {assignmentOpen && assignmentEligible ? (
              <UserRoleAssignmentWizard
                busy={mutation.isPending}
                onCancel={() => setAssignmentOpen(false)}
                onSubmit={assignOidcRole}
                user={selected}
              />
            ) : null}

            <fieldset
              className={styles.roleFieldset}
              disabled={isSelf || oidcOwned || mutation.isPending}
            >
              <legend>
                <span className="section-kicker">Omnifin role</span>
                <strong>Choose the narrowest useful authority.</strong>
              </legend>
              <div className={styles.roleGrid}>
                {roles.map((role) => (
                  <button
                    aria-pressed={nextRole === role}
                    className={styles.roleOption}
                    disabled={isSelf || oidcOwned || mutation.isPending}
                    key={role}
                    onClick={() => setDraftRole(role)}
                    type="button"
                  >
                    <span>
                      <strong>{role}</strong>
                      {nextRole === role ? <Check aria-hidden="true" size={16} /> : null}
                    </span>
                    <small>{roleDescriptions[role]}</small>
                  </button>
                ))}
              </div>
            </fieldset>

            <section className={styles.accountState} aria-labelledby="account-state-title">
              <div>
                <p className="section-kicker">Account state</p>
                <h3 id="account-state-title">Local sign-in access</h3>
                <p>
                  Suspending this identity denies media operations and closes every Omnifin session.
                  Upstream Jellyfin and OIDC accounts are not modified.
                </p>
              </div>
              <button
                aria-pressed={nextEnabled}
                className={styles.stateToggle}
                data-enabled={nextEnabled}
                disabled={isSelf || mutation.isPending}
                onClick={() => setDraftEnabled(!nextEnabled)}
                type="button"
              >
                <span aria-hidden="true">
                  <span />
                </span>
                {nextEnabled ? "Access enabled" : "Access suspended"}
              </button>
            </section>

            {hasDraft ? (
              <div
                className={styles.reviewBar}
                data-liquid-glass
                role="region"
                aria-label="Review access change"
              >
                <div>
                  <Clock3 aria-hidden="true" size={19} />
                  <p>
                    <strong>Review before applying.</strong>
                    <span>
                      {roleChanged ? `${selected.role} → ${nextRole}. ` : ""}
                      {stateChanged
                        ? nextEnabled
                          ? "Local access will be restored. "
                          : "Local access will be suspended. "
                        : ""}
                      {selected.activeSessions} active session
                      {selected.activeSessions === 1 ? "" : "s"} will close.
                    </span>
                  </p>
                </div>
                <div>
                  <button
                    className={styles.secondaryButton}
                    disabled={mutation.isPending}
                    onClick={resetDraft}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className={styles.primaryButton}
                    disabled={mutation.isPending}
                    onClick={() => void apply()}
                    type="button"
                  >
                    {mutation.isPending ? (
                      <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
                    ) : (
                      <ShieldCheck aria-hidden="true" size={16} />
                    )}
                    Apply &amp; revoke sessions
                  </button>
                </div>
              </div>
            ) : null}
          </article>
        ) : null}
      </section>
      <InviteManagement
        client={inviteClient}
        {...(initialInviteOutcome === undefined ? {} : { initialOutcome: initialInviteOutcome })}
      />
    </>
  );
}

export function UserAccessControl({
  client = userAccessAdminClient,
  inviteClient = inviteAdminClient,
  displayProfile = "standard",
  embedded = false,
  initialInviteOutcome,
  initialOutcome,
}: UserAccessControlProperties) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          queries: { refetchOnWindowFocus: false, retry: false },
        },
      }),
  );
  const administration = (
    <QueryClientProvider client={queryClient}>
      <UserAccessControlContent
        client={client}
        inviteClient={inviteClient}
        {...(initialInviteOutcome === undefined ? {} : { initialInviteOutcome })}
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
      />
    </QueryClientProvider>
  );
  return embedded ? (
    administration
  ) : (
    <UserAccessPageShell displayProfile={displayProfile}>{administration}</UserAccessPageShell>
  );
}
