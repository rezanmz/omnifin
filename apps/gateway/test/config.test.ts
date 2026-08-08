import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, verifyRecoverySecret } from "../src/config.js";
import { startupFailureDetails } from "../src/startup-error.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("loadConfig", () => {
  const immutableImage = `ghcr.io/rezanmz/omnifin@sha256:${"a".repeat(64)}`;

  it("decodes a 32-byte key and production security defaults", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      OMNIFIN_BASE_URL: "https://omnifin.example",
      OMNIFIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      OMNIFIN_IMAGE_REF: immutableImage,
    });
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.secureCookies).toBe(true);
    expect(config.baseUrl.origin).toBe("https://omnifin.example");
    expect(config.insecureLoopbackPreview).toBe(false);
    expect(config.host).toBe("127.0.0.1");
    expect(config.trustProxyHops).toBe(0);
    expect(config.session.recoveryAbsoluteTtlMs).toBe(15 * 60 * 1_000);
  });

  it("treats blank optional secret settings as unset", () => {
    const config = loadConfig({
      OMNIFIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      OMNIFIN_ENCRYPTION_KEY_FILE: "",
      OMNIFIN_RECOVERY_SECRET: "   ",
      OMNIFIN_RECOVERY_SECRET_FILE: "",
    });

    expect(config.encryptionKey).toHaveLength(32);
    expect(config.recoverySecretDigest).toBeUndefined();
  });

  it("loads secrets from files without exposing their contents in errors", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-config-"));
    temporaryDirectories.push(directory);
    const keyFile = path.join(directory, "key");
    const recoveryFile = path.join(directory, "recovery");
    writeFileSync(keyFile, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
    const recoverySecret = Buffer.alloc(32, 11).toString("base64");
    writeFileSync(recoveryFile, `${recoverySecret}\n`, { mode: 0o600 });
    const config = loadConfig({
      NODE_ENV: "test",
      OMNIFIN_ENCRYPTION_KEY_FILE: keyFile,
      OMNIFIN_RECOVERY_SECRET_FILE: recoveryFile,
    });
    expect(config.recoverySecretDigest).toBeInstanceOf(Buffer);
    expect(config.recoverySecretDigest).toHaveLength(32);
    expect(config).not.toHaveProperty("recoverySecret");
    expect(verifyRecoverySecret(recoverySecret, config.recoverySecretDigest)).toBe(true);
  });

  it("retains only a fixed-length recovery-secret digest and verifies canonical candidates", () => {
    const recoverySecret = Buffer.alloc(47, 13).toString("base64");
    const config = loadConfig({
      OMNIFIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      OMNIFIN_RECOVERY_SECRET: recoverySecret,
    });

    expect(config.recoverySecretDigest).toHaveLength(32);
    expect(config).not.toHaveProperty("recoverySecret");
    expect(JSON.stringify(config)).not.toContain(recoverySecret);
    expect(verifyRecoverySecret(recoverySecret, config.recoverySecretDigest)).toBe(true);
    expect(
      verifyRecoverySecret(Buffer.alloc(47, 14).toString("base64"), config.recoverySecretDigest),
    ).toBe(false);
    expect(
      verifyRecoverySecret(recoverySecret.replace(/=+$/, ""), config.recoverySecretDigest),
    ).toBe(false);
    expect(
      verifyRecoverySecret(Buffer.alloc(31, 13).toString("base64"), config.recoverySecretDigest),
    ).toBe(false);
    expect(verifyRecoverySecret("not base64!", config.recoverySecretDigest)).toBe(false);
    expect(verifyRecoverySecret(recoverySecret, Buffer.alloc(31))).toBe(false);
    const oversizedSecretBytes = Buffer.alloc(129, 13);
    expect(
      verifyRecoverySecret(
        oversizedSecretBytes.toString("base64"),
        createHash("sha256").update(oversizedSecretBytes).digest(),
      ),
    ).toBe(false);
  });

  it("rejects recovery secrets that are short or not canonical base64", () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    for (const recoverySecret of [
      Buffer.alloc(31, 9).toString("base64"),
      Buffer.alloc(129, 9).toString("base64"),
      Buffer.alloc(32, 9).toString("base64url"),
      `${Buffer.alloc(32, 9).toString("base64")}!`,
    ]) {
      let failure: unknown;
      try {
        loadConfig({
          OMNIFIN_ENCRYPTION_KEY: encryptionKey,
          OMNIFIN_RECOVERY_SECRET: recoverySecret,
        });
      } catch (error) {
        failure = error;
      }
      expect(startupFailureDetails(failure)).toEqual({
        category: "secrets",
        code: "recovery_secret_invalid",
      });
    }
  });

  it("rejects ambiguous and malformed encryption key configuration", () => {
    const conflictingConfiguration = () =>
      loadConfig({
        OMNIFIN_ENCRYPTION_KEY: "also-present",
        OMNIFIN_ENCRYPTION_KEY_FILE: "/tmp/not-read",
      });
    expect(conflictingConfiguration).toThrow(/value or file/);
    try {
      conflictingConfiguration();
    } catch (error) {
      expect(startupFailureDetails(error)).toEqual({
        category: "secrets",
        code: "encryption_key_conflict",
      });
    }

    for (const malformedKey of ["dG9vLXNob3J0", `${Buffer.alloc(32, 7).toString("base64")}!`]) {
      try {
        loadConfig({ OMNIFIN_ENCRYPTION_KEY: malformedKey });
        throw new Error("Expected malformed key configuration to fail.");
      } catch (error) {
        expect(startupFailureDetails(error)).toEqual({
          category: "secrets",
          code: "encryption_key_invalid",
        });
      }
    }
  });

  it("categorizes unreadable secret files without exposing their paths", () => {
    const missingPath = "/private/sensitive-omnifin-key";
    let failure: unknown;
    try {
      loadConfig({ OMNIFIN_ENCRYPTION_KEY_FILE: missingPath });
    } catch (error) {
      failure = error;
    }

    expect(startupFailureDetails(failure)).toEqual({
      category: "secrets",
      code: "encryption_key_file_unreadable",
    });
    expect((failure as Error).message).not.toContain(missingPath);
  });

  it("accepts a bounded explicit proxy hop count", () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    expect(
      loadConfig({
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
        OMNIFIN_TRUST_PROXY_HOPS: "1",
      }).trustProxyHops,
    ).toBe(1);
    expect(() =>
      loadConfig({ OMNIFIN_ENCRYPTION_KEY: encryptionKey, OMNIFIN_TRUST_PROXY_HOPS: "5" }),
    ).toThrow();
  });

  it("requires a root HTTP(S) public origin and HTTPS for non-loopback production hosts", () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    for (const baseUrl of [
      "file:///tmp/omnifin",
      "ftp://omnifin.example/",
      "https://user:password@omnifin.example/",
      "https://omnifin.example/preview",
      "https://omnifin.example/preview/",
      "https://omnifin.example/?tenant=home",
      "https://omnifin.example/?",
      "https://omnifin.example/#dashboard",
      "https://omnifin.example/#",
      "http://omnifin.example/",
      "http://127.0.0.1:3000/preview",
    ]) {
      expect(() =>
        loadConfig({
          NODE_ENV: "production",
          OMNIFIN_BASE_URL: baseUrl,
          OMNIFIN_ENCRYPTION_KEY: encryptionKey,
        }),
      ).toThrow(/base url/i);
    }

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        OMNIFIN_BASE_URL: "http://127.0.0.1:3000",
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      }),
    ).toThrow(/base url/i);
    const preview = loadConfig({
      NODE_ENV: "production",
      OMNIFIN_BASE_URL: "http://127.0.0.1:3000",
      OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      OMNIFIN_INSECURE_LOOPBACK_PREVIEW: "true",
      OMNIFIN_IMAGE_REF: immutableImage,
    });
    expect(preview.baseUrl.href).toBe("http://127.0.0.1:3000/");
    expect(preview.insecureLoopbackPreview).toBe(true);
    expect(preview.secureCookies).toBe(false);
    expect(
      loadConfig({
        NODE_ENV: "production",
        OMNIFIN_BASE_URL: "https://omnifin.example",
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
        OMNIFIN_IMAGE_REF: immutableImage,
      }).baseUrl.href,
    ).toBe("https://omnifin.example/");
  });

  it("requires an immutable image reference in production", () => {
    const environment = {
      NODE_ENV: "production",
      OMNIFIN_BASE_URL: "https://omnifin.example",
      OMNIFIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    } as const;
    for (const imageReference of [undefined, "ghcr.io/rezanmz/omnifin:latest", "two refs"]) {
      expect(() =>
        loadConfig({
          ...environment,
          ...(imageReference ? { OMNIFIN_IMAGE_REF: imageReference } : {}),
        }),
      ).toThrowError(expect.objectContaining({ startupFailureCode: "image_reference_invalid" }));
    }
  });

  it("limits insecure cookies to an explicit production preview or development loopback", () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const developmentPreview = loadConfig({
      NODE_ENV: "development",
      OMNIFIN_BASE_URL: "http://localhost:3000",
      OMNIFIN_ENCRYPTION_KEY: encryptionKey,
    });
    expect(developmentPreview.secureCookies).toBe(false);
    expect(developmentPreview.insecureLoopbackPreview).toBe(true);
    expect(
      loadConfig({
        NODE_ENV: "development",
        OMNIFIN_BASE_URL: "https://omnifin.example",
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      }).secureCookies,
    ).toBe(true);
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        OMNIFIN_BASE_URL: "http://omnifin.example",
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      }),
    ).toThrow(/base url/i);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        OMNIFIN_BASE_URL: "http://localhost:3000",
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
        OMNIFIN_SECURE_COOKIES: "true",
      }),
    ).toThrow(/base url/i);
  });

  it("accepts only policy-safe Jellyfin URLs and requires explicit approval for plain HTTP", () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const unset = loadConfig({
      OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED: "false",
      OMNIFIN_JELLYFIN_URL: "",
    });
    expect(unset.jellyfinUrl).toBeUndefined();
    expect(unset.jellyfinInsecureHttpApproved).toBe(false);

    for (const jellyfinUrl of [
      "file:///tmp/jellyfin",
      "https://user:password@jellyfin.example/",
      "https://jellyfin.example/?api_key=secret",
      "https://jellyfin.example/?",
      "https://jellyfin.example/#configuration",
      "https://jellyfin.example/#",
      "http://192.168.1.20:8096/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fe80::1]:8920/",
      "https://[::ffff:a9fe:a9fe]:8920/",
      "https://[fd00:ec2::23]/v1/credentials/",
    ]) {
      expect(() =>
        loadConfig({
          OMNIFIN_ENCRYPTION_KEY: encryptionKey,
          OMNIFIN_JELLYFIN_URL: jellyfinUrl,
        }),
      ).toThrow(/Jellyfin/i);
    }

    expect(() =>
      loadConfig({
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
        OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED: "true",
      }),
    ).toThrow(/Jellyfin/i);

    const secure = loadConfig({
      OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      OMNIFIN_JELLYFIN_URL: "https://jellyfin.example/base/",
    });
    expect(secure.jellyfinUrl?.href).toBe("https://jellyfin.example/base/");
    expect(secure.jellyfinInsecureHttpApproved).toBe(false);

    const approved = loadConfig({
      OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      OMNIFIN_JELLYFIN_INSECURE_HTTP_APPROVED: "true",
      OMNIFIN_JELLYFIN_URL: "http://192.168.1.20:8096/base/",
    });
    expect(approved.jellyfinUrl?.href).toBe("http://192.168.1.20:8096/base/");
    expect(approved.jellyfinInsecureHttpApproved).toBe(true);

    const secureLan = loadConfig({
      OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      OMNIFIN_JELLYFIN_URL: "https://10.20.30.40:8920/",
    });
    expect(secureLan.jellyfinUrl?.href).toBe("https://10.20.30.40:8920/");
  });
});
