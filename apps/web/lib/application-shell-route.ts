export const APPLICATION_PATHNAME_HEADER = "x-omnifin-pathname";

const PUBLIC_ROUTE_PREFIXES = ["/link", "/login", "/onboarding", "/recovery"] as const;

export function routeUsesApplicationShell(pathname: string) {
  return !PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
