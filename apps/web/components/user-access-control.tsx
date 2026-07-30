"use client";

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Role, UserAccessSummary } from "@omnifin/contracts/auth";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  CircleAlert,
  Clock3,
  CloudOff,
  KeyRound,
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
import { useDeferredValue, useState, type ReactNode } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import {
  UserAccessAdminClientError,
  userAccessAdminClient,
  type UserAccessAdminClient,
  type UserAccessAdminLoadOutcome,
} from "../lib/user-access-admin";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";
import { LiquidGlassEnvironment } from "./liquid-glass-environment";
import styles from "./user-access-control.module.css";

const administrationQueryKey = ["user-access-administration"] as const;
const roles = ["viewer", "requester", "operator", "admin"] as const;
const roleDescriptions: Record<Role, string> = {
  admin: "Full identity, service, and policy control.",
  operator: "Manage requests, acquisition, downloads, and library care.",
  requester: "Browse, play, and submit new media requests.",
  viewer: "Browse and play within the paired Jellyfin permissions.",
};

export interface UserAccessControlProperties {
  client?: UserAccessAdminClient;
  displayProfile?: DisplayProfile;
  embedded?: boolean;
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

function AccessPageShell({
  children,
  displayProfile,
}: {
  children: ReactNode;
  displayProfile: DisplayProfile;
}) {
  return (
    <div className={styles.layout} data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <LiquidGlassEnvironment />
      <main className={styles.shell} id="main-content" tabIndex={-1}>
        <header className={styles.topbar}>
          <BrandMark />
          <Link className={styles.back} href="/settings">
            <ArrowLeft aria-hidden="true" size={17} /> Account &amp; access
          </Link>
        </header>
        <section className={styles.hero} aria-labelledby="user-access-title">
          <div>
            <p className="eyebrow">Access directory</p>
            <h1 id="user-access-title">Authority, without ambiguity.</h1>
            <p>
              See how every person enters Omnifin, where their role comes from, and what will happen
              before changing their access.
            </p>
          </div>
          <div className={styles.heroSeal} data-liquid-glass>
            <ShieldCheck aria-hidden="true" size={20} />
            <span>
              <strong>Least privilege</strong>
              <small>Every change closes active sessions</small>
            </span>
          </div>
        </section>
        {children}
      </main>
    </div>
  );
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
  initialOutcome,
}: {
  client: UserAccessAdminClient;
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
  const providerManaged = selected?.authenticationMethods.includes("oidc") ?? false;
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
  };

  const resetDraft = () => {
    setDraftRole(null);
    setDraftEnabled(null);
    setOperationError(null);
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
            ) : providerManaged ? (
              <div className={styles.contextNote}>
                <Sparkles aria-hidden="true" size={18} />
                <p>
                  This role comes from an OIDC claim mapping. Change the provider mapping to keep
                  identity policy deterministic; account suspension remains local.
                </p>
              </div>
            ) : null}

            <fieldset className={styles.roleFieldset} disabled={isSelf || mutation.isPending}>
              <legend>
                <span className="section-kicker">Omnifin role</span>
                <strong>Choose the narrowest useful authority.</strong>
              </legend>
              <div className={styles.roleGrid}>
                {roles.map((role) => (
                  <button
                    aria-pressed={nextRole === role}
                    className={styles.roleOption}
                    disabled={isSelf || providerManaged || mutation.isPending}
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
    </>
  );
}

export function UserAccessControl({
  client = userAccessAdminClient,
  displayProfile = "standard",
  embedded = false,
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
        {...(initialOutcome === undefined ? {} : { initialOutcome })}
      />
    </QueryClientProvider>
  );
  return embedded ? (
    administration
  ) : (
    <AccessPageShell displayProfile={displayProfile}>{administration}</AccessPageShell>
  );
}
