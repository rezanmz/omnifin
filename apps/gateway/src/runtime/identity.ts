import { runtimeIdentitySchema, type RuntimeIdentity } from "@omnifin/contracts/runtime";

import { StartupError } from "../startup-error.js";

const DEFAULT_SOURCE_URL = "https://github.com/rezanmz/omnifin";

export function loadRuntimeIdentity(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RuntimeIdentity {
  const channel = environment.OMNIFIN_BUILD_CHANNEL ?? "development";
  const revisionValue = environment.OMNIFIN_BUILD_REVISION?.trim();
  const revision =
    !revisionValue || revisionValue === "unknown" || revisionValue === "development"
      ? null
      : revisionValue;

  try {
    return Object.freeze(
      runtimeIdentitySchema.parse({
        channel,
        license: "AGPL-3.0-only",
        revision,
        schemaVersion: 1,
        sourceUrl: environment.OMNIFIN_BUILD_SOURCE_URL ?? DEFAULT_SOURCE_URL,
        verification: channel === "development" ? "development" : "verified",
        version: environment.OMNIFIN_BUILD_VERSION ?? "0.0.0-dev",
      }),
    );
  } catch (error) {
    throw new StartupError("runtime_identity_invalid", { cause: error });
  }
}
