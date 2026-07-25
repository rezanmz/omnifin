const configuredTargets = process.argv.slice(2);
const targets =
  configuredTargets.length > 0
    ? configuredTargets
    : ["http://127.0.0.1:4000/healthz", "http://127.0.0.1:3000/healthz"];

for (const target of targets) {
  let url;
  try {
    url = new URL(target);
  } catch {
    process.exit(64);
  }

  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    process.exit(64);
  }

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) continue;

    const body = await response.json();
    if (body?.status === "ok") process.exit(0);
  } catch {
    // Try the next local application role.
  }
}

process.exit(1);
