import type { LibraryRemovalPreview } from "@omnifin/contracts/library";
import { describe, expect, it, vi } from "vitest";

import { libraryDemoPrincipal } from "./library-care-demo";
import { MediaLibraryClientError, mediaLibraryClient } from "./media-library";

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

describe("media library removal client", () => {
  it("loads only the exact opaque title preview", async () => {
    const fetchMock = vi.fn(async () => Response.json(preview));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mediaLibraryClient.loadRemovalPreview!(referenceId)).resolves.toEqual(preview);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/media/library/${referenceId}/removal-preview`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("does not submit destructive mutations without the narrow permission", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        csrfToken: "library_removal_csrf_0123456789abcdefghijklmnop",
        principal: libraryDemoPrincipal,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      mediaLibraryClient.commitRemoval!(referenceId, {
        confirmationTitle: preview.title,
        mode: "delete_files_keep_monitored",
        previewId: preview.previewId,
      }),
    ).rejects.toEqual(
      new MediaLibraryClientError(
        "forbidden",
        "permission_denied",
        "Your account cannot remove library titles.",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
