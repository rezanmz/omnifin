import { describe, expect, it, vi } from "vitest";

import { ConnectorHttpLane } from "@omnifin/connectors/http/connector-http-lane";

import { ConnectorHttpLaneRegistry } from "../src/connectors/http-lane-registry.js";

describe("ConnectorHttpLaneRegistry", () => {
  it("shares lanes by service and connector identity only", () => {
    const registry = new ConnectorHttpLaneRegistry();

    expect(registry.laneFor("jellyfin", "home")).toBe(registry.laneFor("jellyfin", "home"));
    expect(registry.laneFor("jellyfin", "home")).not.toBe(registry.laneFor("jellyfin", "away"));
    expect(registry.laneFor("jellyfin", "home")).not.toBe(registry.laneFor("seerr", "home"));

    registry.close();
  });

  it("retires synchronously, aborts old work, and creates a fresh lane", async () => {
    const registry = new ConnectorHttpLaneRegistry({
      createLane: (service) => new ConnectorHttpLane({ maxActive: 1, maxQueued: 1, service }),
    });
    const oldLane = registry.laneFor("jellyfin", "home");
    const active = await oldLane.acquire({ operation: "active" });
    const queued = oldLane.acquire({ operation: "queued" });

    registry.retire("jellyfin", "home");

    expect(active.signal.aborted).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: "unreachable" });
    expect(registry.laneFor("jellyfin", "home")).not.toBe(oldLane);
    registry.close();
  });

  it("closes every lane once and fails closed", () => {
    const lanes: ConnectorHttpLane[] = [];
    const registry = new ConnectorHttpLaneRegistry({
      createLane: (service) => {
        const lane = new ConnectorHttpLane({ service });
        vi.spyOn(lane, "close");
        lanes.push(lane);
        return lane;
      },
    });

    registry.laneFor("jellyfin", "home");
    registry.laneFor("seerr", "requests");
    registry.close();
    registry.close();

    expect(lanes).toHaveLength(2);
    expect(lanes.every((lane) => vi.mocked(lane.close).mock.calls.length === 1)).toBe(true);
    expect(() => registry.laneFor("jellyfin", "home")).toThrow();
    registry.retire("jellyfin", "home");
  });
});
