import { isValidElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardScreen } from "../../components/dashboard-screen";
import DashboardPage from "./page";

describe("DashboardPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves route-specific queue recovery data when demo mode is enabled", async () => {
    vi.stubEnv("OMNIFIN_DEMO_MODE", "true");
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");

    const result = await DashboardPage({
      searchParams: Promise.resolve({ "test-view": "queue-recovery" }),
    });

    expect(isValidElement(result)).toBe(true);
    if (!isValidElement<ComponentProps<typeof DashboardScreen>>(result)) {
      throw new Error("Expected the queue-recovery route to render DashboardScreen.");
    }

    expect(result.type).toBe(DashboardScreen);
    expect(result.props.demoSections).toBe(false);
    expect(result.props.data.operations[0]?.provenance?.events[0]).toMatchObject({
      kind: "stalled",
      recovery: {
        reference: `aqr_v2.${"A".repeat(100)}`,
      },
      state: "warning",
    });
  });
});
