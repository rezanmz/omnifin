import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startupFailureDetails } from "../src/startup-error.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("loadConfig", () => {
  it("decodes a 32-byte key and production security defaults", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      OMNIFIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.secureCookies).toBe(true);
    expect(config.baseUrl.origin).toBe("http://localhost:3000");
    expect(config.host).toBe("127.0.0.1");
    expect(config.trustProxyHops).toBe(0);
  });

  it("loads secrets from files without exposing their contents in errors", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "omnifin-config-"));
    temporaryDirectories.push(directory);
    const keyFile = path.join(directory, "key");
    const recoveryFile = path.join(directory, "recovery");
    writeFileSync(keyFile, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
    writeFileSync(recoveryFile, "break-glass-value", { mode: 0o600 });
    const config = loadConfig({
      NODE_ENV: "test",
      OMNIFIN_ENCRYPTION_KEY_FILE: keyFile,
      OMNIFIN_RECOVERY_SECRET_FILE: recoveryFile,
    });
    expect(config.recoverySecret).toBe("break-glass-value");
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

  it("requires a canonical HTTP(S) public URL and HTTPS for non-loopback production hosts", () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    for (const baseUrl of [
      "file:///tmp/omnifin",
      "ftp://omnifin.example/",
      "https://user:password@omnifin.example/",
      "https://omnifin.example/?tenant=home",
      "https://omnifin.example/#dashboard",
      "http://omnifin.example/",
    ]) {
      expect(() =>
        loadConfig({
          NODE_ENV: "production",
          OMNIFIN_BASE_URL: baseUrl,
          OMNIFIN_ENCRYPTION_KEY: encryptionKey,
        }),
      ).toThrow(/base url/i);
    }

    expect(
      loadConfig({
        NODE_ENV: "production",
        OMNIFIN_BASE_URL: "http://127.0.0.1:3000/preview",
        OMNIFIN_ENCRYPTION_KEY: encryptionKey,
      }).baseUrl.href,
    ).toBe("http://127.0.0.1:3000/preview");
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
  });
});
