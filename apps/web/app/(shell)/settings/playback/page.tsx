import type { Metadata } from "next";

import { PlaybackPreferencesPanel } from "../../../../components/playback-preferences-panel";
import "../../../../globals.css";

export const metadata: Metadata = { title: "Playback preferences" };

export default function PlaybackPreferencesPage() {
  return <PlaybackPreferencesPanel />;
}
