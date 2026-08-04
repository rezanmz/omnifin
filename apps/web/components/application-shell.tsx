import type { ReactNode } from "react";

import type { ServiceStatus } from "../lib/dashboard-data";
import { ApplicationShellContentEffect } from "./application-shell-content-effect";

const DEFAULT_ACCENT = "#8de9d5";
export { APPLICATION_SHELL_STATUS_ATTRIBUTE } from "./application-shell-contract";

export function ApplicationShellContent({
  accent = DEFAULT_ACCENT,
  children,
  displayProfile = "standard",
  status,
}: {
  accent?: string;
  children: ReactNode;
  displayProfile?: "standard" | "ten-foot";
  status: ServiceStatus;
}) {
  return (
    <>
      <ApplicationShellContentEffect
        accent={accent}
        displayProfile={displayProfile}
        status={status}
      />
      {children}
    </>
  );
}
