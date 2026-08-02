import { z } from "zod";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const stableSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const fullRevisionPattern = /^[0-9a-f]{40}$/u;

export const runtimeChannelSchema = z.enum(["development", "edge", "stable"]);
export const runtimeVerificationSchema = z.enum(["development", "verified"]);
export const runtimeVersionSchema = z.string().trim().min(1).max(128).regex(semverPattern);
export const runtimeRevisionSchema = z.string().regex(fullRevisionPattern).nullable();

function safeHttpsSource(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function immutableSource(value: string, revision: string) {
  if (!safeHttpsSource(value)) return false;
  const pathname = new URL(value).pathname.replace(/\/$/u, "");
  return pathname.endsWith(`/tree/${revision}`) || pathname.endsWith(`/commit/${revision}`);
}

export const runtimeIdentitySchema = z
  .object({
    channel: runtimeChannelSchema,
    license: z.literal("AGPL-3.0-only"),
    revision: runtimeRevisionSchema,
    schemaVersion: z.literal(1),
    sourceUrl: z.string().trim().min(1).max(2_048).refine(safeHttpsSource),
    verification: runtimeVerificationSchema,
    version: runtimeVersionSchema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.channel === "development") {
      if (
        identity.revision !== null ||
        identity.verification !== "development" ||
        !identity.version.split("-")[1]?.split(/[.+]/u).includes("dev")
      ) {
        context.addIssue({
          code: "custom",
          message: "Development identities must be explicit and unverified.",
        });
      }
      return;
    }

    if (
      identity.revision === null ||
      identity.verification !== "verified" ||
      !immutableSource(identity.sourceUrl, identity.revision)
    ) {
      context.addIssue({
        code: "custom",
        message: "Published identities require an immutable corresponding-source revision.",
      });
    }

    if (identity.channel === "stable" && !stableSemverPattern.test(identity.version)) {
      context.addIssue({ code: "custom", message: "Stable identities require stable SemVer." });
    }
    if (
      identity.channel === "edge" &&
      !identity.version.split("-")[1]?.split(/[.+]/u).includes("edge")
    ) {
      context.addIssue({ code: "custom", message: "Edge identities require an edge prerelease." });
    }
  });

export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;

export const runtimeIdentityJsonSchema = z.toJSONSchema(runtimeIdentitySchema);
delete runtimeIdentityJsonSchema.$schema;
