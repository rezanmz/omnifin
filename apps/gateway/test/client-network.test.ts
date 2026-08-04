import { describe, expect, it } from "vitest";
import { clientNetworkClass, clientNetworkGroup } from "../src/security/client-network.js";

describe("client network grouping", () => {
  it("normalizes direct and mapped IPv4 without merging unrelated addresses", () => {
    expect(clientNetworkGroup("192.0.2.44")).toBe("192.0.2.44");
    expect(clientNetworkGroup("::ffff:192.0.2.44")).toBe("192.0.2.44");
    expect(clientNetworkGroup("::ffff:c000:022c")).toBe("192.0.2.44");
    expect(clientNetworkGroup("192.0.2.45")).toBe("192.0.2.45");
  });

  it("groups native IPv6 by /64 and collapses invalid identities", () => {
    expect(clientNetworkGroup("2001:db8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(clientNetworkGroup("2001:0db8:0001:0002:ffff::abcd")).toBe("2001:0db8:0001:0002::/64");
    expect(clientNetworkGroup("2001:db8:1:3::1")).toBe("2001:0db8:0001:0003::/64");
    expect(clientNetworkGroup(undefined)).toBe("unattributed-client");
    expect(clientNetworkGroup("malformed-client-address")).toBe("unattributed-client");
  });
});

describe("clientNetworkClass", () => {
  it("recognizes only local, private, and link-local client addresses as home", () => {
    for (const address of [
      "127.0.0.1",
      "10.2.3.4",
      "172.20.4.8",
      "192.168.1.7",
      "169.254.4.2",
      "::1",
      "fd12:3456::9",
      "fe80::1",
      "::ffff:192.168.1.7",
    ]) {
      expect(clientNetworkClass(address)).toBe("home");
    }
    for (const address of ["192.0.2.44", "8.8.8.8", "2001:db8::1", undefined, "invalid"]) {
      expect(clientNetworkClass(address)).toBe("remote");
    }
  });
});
