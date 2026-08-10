import type { DiscoveryAvailability, DiscoveryMediaRecordState } from "./discovery.js";

export function isDiscoveryMediaRequestable(input: {
  availability: DiscoveryAvailability;
  mediaRecordState: DiscoveryMediaRecordState;
}) {
  return (
    input.mediaRecordState !== "unknown" &&
    (input.availability === "partial" ||
      input.availability === "unavailable" ||
      (input.availability === "unknown" && input.mediaRecordState === "absent"))
  );
}
