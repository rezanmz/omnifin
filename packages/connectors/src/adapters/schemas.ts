import { z } from "zod";

const VERSION_PATTERN =
  /^[vV]?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,4}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

export const upstreamVersionSchema = z.string().trim().min(1).max(128).regex(VERSION_PATTERN);

const VERSION_DELIMITERS = new Set([".", "+", "-"]);
const MIN_UNBOUNDED_SECRET_LENGTH = 8;
const MIN_BOUNDED_SECRET_LENGTH = 4;

function isDelimited(value: string, index: number): boolean {
  return index < 0 || index >= value.length || VERSION_DELIMITERS.has(value[index] ?? "");
}

function containsProtectedValue(candidate: string, protectedValue: string): boolean {
  if (candidate === protectedValue) return true;
  if (/^[vV]/u.test(candidate) && candidate.slice(1) === protectedValue) return true;

  let matchAt = candidate.indexOf(protectedValue);
  while (matchAt !== -1) {
    if (protectedValue.length >= MIN_UNBOUNDED_SECRET_LENGTH) return true;

    const matchEnd = matchAt + protectedValue.length;
    const isBoundedCredentialToken =
      protectedValue.length >= MIN_BOUNDED_SECRET_LENGTH &&
      /[A-Za-z]/u.test(protectedValue) &&
      isDelimited(candidate, matchAt - 1) &&
      isDelimited(candidate, matchEnd);
    if (isBoundedCredentialToken) return true;

    matchAt = candidate.indexOf(protectedValue, matchAt + 1);
  }
  return false;
}

/**
 * Normalizes the small, known family of upstream version formats and rejects values that
 * could reflect configured credentials. A rejected value is deliberately never included in
 * the result or an error message.
 */
export function normalizeUpstreamVersion(
  value: unknown,
  protectedValues: readonly string[] = [],
): string | null {
  const parsed = upstreamVersionSchema.safeParse(value);
  if (!parsed.success) return null;

  const candidate = parsed.data;
  for (const rawProtectedValue of protectedValues) {
    const protectedValue = rawProtectedValue.trim();
    if (protectedValue && containsProtectedValue(candidate, protectedValue)) return null;
  }
  return candidate;
}
