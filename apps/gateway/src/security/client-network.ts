import { isIP } from "node:net";

function ipv4TailHextets(token: string) {
  const octets = token.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return [];
  }
  return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
}

function ipv6Hextets(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  const halves = normalized.split("::");
  if (halves.length > 2) return [];
  const parseHalf = (half: string) => {
    if (!half) return [];
    const values: number[] = [];
    for (const token of half.split(":")) {
      if (token.includes(".")) values.push(...ipv4TailHextets(token));
      else values.push(Number.parseInt(token, 16));
    }
    return values;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0) return [];
  const values = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  return values.length === 8 && values.every((value) => value >= 0 && value <= 0xffff)
    ? values
    : [];
}

export function clientNetworkGroup(address: unknown) {
  if (typeof address !== "string" || address.length === 0) return "unattributed-client";
  const version = isIP(address);
  if (version === 4) return address.split(".").map(Number).join(".");
  if (version !== 6) return "unattributed-client";
  const values = ipv6Hextets(address);
  if (values.length !== 8) return "unattributed-client";
  if (values.slice(0, 5).every((value) => value === 0) && values[5] === 0xffff) {
    return [values[6]! >> 8, values[6]! & 0xff, values[7]! >> 8, values[7]! & 0xff].join(".");
  }
  return `${values
    .slice(0, 4)
    .map((value) => value.toString(16).padStart(4, "0"))
    .join(":")}::/64`;
}
