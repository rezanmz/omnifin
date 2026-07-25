import { describe, expect, it } from "vitest";

import {
  isBlockedDestinationAddress,
  validateDestinationUrl,
} from "../src/security/destination.js";
import { publicResolver } from "./helpers/mock-fetch.js";

describe("connector destination policy", () => {
  it("accepts an HTTPS target that resolves outside blocked ranges", async () => {
    const result = await validateDestinationUrl("https://radarr.example.test/base/", {
      resolveHost: publicResolver,
    });

    expect(result.href).toBe("https://radarr.example.test/base/");
  });

  it("requires explicit approval before using plain HTTP", async () => {
    await expect(validateDestinationUrl("http://192.168.20.10:7878")).rejects.toMatchObject({
      code: "destination_protocol_blocked",
    });

    await expect(
      validateDestinationUrl("http://192.168.20.10:7878", { allowInsecureHttp: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "::1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "fd00:ec2::254",
    "fd20:ce::254",
    "fe80::1",
    "ff02::1",
  ])("blocks special-use address %s", (address) => {
    expect(isBlockedDestinationAddress(address)).toBe(true);
  });

  it("blocks metadata hostnames and credentials embedded in a URL", async () => {
    await expect(
      validateDestinationUrl("https://metadata.google.internal/latest", {
        resolveHost: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "destination_host_blocked" });

    await expect(
      validateDestinationUrl("https://admin:secret@service.example.test", {
        resolveHost: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "destination_credentials_blocked" });
  });

  it("checks every resolved address to resist metadata aliases", async () => {
    await expect(
      validateDestinationUrl("https://friendly.example.test", {
        resolveHost: async () => [
          { address: "1.1.1.1", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: "destination_host_blocked" });
  });

  it("canonicalizes alternate numeric loopback host syntax before checking it", async () => {
    await expect(validateDestinationUrl("https://2130706433")).rejects.toMatchObject({
      code: "destination_host_blocked",
    });
  });

  it("enforces an exact host allowlist", async () => {
    await expect(
      validateDestinationUrl("https://sonarr.example.test", {
        allowedHosts: ["radarr.example.test"],
        resolveHost: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "destination_host_blocked" });
  });
});
