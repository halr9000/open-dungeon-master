import { generateStoryImage } from "@/lib/image-generate";
import { clearLocationMapFailed, getLocation, setLocationMap, setLocationMapFailed } from "@/lib/db/locations";
import { presetFor } from "@/lib/worlds/preset";
import { publishPersisted } from "@/lib/events";
import { pictureFailureReason, publishMediaStatus } from "@/lib/dm/images";
import { enqueueMediaJob } from "@/lib/media-queue";
import { toEnglishForImage } from "@/lib/image-english";
import type { Campaign } from "@/lib/db/campaigns";

// The place as stored, to every client: its map failure is part of the row.
function publishLocation(campaignId: string, locationId: string) {
  const location = getLocation(locationId);
  if (location) {
    publishPersisted(campaignId, "location_updated", { location });
  }
}

// Renders a top-down illustrated map of a location on the serial media
// queue (never blocks narration; one GPU job at a time machine-wide).
//
// A failure is recorded on the place as well as announced: the
// "Charting the area..." placeholder under the narration reads the place,
// so after a reload it would otherwise wait for a map that is not coming.
// Queuing a new render clears it again.
export function enqueueLocationMap(campaign: Campaign, locationId: string) {
  const preset = presetFor(campaign.gameSettings);
  if (clearLocationMapFailed(locationId)) {
    publishLocation(campaign.id, locationId);
  }
  publishMediaStatus(campaign.id, "map", locationId, "queued");
  return enqueueMediaJob(`map ${locationId}`, async () => {
    const location = getLocation(locationId);
    if (!location) {
      return;
    }
    publishMediaStatus(campaign.id, "map", locationId, "generating");
    try {
      const place = await toEnglishForImage(campaign, {
        name: location.name,
        layout: location.layoutDescription,
      });
      const prompt = [
        "top-down illustrated game map",
        preset.mapStyle,
        "labeled areas, clear pathways, no text captions",
        place.name,
        place.layout,
      ]
        .filter(Boolean)
        .join(", ");
      const image = await generateStoryImage(campaign.settings, {
        prompt,
        mode: campaign.settings.imageMode,
        aspect: "landscape",
      });
      if (!setLocationMap(location.id, image)) {
        return;
      }
      publishPersisted(campaign.id, "location_map_ready", {
        locationId: location.id,
        image,
      });
    } catch (error) {
      const reason = pictureFailureReason(error);
      publishMediaStatus(campaign.id, "map", locationId, "failed", reason);
      if (setLocationMapFailed(locationId, reason)) {
        publishLocation(campaign.id, locationId);
      }
      throw error;
    }
  });
}
