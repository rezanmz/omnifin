const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEndHeaders(headers) {
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  const connection = headers.connection;
  const connectionValues = Array.isArray(connection)
    ? connection
    : connection === undefined
      ? []
      : [connection];
  for (const value of connectionValues) {
    for (const name of value.split(",")) {
      blocked.add(name.trim().toLowerCase());
    }
  }

  const forwarded = new Map();
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (value !== undefined && !blocked.has(normalizedName)) {
      forwarded.set(normalizedName, value);
    }
  }
  return forwarded;
}

export function forwardedRequestHeaders(headers, host, forwardedPort, remoteAddress) {
  const forwarded = endToEndHeaders(headers);
  forwarded.delete("forwarded");
  forwarded.delete("host");
  forwarded.delete("x-real-ip");
  for (const name of forwarded.keys()) {
    if (name.startsWith("x-forwarded-")) forwarded.delete(name);
  }
  forwarded.set("host", host);
  forwarded.set("x-forwarded-for", remoteAddress);
  forwarded.set("x-forwarded-host", host);
  forwarded.set("x-forwarded-port", forwardedPort);
  forwarded.set("x-forwarded-proto", "https");
  return forwarded;
}

export function forwardedResponseHeaders(headers) {
  return endToEndHeaders(headers);
}
