import path from "node:path";

export function databaseMaintenanceLockPath(databaseUrl: string) {
  return `${path.resolve(databaseUrl)}.maintenance.lock`;
}

export function databaseQuiescenceMarkerPath(databaseUrl: string) {
  return `${path.resolve(databaseUrl)}.quiescent`;
}
