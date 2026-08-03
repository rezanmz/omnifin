import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
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
    expect(result.props.liveCalendar).toBe(false);
    expect(result.props.data.operations[0]?.provenance?.events[0]).toMatchObject({
      kind: "stalled",
      recovery: {
        reference: `aqr_v2.${"A".repeat(100)}`,
      },
      state: "warning",
    });
  });

  it("emits the demo hero preload before the dashboard", async () => {
    vi.stubEnv("OMNIFIN_DEMO_MODE", "true");

    const result = await DashboardPage({ searchParams: Promise.resolve({}) });

    expect(isValidElement(result)).toBe(true);
    if (!isValidElement<{ children: ReactNode }>(result)) {
      throw new Error("Expected demo mode to render a preload and dashboard fragment.");
    }
    const [preload, dashboard] = Children.toArray(result.props.children);
    expect(preload).toMatchObject({
      props: { as: "image", fetchPriority: "high", href: "/demo-hero.svg", rel: "preload" },
      type: "link",
    });
    expect(isValidElement(dashboard) && dashboard.type).toBe(DashboardScreen);
    if (!isValidElement<ComponentProps<typeof DashboardScreen>>(dashboard)) {
      throw new Error("Expected demo mode to render DashboardScreen after the preload.");
    }
    expect(dashboard.props.liveCalendar).toBe(false);
  });

  it("loads the live release cadence for a connected dashboard", async () => {
    vi.stubEnv("OMNIFIN_DEMO_MODE", "false");

    const result = await DashboardPage({ searchParams: Promise.resolve({}) });

    expect(isValidElement(result)).toBe(true);
    if (!isValidElement<ComponentProps<typeof DashboardScreen>>(result)) {
      throw new Error("Expected the connected route to render DashboardScreen.");
    }
    expect(result.type).toBe(DashboardScreen);
    expect(result.props.liveCalendar).toBe(true);
  });
});
