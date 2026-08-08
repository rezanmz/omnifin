import type { DiscoveryAvailability } from "@omnifin/contracts/discovery";
import { describe, expect, it } from "vitest";

import { discoveryAvailabilityIsRequestable } from "./discovery-presentation";

describe("discovery presentation", () => {
  it.each([
    ["partial", true],
    ["unavailable", true],
    ["available", false],
    ["unknown", false],
    ["requested", false],
    ["processing", false],
  ] satisfies ReadonlyArray<readonly [DiscoveryAvailability, boolean]>)(
    "treats %s requestability as %s",
    (availability, expected) => {
      expect(discoveryAvailabilityIsRequestable(availability)).toBe(expected);
    },
  );
});
