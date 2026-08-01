import path from "node:path";
import { fileURLToPath } from "node:url";

const configuredTargets = process.argv.slice(2);
const defaultTargets = Object.freeze([
  "http://127.0.0.1:4000/healthz",
  "http://127.0.0.1:3000/healthz",
]);
const healthyStatuses = new Set(["ok", "ready"]);

export async function runHealthcheck(targets, dependencies = {}) {
  const request = dependencies.fetch ?? fetch;
  const selectedTargets = targets.length > 0 ? targets : defaultTargets;

  for (const target of selectedTargets) {
    let url;
    try {
      url = new URL(target);
    } catch {
      return 64;
    }

    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return 64;
    }

    try {
      const response = await request(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) continue;

      const body = await response.json();
      if (healthyStatuses.has(body?.status)) return 0;
    } catch {
      // Try the next local application role.
    }
  }

  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await runHealthcheck(configuredTargets));
}
