import type { CampaignMessage } from "@/lib/db/messages";
import type { CampaignLocation, MediaStatus } from "@/app/campaigns/[campaignId]/useCampaignStream";

// What a DM passage shows where its scene picture or its area's map would
// be, when that picture is not there yet: null for nothing, or the status
// MediaPlaceholder renders (none, queued or generating spin with a timer;
// failed is the short failure line).
//
// The live media_status wins while this session has one. Without it (a
// reload, a player who joined later) the durable record decides: an open
// request or a map render the place records as on its way still spins, and
// a recorded failure shows as the same line the live failure did. A place
// with no map and none on its way (taken back to the placeholder, or
// waiting on a render from before the place recorded it) shows nothing.
// Pure so scripts/test-media-failure.mjs can check what a stored message and
// place will show.
export type MediaSlot = { status?: MediaStatus };

const failedStatus = (kind: MediaStatus["kind"], reason: string, at: string): MediaStatus => ({
  kind,
  state: "failed",
  startedAt: at,
  reason,
});

export function scenePictureSlot(
  message: Pick<CampaignMessage, "generatedImage" | "imageRequest" | "createdAt">,
  live: MediaStatus | undefined,
): MediaSlot | null {
  const request = message.imageRequest;
  if (message.generatedImage || !request) {
    return null;
  }
  if (request.needed) {
    return { status: live };
  }
  if (request.failed) {
    return { status: live ?? failedStatus("image", request.failed, message.createdAt) };
  }
  return null;
}

export function locationMapSlot(
  location: Pick<CampaignLocation, "mapImage" | "mapFailed" | "mapPending"> | undefined,
  createdAt: string,
  live: MediaStatus | undefined,
): MediaSlot | null {
  if (!location || location.mapImage) {
    return null;
  }
  if (live) {
    return { status: live };
  }
  if (location.mapFailed) {
    return { status: failedStatus("map", location.mapFailed, createdAt) };
  }
  return location.mapPending ? {} : null;
}

// The placeholder that waits, as opposed to nothing or a failure line.
export function mediaSlotSpins(slot: MediaSlot | null): boolean {
  return slot !== null && slot.status?.state !== "failed";
}
