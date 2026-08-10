import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { DiscoveryAvailability, DiscoveryMediaRecordState } from "../src/discovery.js";
import { isDiscoveryMediaRequestable } from "../src/discovery-requestability.js";

const requestabilityMatrix = [
  ["available", "present", false],
  ["available", "absent", false],
  ["available", "unknown", false],
  ["partial", "present", true],
  ["partial", "absent", true],
  ["partial", "unknown", false],
  ["requested", "present", false],
  ["requested", "absent", false],
  ["requested", "unknown", false],
  ["processing", "present", false],
  ["processing", "absent", false],
  ["processing", "unknown", false],
  ["unavailable", "present", true],
  ["unavailable", "absent", true],
  ["unavailable", "unknown", false],
  ["unknown", "present", false],
  ["unknown", "absent", true],
  ["unknown", "unknown", false],
] satisfies ReadonlyArray<readonly [DiscoveryAvailability, DiscoveryMediaRecordState, boolean]>;

describe("discovery requestability", () => {
  it.each(requestabilityMatrix)(
    "treats %s+%s requestability as %s",
    (availability, mediaRecordState, expected) => {
      expect(isDiscoveryMediaRequestable({ availability, mediaRecordState })).toBe(expected);
    },
  );

  it("keeps the emitted leaf free of discovery schema runtime imports", async () => {
    const emittedModule = readFileSync(
      new URL("../dist/discovery-requestability.js", import.meta.url),
      "utf8",
    );

    expect(emittedModule).not.toMatch(/from\s+["']\.\/discovery\.js["']/u);
    expect(emittedModule).not.toMatch(/from\s+["']zod["']/u);

    const leaf = await import("../dist/discovery-requestability.js");
    expect(
      leaf.isDiscoveryMediaRequestable({ availability: "unknown", mediaRecordState: "absent" }),
    ).toBe(true);
  });
});
