export const APPLICATION_PATHNAME_HEADER = "x-omnifin-pathname";

const PUBLIC_ROUTE_PREFIXES = ["/link", "/login", "/onboarding", "/recovery"] as const;

export type ApplicationDestination =
  "calendar" | "discover" | "library" | "operations" | "requests" | "settings";

export function applicationDestinationForPath(pathname: string): ApplicationDestination | null {
  if (pathname === "/") return "discover";
  if (pathname === "/library" || pathname.startsWith("/library/")) return "library";
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) return "calendar";
  if (pathname === "/operations/requests" || pathname.startsWith("/operations/requests/")) {
    return "requests";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/operations" || pathname.startsWith("/operations/")) return "operations";
  return null;
}

export function routeUsesApplicationShell(pathname: string) {
  return !PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
