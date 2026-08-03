import type { ReactNode } from "react";

import { ApplicationShellFrame } from "../../components/application-shell-frame";
import { readThemePreference } from "../../lib/theme-server";
import "./shell.css";

export default async function AuthenticatedApplicationLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const preference = await readThemePreference();
  return <ApplicationShellFrame themePreference={preference}>{children}</ApplicationShellFrame>;
}
