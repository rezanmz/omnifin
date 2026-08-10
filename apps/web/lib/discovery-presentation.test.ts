import type {
  DiscoveryAvailability,
  DiscoveryMediaRecordState,
} from "@omnifin/contracts/discovery";
import { describe, expect, it } from "vitest";

import { discoveryMediaIsRequestable } from "./discovery-presentation";

describe("discovery presentation", () => {
  it.each([
    ["partial", "present", true],
    ["partial", "absent", true],
    ["partial", "unknown", false],
    ["unavailable", "present", true],
    ["unavailable", "absent", true],
    ["unavailable", "unknown", false],
    ["unknown", "absent", true],
    ["unknown", "present", false],
    ["unknown", "unknown", false],
    ["available", "absent", false],
    ["requested", "absent", false],
    ["processing", "absent", false],
  ] satisfies ReadonlyArray<readonly [DiscoveryAvailability, DiscoveryMediaRecordState, boolean]>)(
    "treats %s+%s requestability as %s",
    (availability, state, expected) => {
      expect(discoveryMediaIsRequestable(availability, state)).toBe(expected);
    },
  );
});
