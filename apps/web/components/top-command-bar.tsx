import type { ServiceStatus } from "../lib/dashboard-data";
import type { ThemePreference } from "../lib/theme";
import { ConnectionPulse } from "./connection-pulse";
import { DirectionalNavigationRegion } from "./directional-navigation-group";
import { GlobalSearchLoader } from "./global-search-loader";
import { ProfileMenuLoader } from "./profile-menu-loader";

export function TopCommandBar({
  connectionStatus,
  themePreference = "system",
}: {
  connectionStatus: ServiceStatus;
  themePreference?: ThemePreference;
}) {
  return (
    <DirectionalNavigationRegion as="header" axis="horizontal" className="top-command-bar">
      <GlobalSearchLoader />
      <div className="top-command-bar__actions" data-liquid-glass>
        <ConnectionPulse status={connectionStatus} />
        <ProfileMenuLoader initialPreference={themePreference} />
      </div>
    </DirectionalNavigationRegion>
  );
}
