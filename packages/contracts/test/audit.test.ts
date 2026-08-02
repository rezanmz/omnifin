import { describe, expect, it } from "vitest";

import {
  AUDIT_EVENT_PAGE_DEFAULT_COUNT,
  AUDIT_EVENT_PAGE_MAX_COUNT,
  auditEventListQuerySchema,
  auditEventListResponseSchema,
} from "../src/audit.js";

const event = {
  actor: {
    authenticationMethod: "oidc" as const,
    displayName: "Sloane Park",
    kind: "user" as const,
  },
  category: "access" as const,
  eventType: "auth.user.access_updated",
  id: "audit_ABCDEFGHIJKLMNOPQRSTUV",
  occurredAt: "2026-08-02T12:00:00.000Z",
  outcome: "success" as const,
};

describe("audit event contracts", () => {
  it("accepts a strict privacy-safe page", () => {
    const page = {
      events: [event],
      generatedAt: "2026-08-02T12:00:01.000Z",
      nextCursor: `audit_cursor_v2.${"A".repeat(16)}.${"B".repeat(32)}.${"C".repeat(22)}`,
    };

    expect(auditEventListResponseSchema.parse(page)).toEqual(page);
    expect(AUDIT_EVENT_PAGE_DEFAULT_COUNT).toBe(25);
    expect(AUDIT_EVENT_PAGE_MAX_COUNT).toBe(50);
  });

  it("rejects raw metadata and private identifiers at every boundary", () => {
    for (const privateField of [
      { metadata: { upstreamId: "native-123" } },
      { ipHash: "private-ip-hash" },
      { sessionId: "session-private" },
      { targetId: "upstream-target" },
      { requestId: "request-private" },
    ]) {
      expect(
        auditEventListResponseSchema.safeParse({
          events: [{ ...event, ...privateField }],
          generatedAt: "2026-08-02T12:00:01.000Z",
          nextCursor: null,
        }).success,
      ).toBe(false);
    }
  });

  it("normalizes bounded filters and rejects filter-shaped cursor abuse", () => {
    expect(auditEventListQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(
      auditEventListQuerySchema.parse({
        category: "authentication",
        limit: "50",
        outcome: "denied",
      }),
    ).toEqual({ category: "authentication", limit: 50, outcome: "denied" });
    expect(auditEventListQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(auditEventListQuerySchema.safeParse({ cursor: "/srv/omnifin.db" }).success).toBe(false);
    expect(auditEventListQuerySchema.safeParse({ category: "raw_upstream" }).success).toBe(false);
  });
});
