import type { LibraryBrowseResponse, LibraryRemovalPreview } from "@omnifin/contracts/library";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

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

const client: MediaLibraryClient = {
  commitRemoval: async () => undefined as never,
  load: async () => ({}) as LibraryBrowseResponse,
  loadRemovalEligibility: async () => ({ snapshot: { csrfToken: "csrf-token" }, status: "ready" }),
  loadRemovalPreview: async () => preview,
};

const meta = {
  args: { client, media: { id: referenceId, title: preview.title } },
  component: LibraryRemovalAction,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 620, padding: 32 }}>
        <Story />
      </div>
    ),
  ],
  title: "Components/Library removal action",
} satisfies Meta<typeof LibraryRemovalAction>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
