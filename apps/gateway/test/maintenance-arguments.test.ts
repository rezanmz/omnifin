import { describe, expect, it } from "vitest";
import {
  assertOnlyMaintenanceValues,
  parseMaintenanceArguments,
  requireMaintenanceInteger,
  requireMaintenanceValue,
} from "../src/operations/maintenance-arguments.js";

describe("maintenance argument grammar", () => {
  it("parses bounded values and the explicit stopped-gateway flag", () => {
    const parsed = parseMaintenanceArguments([
      "--input",
      "/backups/source.sqlite",
      "--rollback-output",
      "/backups/rollback.sqlite",
      "--confirm-gateway-stopped",
    ]);

    expect(requireMaintenanceValue(parsed, "--input")).toBe("/backups/source.sqlite");
    expect(requireMaintenanceValue(parsed, "--rollback-output")).toBe("/backups/rollback.sqlite");
    expect(parsed.flags).toEqual(new Set(["--confirm-gateway-stopped"]));
  });

  it("parses an explicitly bounded retention count", () => {
    const parsed = parseMaintenanceArguments(["--retain", "14"]);

    expect(requireMaintenanceInteger(parsed, "--retain", { maximum: 365, minimum: 2 })).toBe(14);
  });

  it.each([
    ["unknown argument", ["--public-url", "https://elsewhere.test"]],
    ["missing value", ["--input"]],
    ["flag-shaped value", ["--input", "--output"]],
    ["duplicate value", ["--input", "first", "--input", "second"]],
    ["duplicate flag", ["--confirm-gateway-stopped", "--confirm-gateway-stopped"]],
  ])("rejects %s", (_name, arguments_) => {
    expect(() => parseMaintenanceArguments(arguments_)).toThrow("usage");
  });

  it("rejects values and flags for the doctor operation", () => {
    const value = parseMaintenanceArguments(["--input", "/private/path"]);
    expect(() => assertOnlyMaintenanceValues(value, [])).toThrow("usage");

    const flag = parseMaintenanceArguments(["--confirm-gateway-stopped"]);
    expect(flag.flags.size).toBe(1);
  });

  it("rejects missing required operation values", () => {
    expect(() => requireMaintenanceValue(parseMaintenanceArguments([]), "--output")).toThrow(
      "usage",
    );
  });
});
