import { describe, expect, it } from "vitest";
import { clientNetworkGroup } from "../src/security/client-network.js";

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
