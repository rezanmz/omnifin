import path from "node:path";

export function databaseMaintenanceLockPath(databaseUrl: string) {
  return `${path.resolve(databaseUrl)}.maintenance.lock`;
}
