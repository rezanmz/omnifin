"use client";

import { demoDashboard } from "../lib/dashboard-data";
import { DashboardSections } from "./dashboard-sections";

export function DemoDashboardSections() {
  return (
    <DashboardSections
      calendar={demoDashboard.calendar}
      continueWatching={demoDashboard.continueWatching}
      discovery={demoDashboard.discovery}
      operations={demoDashboard.operations}
    />
  );
}
