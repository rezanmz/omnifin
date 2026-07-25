import { describe, expect, it } from "vitest";

import {
  isBlockedDestinationAddress,
  resolveDestinationUrl,
  validateDestinationUrl,
  validateDestinationUrlLiteral,
} from "../src/security/destination.js";
import { publicResolver } from "./helpers/mock-fetch.js";

describe("outbound destination policy", () => {
  it("checks URL syntax and literal addresses synchronously without resolving hostnames", () => {
    expect(validateDestinationUrlLiteral("https://jellyfin.example.test/base/").href).toBe(
      "https://jellyfin.example.test/base/",
    );
    expect(() =>
      validateDestinationUrlLiteral("https://169.254.169.254/latest/meta-data"),
    ).toThrowError(expect.objectContaining({ code: "destination_host_blocked" }));
    expect(() => validateDestinationUrlLiteral("https://[fe80::1]/status")).toThrowError(
      expect.objectContaining({ code: "destination_host_blocked" }),
    );
  });

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

  it("allows ordinary self-hosted private destinations", async () => {
    expect(
      validateDestinationUrlLiteral("http://10.20.30.40:8096", {
        allowInsecureHttp: true,
      }).href,
    ).toBe("http://10.20.30.40:8096/");
    expect(
      validateDestinationUrlLiteral("http://100.64.1.20:8096", {
        allowInsecureHttp: true,
      }).href,
    ).toBe("http://100.64.1.20:8096/");
    expect(validateDestinationUrlLiteral("https://[fd12:3456:789a::20]:8920/").hostname).toBe(
      "[fd12:3456:789a::20]",
    );

    await expect(
      resolveDestinationUrl("https://jellyfin.home.example", {
        resolveHost: async () => [{ address: "192.168.50.20", family: 4 }],
      }),
    ).resolves.toMatchObject({
      addresses: [{ address: "192.168.50.20", family: 4 }],
    });
  });

  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::c0a8:1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:c0a8:1",
    "fd00:ec2::23",
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

  it.each(["169.254.169.254", "fe80::20", "::ffff:a9fe:a9fe", "ff02::1"])(
    "rejects a hostname when any DNS answer is denied (%s)",
    async (deniedAddress) => {
      await expect(
        resolveDestinationUrl("https://friendly.example.test", {
          resolveHost: async () => [
            { address: "192.168.1.20", family: 4 },
            {
              address: deniedAddress,
              family: deniedAddress.includes(":") ? 6 : 4,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "destination_host_blocked" });
    },
  );

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
