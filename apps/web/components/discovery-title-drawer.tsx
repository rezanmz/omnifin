"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { mediaLibraryClient, sameOriginMediaPath } from "../lib/media-library";
import type { MediaLibraryClient } from "../lib/media-library";
import type { PlaybackClient } from "../lib/playback";
import { LibraryTitleDrawer } from "./library-title-drawer";
import type { LibraryTitleSelection, PlayableLibrarySelection } from "./library-title-drawer";
import { MediaDetailDrawer } from "./media-detail-drawer";
import type { MediaDetailDrawerProperties } from "./media-detail-drawer";

const TheaterPlayer = dynamic(
  () => import("./theater-player").then((module) => module.TheaterPlayer),
  { ssr: false },
);

type DiscoveryTitleDrawerProperties = Omit<MediaDetailDrawerProperties, "onOpenOwnedLibrary"> & {
  libraryClient?: MediaLibraryClient;
  playbackClient?: PlaybackClient;
};

function OwnedTitleTheater({
  onClose,
  playbackClient,
  selection,
}: {
  onClose: () => void;
  playbackClient?: PlaybackClient;
  selection: PlayableLibrarySelection;
}) {
  const artworkPath = sameOriginMediaPath(
    selection.media.artwork.backdropPath ?? selection.media.artwork.posterPath,
  );
  return (
    <TheaterPlayer
      {...(playbackClient === undefined ? {} : { client: playbackClient })}
      media={{
        accent: selection.media.artwork.accentColor ?? "#6f8d84",
        ...(artworkPath === undefined ? {} : { artworkPath }),
        eyebrow:
          selection.media.subtitle ??
          [
            selection.media.year,
            selection.media.runtimeMinutes ? `${selection.media.runtimeMinutes} min` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        id: selection.media.id,
        ...(selection.mediaSources === undefined ? {} : { mediaSources: selection.mediaSources }),
        positionSeconds: selection.startPositionSeconds ?? selection.playback.positionSeconds,
        ...(selection.sourceReferenceId === undefined
          ? {}
          : { sourceReferenceId: selection.sourceReferenceId }),
        title: selection.media.title,
      }}
      onClose={onClose}
      startWhenReady
    />
  );
}

export function DiscoveryTitleDrawer({
  libraryClient = mediaLibraryClient,
  onOpenChange,
  playbackClient,
  ...properties
}: DiscoveryTitleDrawerProperties) {
  const [ownedSelection, setOwnedSelection] = useState<LibraryTitleSelection | null>(null);
  const [playing, setPlaying] = useState<PlayableLibrarySelection | null>(null);

  function close() {
    setOwnedSelection(null);
    onOpenChange(false);
  }

  return (
    <>
      {ownedSelection ? (
        <LibraryTitleDrawer
          client={libraryClient}
          onClose={close}
          onPlay={setPlaying}
          open
          selection={ownedSelection}
        />
      ) : (
        <MediaDetailDrawer
          {...properties}
          onOpenChange={onOpenChange}
          onOpenOwnedLibrary={setOwnedSelection}
        />
      )}
      {playing ? (
        <OwnedTitleTheater
          onClose={() => setPlaying(null)}
          {...(playbackClient === undefined ? {} : { playbackClient })}
          selection={playing}
        />
      ) : null}
    </>
  );
}
