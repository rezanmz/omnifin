"use client";

import type { ComponentType } from "react";
import { useState } from "react";

import type { ThemePreference } from "../lib/theme";

type ProfileControlsComponent = ComponentType<{ initialPreference: ThemePreference }>;

let profileMenuPromise: Promise<ProfileControlsComponent> | undefined;

function loadProfileMenu() {
  profileMenuPromise ??= Promise.all([import("./profile-menu"), import("./theme-provider")]).then(
    ([profileModule, themeModule]) =>
      function LoadedProfileControls({
        initialPreference,
      }: {
        initialPreference: ThemePreference;
      }) {
        return (
          <themeModule.ThemeProvider initialPreference={initialPreference}>
            <profileModule.ProfileMenu initialOpen />
          </themeModule.ThemeProvider>
        );
      },
  );
  return profileMenuPromise;
}

export function ProfileMenuLoader({ initialPreference }: { initialPreference: ThemePreference }) {
  const [Controls, setControls] = useState<ProfileControlsComponent | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  if (Controls) return <Controls initialPreference={initialPreference} />;

  return (
    <div className="profile-menu">
      <button
        aria-busy={loading || undefined}
        aria-expanded="false"
        aria-haspopup="dialog"
        aria-label={loadFailed ? "Retry opening profile menu" : "Open profile menu"}
        className="user-avatar"
        data-directional-item
        onClick={() => {
          setLoadFailed(false);
          setLoading(true);
          void loadProfileMenu()
            .then((Component) => setControls(() => Component))
            .catch(() => {
              profileMenuPromise = undefined;
              setLoadFailed(true);
              setLoading(false);
            });
        }}
        type="button"
      >
        <span aria-hidden="true">RN</span>
      </button>
      {loadFailed ? (
        <span className="sr-only" role="status">
          Profile controls could not be loaded. Activate the profile button to retry.
        </span>
      ) : null}
    </div>
  );
}
