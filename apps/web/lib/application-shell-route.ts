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
