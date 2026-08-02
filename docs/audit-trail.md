# Operator audit trail

Omnifin records security-relevant and operational actions in the gateway database. An active
administrator can review the normalized record from **Account & access → Operator audit trail** or
the command palette. Recovery sessions cannot open the trail: break-glass access is intentionally
limited to repairing identity and session configuration, and its own attempts remain visible to a
later ordinary administrator.

The trail is an investigation aid, not a replacement for reverse-proxy, container-runtime, host,
or upstream-service logs. Correlate those sources privately when investigating a wider incident.

## What the browser receives

`GET /v1/admin/audit-events` returns only:

- a deployment-local opaque event reference;
- a normalized category and bounded event type;
- success, denied, or failed outcome;
- occurrence time; and
- a safe actor summary: current user display name, removed account, recovery access, or Omnifin.

The response never includes audit metadata, targets, upstream or connector identifiers, request or
session identifiers, OIDC subjects or assertions, IP hashes, filesystem paths, connector addresses,
credentials, cookies, CSRF values, or raw exceptions. Responses use `Cache-Control: no-store` and
the browser does not persist pages or cursors.

Display names are the only user-authored audit value rendered by this surface. Control characters
are removed and the value is length-bounded before it enters the public response. Event titles are
derived from the bounded event type, not private metadata.

## Authorization and recovery behavior

The route and audit service independently require all of the following:

1. an active local account;
2. the `audit.view` permission; and
3. a normal OIDC or Jellyfin-backed session.

The initial `admin` role includes `audit.view`. Viewers, requesters, operators without the named
permission, signed-out clients, suspended accounts, and recovery sessions fail before records are
read. The account page and command palette apply the same visibility rule, but the gateway remains
the authority.

If OIDC is unavailable, an administrator may use their normal linked Jellyfin sign-in to inspect the
record. The hidden recovery route can repair identity configuration, but it cannot read audit
history.

## Pagination and filters

Pages contain 25 events by default and never more than 50. Results are newest first. Category and
outcome filters are applied by the database before the page boundary.

Continuation cursors are authenticated-encrypted with the deployment master key. A cursor binds the
page size, category, outcome, initial database boundary, and snapshot time. Reusing it with another
filter or another deployment returns `audit_cursor_invalid`. Events written after the first page do
not reshuffle that active view; start a new view to include them.

The interface keeps already verified events visible when an earlier page fails and offers a bounded
retry. It distinguishes an empty database from a filter with no matches, announces appended pages to
assistive technology, and deliberately covers signed-out, forbidden, storage-unavailable, loading,
light, dark, system-theme, reduced-motion, mobile, tablet, desktop, and ten-foot layouts.

## Retention, backup, and restore

Audit events currently share the SQLite database lifecycle; Omnifin does not silently age them out
or expose a browser deletion control. Capacity planning should include this history. The verified
backup workflow preserves audit records, and a restore returns them to the selected recovery point.

Backups remain sensitive because they contain the complete private audit rows plus other encrypted
configuration. Follow the [backup and restore runbook](operations/backup-and-restore.md), keep the
matching encryption key separately protected, and never attach a database or backup manifest to a
public issue.

## Failure and troubleshooting reference

| Symptom             | Meaning                                                                     | Operator action                                                          |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Sign-in prompt      | No active local session                                                     | Sign in with configured OIDC or Jellyfin.                                |
| Restricted view     | The current session lacks ordinary `audit.view` authority                   | Use a normal administrator session; do not broaden recovery permissions. |
| Temporarily offline | Storage, integrity validation, or gateway access failed                     | Check private gateway readiness and SQLite health, then retry.           |
| Invalid cursor      | The cursor is malformed, from another deployment, or bound to other filters | Refresh the page and begin a new snapshot.                               |
| Earlier page failed | The current page remains valid but pagination failed                        | Restore gateway/storage health and use **Retry earlier events**.         |

For a storage failure, run the read-only [deployment doctor](operations/deployment-doctor.md) and
inspect private gateway logs using a local correlation window. Public support reports should include
only the stable error code, Omnifin version or image digest, and reproduction steps—not database rows,
cookies, request headers, or backup files.

## API example

The web application uses the same-origin `/api/admin/audit-events` proxy. Direct gateway access stays
private to the Compose network.

```http
GET /v1/admin/audit-events?category=authentication&outcome=denied&limit=25
```

A successful response conforms to `@omnifin/contracts/audit`. Error responses use the stable codes
`authentication_required`, `permission_denied`, `audit_cursor_invalid`, or
`audit_trail_unavailable`; none includes the underlying database or private event detail.
