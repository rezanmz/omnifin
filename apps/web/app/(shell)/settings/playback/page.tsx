import type { Metadata } from "next";
import { DEFAULT_PLAYBACK_PREFERENCES } from "@omnifin/contracts/playback";

import { PlaybackPreferencesPanel } from "../../../../components/playback-preferences-panel";
import "../../../../globals.css";

export const metadata: Metadata = { title: "Playback preferences" };

interface PlaybackPreferencesPageProperties {
  searchParams: Promise<{ "test-view"?: string | string[] }>;
}

export default async function PlaybackPreferencesPage({
  searchParams,
}: PlaybackPreferencesPageProperties) {
  const parameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const initialResponse =
    parameters["test-view"] === "ready"
      ? {
          networkClass: "home" as const,
          preferences: DEFAULT_PLAYBACK_PREFERENCES,
          revision: 0,
          updatedAt: null,
        }
      : undefined;
  return <PlaybackPreferencesPanel {...(initialResponse ? { initialResponse } : {})} />;
}
