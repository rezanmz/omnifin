import type { LibraryBrowseResponse, LibraryRemovalPreview } from "@omnifin/contracts/library";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { MediaLibraryClient } from "../lib/media-library";
import { LibraryRemovalAction } from "./library-removal-action";

const referenceId = `media_${"r".repeat(22)}`;
const preview: LibraryRemovalPreview = {
  confirmation: {
    expectedTitle: "The Long Meridian",
    kind: "exact_title",
    recentAuthenticationRequired: true,
  },
  expiresAt: "2026-08-14T12:05:00.000Z",
  generatedAt: "2026-08-14T12:00:00.000Z",
  options: [
    {
      effects: {
        managerRecord: "retained",
        monitoring: "monitored",
        organizedFiles: "deleted",
        reacquisitionRisk: "possible",
        requestHistory: "retained",
        seedingCopies: "unchanged",
        storageReclamation: "may_be_delayed",
      },
      mode: "delete_files_keep_monitored",
    },
    {
      effects: {
        managerRecord: "retained",
        monitoring: "unmonitored",
        organizedFiles: "deleted",
        reacquisitionRisk: "prevented",
        requestHistory: "retained",
        seedingCopies: "unchanged",
        storageReclamation: "may_be_delayed",
      },
      mode: "delete_files_and_unmonitor",
    },
    {
      effects: {
        managerRecord: "removed",
        monitoring: "removed",
        organizedFiles: "deleted",
        reacquisitionRisk: "prevented",
        requestHistory: "retained",
        seedingCopies: "unchanged",
        storageReclamation: "may_be_delayed",
      },
      mode: "remove_from_radarr_and_delete_files",
    },
  ],
  previewId: `library_removal_preview_${"p".repeat(22)}`,
  referenceId,
  sizeBytes: 6_979_321_856,
  source: { kind: "managed", monitored: true, service: "radarr" },
  title: "The Long Meridian",
  year: 2026,
};

function client(overrides: Partial<MediaLibraryClient> = {}): MediaLibraryClient {
  return {
    commitRemoval: vi.fn(),
    load: async () => ({}) as LibraryBrowseResponse,
    loadRemovalEligibility: async () => ({
      snapshot: { csrfToken: "csrf-token" },
      status: "ready",
    }),
    loadRemovalPreview: async () => preview,
    ...overrides,
  };
}

describe("LibraryRemovalAction", () => {
  it("keeps the destructive confirmation hidden until narrow permission is established", async () => {
    const user = userEvent.setup();
    render(
      <LibraryRemovalAction client={client()} media={{ id: referenceId, title: preview.title }} />,
    );

    await user.click(await screen.findByRole("button", { name: "Review removal" }));

    expect(
      screen.getByText("Radarr remains monitored and can acquire this title again."),
    ).toBeVisible();
    const confirm = screen.getByRole("button", { name: "Remove title" });
    expect(confirm).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: `Confirm removal of ${preview.title}` }),
      preview.title,
    );
    expect(confirm).toBeEnabled();
  });

  it("does not render a removal affordance when the client denies the permission", async () => {
    render(
      <LibraryRemovalAction
        client={client({ loadRemovalEligibility: async () => ({ status: "forbidden" }) })}
        media={{ id: referenceId, title: preview.title }}
      />,
    );

    await expect.poll(() => screen.queryByRole("button", { name: "Review removal" })).toBeNull();
  });
});
