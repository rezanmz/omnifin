import type { AuditEventListResponse } from "@omnifin/contracts/audit";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { AuditTrail } from "../components/audit-trail";
import type { AuditTrailClient, AuditTrailLoadOutcome } from "../lib/audit-trail";

const page: AuditEventListResponse = {
  events: [
    {
      actor: { authenticationMethod: "oidc", displayName: "Sloane Park", kind: "user" },
      category: "access",
      eventType: "auth.user.access_updated",
      id: "audit_0123456789abcdefghijkl",
      occurredAt: "2026-08-02T13:41:00.000Z",
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
    {
      actor: { authenticationMethod: null, displayName: "Omnifin", kind: "system" },
      category: "library",
      eventType: "library.scan.requested",
      id: "audit_23456789abcdefghijkl01",
      occurredAt: "2026-08-01T21:52:00.000Z",
      outcome: "success",
    },
  ],
  generatedAt: "2026-08-02T14:00:00.000Z",
  nextCursor: null,
};
const ready: AuditTrailLoadOutcome = { page, status: "ready" };
const loadingClient: AuditTrailClient = {
  load: () => new Promise<AuditTrailLoadOutcome>(() => undefined),
  page: async () => page,
};
const storyClient: AuditTrailClient = {
  load: async (query) => ({
    page: {
      ...page,
      events: page.events.filter(
        (event) =>
          (!query?.category || event.category === query.category) &&
          (!query?.outcome || event.outcome === query.outcome),
      ),
    },
    status: "ready",
  }),
  page: async () => page,
};

const meta = {
  args: { client: storyClient, initialOutcome: ready },
  component: AuditTrail,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs", "test"],
  title: "Screens/Operator audit trail",
} satisfies Meta<typeof AuditTrail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Loading: Story = {
  render: () => <AuditTrail client={loadingClient} />,
};
export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Event category" }),
      "access",
    );
    await expect(canvas.getByRole("combobox", { name: "Event category" })).toHaveValue("access");
  },
};
export const Empty: Story = {
  args: {
    initialOutcome: {
      page: { events: [], generatedAt: page.generatedAt, nextCursor: null },
      status: "ready",
    },
  },
};
export const Restricted: Story = { args: { initialOutcome: { status: "forbidden" } } };
export const SignedOut: Story = { args: { initialOutcome: { status: "signed_out" } } };
export const GatewayUnavailable: Story = {
  args: { initialOutcome: { status: "unavailable" } },
};
export const TenFoot: Story = { args: { displayProfile: "ten-foot" } };
