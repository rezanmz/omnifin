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
  "instance-data.ec2.internal",
  "metadata",
  "metadata.aws.internal",
  "metadata.azure.internal",
  "metadata.google",
  "metadata.google.internal",
]);

const BLOCKED_ADDRESSES = new BlockList();
// Addresses that are not valid general-purpose outbound destinations. Private-use
// IPv4 and unique-local IPv6 ranges are intentionally absent: self-hosted services
// commonly use them and plain HTTP is governed separately by explicit approval.
BLOCKED_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ADDRESSES.addSubnet("192.0.0.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("192.0.2.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("192.88.99.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
BLOCKED_ADDRESSES.addSubnet("198.51.100.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("203.0.113.0", 24, "ipv4");
BLOCKED_ADDRESSES.addSubnet("224.0.0.0", 4, "ipv4");
BLOCKED_ADDRESSES.addSubnet("240.0.0.0", 4, "ipv4");
BLOCKED_ADDRESSES.addAddress("100.100.100.200", "ipv4");
BLOCKED_ADDRESSES.addAddress("168.63.129.16", "ipv4");
BLOCKED_ADDRESSES.addAddress("::", "ipv6");
BLOCKED_ADDRESSES.addAddress("::1", "ipv6");
BLOCKED_ADDRESSES.addSubnet("::", 96, "ipv6");
BLOCKED_ADDRESSES.addSubnet("64:ff9b::", 96, "ipv6");
BLOCKED_ADDRESSES.addSubnet("64:ff9b:1::", 48, "ipv6");
BLOCKED_ADDRESSES.addSubnet("100::", 64, "ipv6");
BLOCKED_ADDRESSES.addSubnet("100:0:0:1::", 64, "ipv6");
BLOCKED_ADDRESSES.addSubnet("2001::", 23, "ipv6");
BLOCKED_ADDRESSES.addSubnet("2001:db8::", 32, "ipv6");
BLOCKED_ADDRESSES.addSubnet("2002::", 16, "ipv6");
BLOCKED_ADDRESSES.addSubnet("3fff::", 20, "ipv6");
BLOCKED_ADDRESSES.addSubnet("5f00::", 16, "ipv6");
BLOCKED_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
BLOCKED_ADDRESSES.addSubnet("fec0::", 10, "ipv6");
BLOCKED_ADDRESSES.addSubnet("ff00::", 8, "ipv6");
BLOCKED_ADDRESSES.addAddress("fd00:ec2::23", "ipv6");
BLOCKED_ADDRESSES.addAddress("fd00:ec2::254", "ipv6");
BLOCKED_ADDRESSES.addAddress("fd20:ce::254", "ipv6");

const IPV4_MAPPED_ADDRESSES = new BlockList();
IPV4_MAPPED_ADDRESSES.addSubnet("::ffff:0:0", 96, "ipv6");

function normalizeHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

export function isBlockedDestinationAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes("%")) return true;
  const family = isIP(normalized);
  if (family === 4) return BLOCKED_ADDRESSES.check(normalized, "ipv4");
  if (family === 6) {
    return (
      IPV4_MAPPED_ADDRESSES.check(normalized, "ipv6") || BLOCKED_ADDRESSES.check(normalized, "ipv6")
    );
  }
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

/**
 * Performs URL and literal-address checks without DNS or network access.
 * Configuration loaders can use this safely at startup; callers must still use
 * resolveDestinationUrl immediately before opening each request or following a redirect.
 */
export function validateDestinationUrlLiteral(
  input: string | URL,
  policy: Omit<DestinationPolicy, "resolveHost"> = {},
): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new DestinationPolicyError(
      "destination_invalid",
      "The outbound destination is not a valid URL.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DestinationPolicyError(
      "destination_protocol_blocked",
      "The outbound destination must use HTTP or HTTPS.",
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
      "Credentials are not allowed in outbound destination URLs.",
    );
  }
  if (url.hash) {
    throw new DestinationPolicyError(
      "destination_invalid",
      "Outbound destination URLs cannot contain a fragment.",
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
      "The outbound destination host is blocked by policy.",
    );
  }

  if (policy.allowedHosts) {
    const allowedHosts = new Set(policy.allowedHosts.map(normalizeHostname));
    if (!allowedHosts.has(hostname)) {
      throw new DestinationPolicyError(
        "destination_host_blocked",
        "The outbound destination host is not in the configured allowlist.",
      );
    }
  }

  if (isIP(hostname) && isBlockedDestinationAddress(hostname)) {
    throw new DestinationPolicyError(
      "destination_host_blocked",
      "The outbound destination address is blocked by policy.",
    );
  }

  return url;
}

export interface ResolvedDestination {
  url: URL;
  addresses: readonly ResolvedHostAddress[];
}

/**
 * Resolves and checks the destination for DNS rebinding resistance. Invoke this
 * immediately before every outbound request and repeat it for every redirect target.
 */
export async function resolveDestinationUrl(
  input: string | URL,
  policy: DestinationPolicy = {},
): Promise<ResolvedDestination> {
  const url = validateDestinationUrlLiteral(input, policy);
  const hostname = normalizeHostname(url.hostname);

  if (isIP(hostname)) {
    return { url, addresses: [{ address: hostname, family: isIP(hostname) as 4 | 6 }] };
  }

  let addresses: readonly ResolvedHostAddress[];
  try {
    addresses = await (policy.resolveHost ?? defaultResolver)(hostname);
  } catch {
    throw new DestinationPolicyError(
      "destination_unresolved",
      "The outbound destination host could not be resolved.",
    );
  }

  if (addresses.length === 0) {
    throw new DestinationPolicyError(
      "destination_unresolved",
      "The outbound destination host did not resolve to an address.",
    );
  }
  const normalizedAddresses = addresses.map(({ address }) => {
    const normalizedAddress = address.toLowerCase();
    const family = isIP(normalizedAddress);
    return { address: normalizedAddress, family: family as 4 | 6 };
  });
  if (
    normalizedAddresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) || isBlockedDestinationAddress(address),
    )
  ) {
    throw new DestinationPolicyError(
      "destination_host_blocked",
      "The outbound destination resolved to a blocked address.",
    );
  }

  return { url, addresses: normalizedAddresses };
}
