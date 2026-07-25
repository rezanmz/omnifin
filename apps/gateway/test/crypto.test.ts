import { describe, expect, it } from "vitest";
import {
  constantTimeTextEqual,
  EnvelopeCipher,
  hashToken,
  privacyHash,
  randomToken,
} from "../src/security/crypto.js";

describe("EnvelopeCipher", () => {
  const key = Buffer.alloc(32, 3);

  it("round-trips authenticated values only in their intended context", () => {
    const cipher = new EnvelopeCipher(key);
    const encrypted = cipher.encrypt("sensitive-value", "connector:test");
    expect(encrypted).not.toContain("sensitive-value");
    expect(cipher.decrypt(encrypted, "connector:test")).toBe("sensitive-value");
    expect(() => cipher.decrypt(encrypted, "connector:other")).toThrow(/authenticated/);
  });

  it("rejects malformed envelopes and invalid keys", () => {
    expect(() => new EnvelopeCipher(Buffer.alloc(12))).toThrow(/32-byte/);
    expect(() => new EnvelopeCipher(key).decrypt("v0.bad", "test")).toThrow(/Unsupported/);
    expect(() => new EnvelopeCipher(key).decrypt("v1.a..b", "test")).toThrow(/Malformed/);
  });
});

describe("opaque token helpers", () => {
  it("creates non-reversible stable hashes and private correlation values", () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThan(32);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(privacyHash("192.0.2.1", Buffer.alloc(32, 1))).toHaveLength(22);
  });

  it("compares text without early length exits", () => {
    expect(constantTimeTextEqual("same", "same")).toBe(true);
    expect(constantTimeTextEqual("same", "different-value")).toBe(false);
  });
});
