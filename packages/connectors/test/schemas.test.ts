import { describe, expect, it } from "vitest";

import { normalizeUpstreamVersion } from "../src/adapters/schemas.js";

describe("upstream version normalization", () => {
  it.each(["v5.1.2", "10.11.2", "6.0.4.10291", "1.2.3-rc.1+build.7"])(
    "preserves the known upstream format %s",
    (version) => {
      expect(normalizeUpstreamVersion(`  ${version}\n`)).toBe(version);
    },
  );

  it.each(["fixture-api-key", "1", "01.2.3", "1.02.3", "<script>1.2.3</script>"])(
    "rejects the non-version value %s",
    (value) => {
      expect(normalizeUpstreamVersion(value)).toBeNull();
    },
  );

  it("rejects exact, conventionally prefixed, long embedded, and bounded token reflections", () => {
    expect(normalizeUpstreamVersion("7.8.9", ["7.8.9"])).toBeNull();
    expect(normalizeUpstreamVersion("v7.8.9", ["7.8.9"])).toBeNull();
    expect(
      normalizeUpstreamVersion("1.2.3+credential-reflection-token", [
        "credential-reflection-token",
      ]),
    ).toBeNull();
    expect(normalizeUpstreamVersion("1.2.3-rc.1", [" rc.1 "])).toBeNull();
  });

  it("does not confuse an ambiguous short numeric overlap with a reflected credential", () => {
    expect(normalizeUpstreamVersion("10.11.2", ["1"])).toBe("10.11.2");
  });
});
