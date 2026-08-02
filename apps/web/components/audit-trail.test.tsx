import type { AuditEventListResponse } from "@omnifin/contracts/audit";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AuditTrailClient, AuditTrailLoadOutcome } from "../lib/audit-trail";
import { AuditTrail } from "./audit-trail";

const firstPage: AuditEventListResponse = {
  events: [
    {
      actor: { authenticationMethod: "jellyfin", displayName: "Administrator", kind: "user" },
      category: "configuration",
      eventType: "connector.configuration.updated",
      id: "audit_0123456789abcdefghijkl",
      occurredAt: "2026-08-02T13:58:00.000Z",
      outcome: "success",
    },
    {
      actor: { authenticationMethod: "recovery", displayName: "Recovery access", kind: "recovery" },
      category: "authentication",
      eventType: "auth.admin.bootstrap_attempt",
      id: "audit_123456789abcdefghijkl0",
      occurredAt: "2026-08-02T12:42:00.000Z",
      outcome: "denied",
    },
  ],
  generatedAt: "2026-08-02T14:00:00.000Z",
  nextCursor: `audit_cursor_v2.${"A".repeat(16)}.${"B".repeat(32)}.${"C".repeat(22)}`,
};
const secondPage: AuditEventListResponse = {
  events: [
    {
      actor: { authenticationMethod: null, displayName: "Omnifin", kind: "system" },
      category: "library",
      eventType: "library.scan.requested",
      id: "audit_23456789abcdefghijkl01",
      occurredAt: "2026-08-01T22:10:00.000Z",
      outcome: "success",
    },
  ],
  generatedAt: "2026-08-02T14:00:00.000Z",
  nextCursor: null,
};

function ready(page: AuditEventListResponse = firstPage): AuditTrailLoadOutcome {
  return { page, status: "ready" };
}

function client(
  load: AuditTrailClient["load"] = vi.fn(async () => ready()),
  page: AuditTrailClient["page"] = vi.fn(async () => secondPage),
): AuditTrailClient {
  return { load, page };
}

describe("AuditTrail", () => {
  it("renders a readable ledger without exposing opaque cursor material", () => {
    render(<AuditTrail client={client()} embedded initialOutcome={ready()} />);

    expect(screen.getByRole("heading", { name: "Service configuration updated" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recovery access attempted" })).toBeVisible();
    expect(screen.getByText("Administrator · Jellyfin")).toBeVisible();
    expect(screen.getByText("Recovery access · Break-glass recovery")).toBeVisible();
    expect(screen.getByText("2 recorded events")).toBeVisible();
    expect(screen.queryByText(firstPage.nextCursor!)).not.toBeInTheDocument();
  });

  it("applies category and outcome filters and distinguishes filtered-empty state", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<AuditTrailClient["load"]>()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(
        ready({ events: [], generatedAt: firstPage.generatedAt, nextCursor: null }),
      );
    render(<AuditTrail client={client(load)} embedded initialOutcome={ready()} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Event category" }), "access");
    await user.click(screen.getByRole("button", { name: "Denied events" }));

    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith({ category: "access", limit: 25, outcome: "denied" }),
    );
    expect(
      await screen.findByRole("heading", { name: "No events match this view." }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeEnabled();
  });

  it("loads the next encrypted page and announces the appended events", async () => {
    const user = userEvent.setup();
    const nextPage = vi.fn(async () => secondPage);
    render(<AuditTrail client={client(undefined, nextPage)} embedded initialOutcome={ready()} />);

    await user.click(screen.getByRole("button", { name: "Load earlier events" }));

    await waitFor(() =>
      expect(nextPage).toHaveBeenCalledWith({ cursor: firstPage.nextCursor, limit: 25 }),
    );
    expect(await screen.findByRole("heading", { name: "Library scan requested" })).toBeVisible();
    expect(screen.getByText("3 recorded events")).toBeVisible();
    expect(screen.getByText("1 earlier event loaded.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load earlier events" })).not.toBeInTheDocument();
  });

  it.each([
    ["signed_out", "Your administrative session ended."],
    ["forbidden", "This record is restricted."],
    ["unavailable", "The audit trail is temporarily offline."],
  ] as const)("renders the %s degraded state", (status, heading) => {
    render(<AuditTrail client={client()} embedded initialOutcome={{ status }} />);
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
  });

  it("preserves loaded events and offers a retry when pagination fails", async () => {
    const user = userEvent.setup();
    const nextPage = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<AuditTrail client={client(undefined, nextPage)} embedded initialOutcome={ready()} />);

    await user.click(screen.getByRole("button", { name: "Load earlier events" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Earlier events could not be loaded",
    );
    expect(screen.getByRole("heading", { name: "Service configuration updated" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry earlier events" })).toBeEnabled();
  });
});
