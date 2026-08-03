import { describe, expect, it } from "vitest";

import { applicationDestinationForPath } from "./application-shell-route";

describe("application shell route mapping", () => {
  it("keeps viewing history inside the persistent Library destination", () => {
    expect(applicationDestinationForPath("/history")).toBe("library");
    expect(applicationDestinationForPath("/history/older")).toBe("library");
  });
});
