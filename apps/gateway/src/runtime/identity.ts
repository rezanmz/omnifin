import {
  RUNTIME_IDENTITY_RESPONSE_MAX_BYTES,
  runtimeIdentitySchema,
  type RuntimeIdentity,
} from "@omnifin/contracts/runtime";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

import { StartupError } from "../startup-error.js";

const DEFAULT_SOURCE_URL = "https://github.com/rezanmz/omnifin";
const BAKED_IDENTITY_PATH = "/opt/omnifin/build-identity.json";

interface RuntimeIdentityDependencies {
  readonly readBakedIdentity?: () => string | undefined;
}

function readBakedIdentity() {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(BAKED_IDENTITY_PATH, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > RUNTIME_IDENTITY_RESPONSE_MAX_BYTES) {
      throw new Error("baked_runtime_identity_invalid");
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadRuntimeIdentity(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  dependencies: RuntimeIdentityDependencies = {},
): RuntimeIdentity {
  try {
    const bakedSource = (dependencies.readBakedIdentity ?? readBakedIdentity)();
    if (bakedSource !== undefined) {
      if (Buffer.byteLength(bakedSource, "utf8") > RUNTIME_IDENTITY_RESPONSE_MAX_BYTES) {
        throw new Error("baked_runtime_identity_invalid");
      }
      return Object.freeze(runtimeIdentitySchema.parse(JSON.parse(bakedSource) as unknown));
    }

    const channel = environment.OMNIFIN_BUILD_CHANNEL ?? "development";
    const revisionValue = environment.OMNIFIN_BUILD_REVISION?.trim();
    const revision =
      !revisionValue || revisionValue === "unknown" || revisionValue === "development"
        ? null
        : revisionValue;
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
