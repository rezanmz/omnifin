import { createDecipheriv, createHmac } from "node:crypto";
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

  function decryptWithRawRootKey(envelope: string, context: string) {
    const [version, iv, ciphertext, tag] = envelope.split(".");
    expect(version).toBe("v2");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv ?? "", "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag ?? "", "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext ?? "", "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  it("round-trips authenticated values only in their intended context", () => {
    const cipher = new EnvelopeCipher(key);
    const encrypted = cipher.encrypt("sensitive-value", "connector:test");
    expect(encrypted).not.toContain("sensitive-value");
    expect(cipher.decrypt(encrypted, "connector:test")).toBe("sensitive-value");
    expect(() => cipher.decrypt(encrypted, "connector:other")).toThrow(/authenticated/);
  });

  it("derives an envelope subkey instead of using the root key directly", () => {
    const encrypted = new EnvelopeCipher(key).encrypt("sensitive-value", "connector:test");
    expect(() => decryptWithRawRootKey(encrypted, "connector:test")).toThrow();
  });

  it("decrypts legacy v1 envelopes and marks them for lazy re-encryption", () => {
    const legacyEnvelope =
      "v1.AAECAwQFBgcICQoL.K9QRLayZcH1UqxXPk4DxkJKmH1JMug.tBZtd3dJPb09DS2Q9MnvbA";
    const cipher = new EnvelopeCipher(key);

    expect(cipher.decryptWithMetadata(legacyEnvelope, "connector:test")).toEqual({
      needsReencryption: true,
      plaintext: "legacy-sensitive-value",
    });
    expect(() => cipher.decrypt(legacyEnvelope, "connector:other")).toThrow(/authenticated/);

    const currentEnvelope = cipher.encrypt("current-sensitive-value", "connector:test");
    expect(currentEnvelope.startsWith("v2.")).toBe(true);
    expect(cipher.decryptWithMetadata(currentEnvelope, "connector:test")).toEqual({
      needsReencryption: false,
      plaintext: "current-sensitive-value",
    });
  });

  it("rejects ciphertext or authenticated-context swaps", () => {
    const cipher = new EnvelopeCipher(key);
    const left = cipher.encrypt("left-value", "connector:left");
    const right = cipher.encrypt("right-value", "connector:right");
    const [version, leftIv, , leftTag] = left.split(".");
    const [, , rightCiphertext] = right.split(".");
    const swappedCiphertext = [version, leftIv, rightCiphertext, leftTag].join(".");

    expect(() => cipher.decrypt(left, "connector:right")).toThrow(/authenticated/);
    expect(() => cipher.decrypt(swappedCiphertext, "connector:left")).toThrow(/authenticated/);
  });

  it("rejects malformed envelopes and invalid keys", () => {
    expect(() => new EnvelopeCipher(Buffer.alloc(12))).toThrow(/32-byte/);
    expect(() => new EnvelopeCipher(key).decrypt("v0.bad", "test")).toThrow(/Unsupported/);
    expect(() => new EnvelopeCipher(key).decrypt("v2.a..b", "test")).toThrow(/Malformed/);
  });
});

describe("opaque token helpers", () => {
  it("creates non-reversible stable hashes and private correlation values", () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThan(32);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    const rootKey = Buffer.alloc(32, 1);
    const privateHash = privacyHash("ip_address", "192.0.2.1", rootKey);
    const directRootHash = createHmac("sha256", rootKey)
      .update("192.0.2.1", "utf8")
      .digest("base64url")
      .slice(0, 22);
    expect(privateHash).toHaveLength(22);
    expect(privateHash).not.toBe(directRootHash);
  });

  it("domain-separates privacy hashes for unrelated sensitive fields", () => {
    const rootKey = Buffer.alloc(32, 9);
    const value = "same-sensitive-value";
    const hashes = [
      privacyHash("ip_address", value, rootKey),
      privacyHash("user_agent", value, rootKey),
      privacyHash("oidc_session_id", value, rootKey),
      privacyHash("oidc_failure_audit_bucket", value, rootKey),
      privacyHash("oidc_failure_audit_ip_address", value, rootKey),
      privacyHash("oidc_failure_audit_user_agent", value, rootKey),
      privacyHash("rate_limit_client", value, rootKey),
    ];

    expect(new Set(hashes).size).toBe(hashes.length);
    expect(privacyHash("ip_address", value, rootKey)).toBe(hashes[0]);
  });

  it("compares text without early length exits", () => {
    expect(constantTimeTextEqual("same", "same")).toBe(true);
    expect(constantTimeTextEqual("same", "different-value")).toBe(false);
  });
});
