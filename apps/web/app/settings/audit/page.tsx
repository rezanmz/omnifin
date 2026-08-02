import type { AuditEventListResponse } from "@omnifin/contracts/audit";
import type { Metadata } from "next";

import { AuditTrailLoader } from "../../../components/audit-trail-loader";
import { AuditTrailPageShell } from "../../../components/audit-trail-page-shell";
import type { AuditTrailLoadOutcome } from "../../../lib/audit-trail";
import "../../globals.css";

export const metadata: Metadata = { title: "Operator audit trail" };
export const dynamic = "force-dynamic";

interface AuditTrailPageProperties {
  searchParams: Promise<{
    "test-profile"?: string | string[];
    "test-view"?: string | string[];
  }>;
}

const testPage: AuditEventListResponse = {
  events: [
    {
      actor: { authenticationMethod: "jellyfin", displayName: "Rezan", kind: "user" },
      category: "configuration",
      eventType: "connector.configuration.updated",
      id: "audit_0123456789abcdefghijkl",
      occurredAt: "2026-08-02T13:58:00.000Z",
      outcome: "success",
    },
    {
      actor: { authenticationMethod: "oidc", displayName: "Sloane Park", kind: "user" },
      category: "access",
      eventType: "auth.user.access_updated",
      id: "audit_123456789abcdefghijkl0",
      occurredAt: "2026-08-02T13:41:00.000Z",
      outcome: "success",
    },
    {
      actor: { authenticationMethod: "recovery", displayName: "Recovery access", kind: "recovery" },
      category: "authentication",
      eventType: "auth.admin.bootstrap_attempt",
      id: "audit_23456789abcdefghijkl01",
      occurredAt: "2026-08-02T12:42:00.000Z",
      outcome: "denied",
    },
    {
      actor: { authenticationMethod: "jellyfin", displayName: "Morgan Lee", kind: "user" },
      category: "requests",
      eventType: "media.request.approved",
      id: "audit_3456789abcdefghijkl012",
      occurredAt: "2026-08-01T22:18:00.000Z",
      outcome: "success",
    },
    {
      actor: { authenticationMethod: null, displayName: "Omnifin", kind: "system" },
      category: "library",
      eventType: "library.scan.requested",
      id: "audit_456789abcdefghijkl0123",
      occurredAt: "2026-08-01T21:52:00.000Z",
      outcome: "success",
    },
  ],
  generatedAt: "2026-08-02T14:00:00.000Z",
  nextCursor: `audit_cursor_v2.${"A".repeat(16)}.${"B".repeat(32)}.${"C".repeat(22)}`,
};

function testOutcome(view: string | string[] | undefined): AuditTrailLoadOutcome | undefined {
  if (process.env.OMNIFIN_TEST_MODE !== "true") return undefined;
  if (view === "forbidden" || view === "signed_out" || view === "unavailable") {
    return { status: view };
  }
  if (view !== "ready" && view !== "empty") return undefined;
  return {
    page:
      view === "empty"
        ? { events: [], generatedAt: testPage.generatedAt, nextCursor: null }
        : testPage,
    status: "ready",
  };
}

export default async function AuditTrailPage({ searchParams }: AuditTrailPageProperties) {
  const parameters = await searchParams;
  const testMode = process.env.OMNIFIN_TEST_MODE === "true";
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    (testMode && parameters["test-profile"] === "ten-foot")
      ? "ten-foot"
      : "standard";
  const initialOutcome = testOutcome(parameters["test-view"]);
  return (
    <AuditTrailPageShell displayProfile={displayProfile}>
      <AuditTrailLoader embedded {...(initialOutcome ? { initialOutcome } : {})} />
    </AuditTrailPageShell>
  );
}
