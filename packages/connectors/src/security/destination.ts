import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ResolvedHostAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedHostAddress[]>;

export interface DestinationPolicy {
  allowInsecureHttp?: boolean;
  allowedHosts?: readonly string[];
  resolveHost?: HostResolver;
}

export type DestinationPolicyErrorCode =
  | "destination_invalid"
  | "destination_protocol_blocked"
  | "destination_credentials_blocked"
  | "destination_host_blocked"
  | "destination_unresolved";

export class DestinationPolicyError extends Error {
  readonly code: DestinationPolicyErrorCode;

  constructor(code: DestinationPolicyErrorCode, message: string) {
    super(message);
    this.name = "DestinationPolicyError";
    this.code = code;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "instance-data",
  "metadata",
  "metadata.azure.internal",
  "metadata.google",
  "metadata.google.internal",
]);

const BLOCKED_ADDRESSES = new BlockList();
BLOCKED_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ADDRESSES.addSubnet("192.0.0.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("192.0.2.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
BLOCKED_ADDRESSES.addSubnet("198.51.100.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("203.0.113.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("224.0.0.0", 4, "ipv4");
BLOCKED_ADDRESSES.addSubnet("240.0.0.0", 4, "ipv4");
BLOCKED_ADDRESSES.addAddress("100.100.100.200", "ipv4");
BLOCKED_ADDRESSES.addAddress("::", "ipv6");
BLOCKED_ADDRESSES.addAddress("::1", "ipv6");
BLOCKED_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
BLOCKED_ADDRESSES.addSubnet("ff00::", 8, "ipv6");
BLOCKED_ADDRESSES.addSubnet("2001:db8::", 32, "ipv6");
BLOCKED_ADDRESSES.addAddress("fd00:ec2::254", "ipv6");
BLOCKED_ADDRESSES.addAddress("fd20:ce::254", "ipv6");

function normalizeHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

export function isBlockedDestinationAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  const family = isIP(normalized);
  if (family === 4) return BLOCKED_ADDRESSES.check(normalized, "ipv4");
  if (family === 6) return BLOCKED_ADDRESSES.check(normalized, "ipv6");
  return true;
}

const defaultResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

export async function validateDestinationUrl(
  input: string | URL,
  policy: DestinationPolicy = {},
): Promise<URL> {
  return (await resolveDestinationUrl(input, policy)).url;
}

export interface ResolvedDestination {
  url: URL;
  addresses: readonly ResolvedHostAddress[];
}

export async function resolveDestinationUrl(
  input: string | URL,
  policy: DestinationPolicy = {},
): Promise<ResolvedDestination> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new DestinationPolicyError(
      "destination_invalid",
      "The connector destination is not a valid URL.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DestinationPolicyError(
      "destination_protocol_blocked",
      "The connector destination must use HTTP or HTTPS.",
    );
  }
  if (url.protocol === "http:" && policy.allowInsecureHttp !== true) {
    throw new DestinationPolicyError(
      "destination_protocol_blocked",
      "Plain HTTP requires explicit administrator approval.",
    );
  }
  if (url.username || url.password) {
    throw new DestinationPolicyError(
      "destination_credentials_blocked",
      "Credentials are not allowed in connector destination URLs.",
    );
  }
  if (url.hash) {
    throw new DestinationPolicyError(
      "destination_invalid",
      "Connector destination URLs cannot contain a fragment.",
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    BLOCKED_HOSTNAMES.has(hostname)
  ) {
    throw new DestinationPolicyError(
      "destination_host_blocked",
      "The connector destination host is blocked by policy.",
    );
  }

  if (policy.allowedHosts) {
    const allowedHosts = new Set(policy.allowedHosts.map(normalizeHostname));
    if (!allowedHosts.has(hostname)) {
      throw new DestinationPolicyError(
        "destination_host_blocked",
        "The connector destination host is not in the configured allowlist.",
      );
    }
  }

  if (isIP(hostname)) {
    if (isBlockedDestinationAddress(hostname)) {
      throw new DestinationPolicyError(
        "destination_host_blocked",
        "The connector destination address is blocked by policy.",
      );
    }
    return { url, addresses: [{ address: hostname, family: isIP(hostname) as 4 | 6 }] };
  }

  let addresses: readonly ResolvedHostAddress[];
  try {
    addresses = await (policy.resolveHost ?? defaultResolver)(hostname);
  } catch {
    throw new DestinationPolicyError(
      "destination_unresolved",
      "The connector destination host could not be resolved.",
    );
  }

  if (addresses.length === 0) {
    throw new DestinationPolicyError(
      "destination_unresolved",
      "The connector destination host did not resolve to an address.",
    );
  }
  const normalizedAddresses = addresses.map(({ address }) => {
    const normalizedAddress = address.toLowerCase().split("%")[0] ?? "";
    const family = isIP(normalizedAddress);
    return { address: normalizedAddress, family: family as 4 | 6 };
  });
  if (normalizedAddresses.some(({ address }) => isBlockedDestinationAddress(address))) {
    throw new DestinationPolicyError(
      "destination_host_blocked",
      "The connector destination resolved to a blocked address.",
    );
  }

  return { url, addresses: normalizedAddresses };
}
