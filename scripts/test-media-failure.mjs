// A scene picture or a map that failed stops spinning after a reload. The
// failure used to be only an ephemeral media_status, while the placeholder
// under the narration read durable state: an open image request, or a place
// with no map. So a reload, or a player who joined later, watched "Illustrating
// the scene..." or "Charting the area..." count up forever. Here, offline,
// with the scripted fake agent (HARNESS_FAKE) as the picture backend: it
// declines, the stored message and place carry the reason, the placeholder
// the passage shows from them (src/app/campaigns/[campaignId]/mediaSlot.ts)
// is the failure line, and a later picture that does paint clears it. A map
// render a restart dropped from the in-memory queue fails the same way when
// the next process starts, and a place with no render on its way shows
// nothing at all.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-media-failure-"));
const scriptFile = path.join(dir, "fake-script.json");
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.HARNESS_FAKE = "1";
process.env.HARNESS_FAKE_SCRIPT = scriptFile;
const setScript = (turns) => fs.writeFileSync(scriptFile, JSON.stringify(turns));
const DECLINE = [[{ text: "I can't help draw that scene." }]];
const PAINT = [[{ paint: [48, 32] }, { text: "done" }]];
// Pictures land in <cwd>/public/generated.
const home = process.cwd();
process.chdir(dir);
register("./lib/register-alias.mjs", new URL(`file://${path.join(home, "scripts", "x.mjs")}`));

const { saveGlobalConfig } = await import("../src/lib/db/app-settings.ts");
const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign, getCampaignById, allocateSeq } = await import("../src/lib/db/campaigns.ts");
const { insertCampaignMessage, getCampaignMessage } = await import("../src/lib/db/messages.ts");
const { upsertCurrentLocation, getLocation, listLocations, setLocationMap } = await import("../src/lib/db/locations.ts");
const { fulfillMessageImage, handleGenerateImage } = await import("../src/lib/dm/images.ts");
const { enqueueLocationMap } = await import("../src/lib/dm/maps.ts");
const { enqueueMediaJob } = await import("../src/lib/media-queue.ts");
const { recoverDmAfterRestart, RESTART_MAP_FAILED } = await import("../src/lib/dm/restart-recovery.ts");
const { subscribe } = await import("../src/lib/events.ts");
const { imageVariantsSettled } = await import("../src/lib/image-variants.ts");
const { scenePictureSlot, locationMapSlot, mediaSlotSpins } = await import(
  "../src/app/campaigns/[campaignId]/mediaSlot.ts"
);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

// What the table was sent while fn ran, by event name.
async function eventsDuring(campaignId, fn) {
  const events = [];
  const off = subscribe(campaignId, (chunk) => {
    const type = /event: (\S+)/.exec(chunk)?.[1];
    if (type) events.push({ type, data: JSON.parse(/data: (.*)/.exec(chunk)?.[1] ?? "{}") });
  });
  try {
    await fn();
  } finally {
    off();
  }
  return events;
}
// Everything already on the picture queue has run.
const queueDrained = () => enqueueMediaJob(`drain ${Math.random()}`, async () => {});
// The failed backend's error is logged by the queue; keep the run readable.
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

try {
  saveGlobalConfig({
    harness: { id: "codex", images: "native", imagesVerifiedAt: new Date().toISOString() },
    text: { provider: "harness" },
    images: { defaultBackend: "harness" },
  });
  const lead = createUser("rowan", "x");
  const created = createCampaign(lead.id, {
    title: "The Drowned Ford",
    description: "",
    theme: "low fantasy",
    maxPlayers: 4,
    startingLevel: 3,
    difficulty: "normal",
    gameSettings: { tableLanguage: "english" },
  });
  const campaign = getCampaignById(created.id);
  assert.equal(campaign.settings.imageBackend, "harness");

  const request = { needed: true, prompt: "A river crossing at dusk", mode: "fast", aspect: "landscape", reason: "new area" };
  const narrate = (extra) =>
    insertCampaignMessage({
      campaignId: campaign.id,
      seq: allocateSeq(campaign.id),
      authorType: "dm",
      content: "The ford is swollen with rain.",
      speech: [],
      ...extra,
    });

  await test("a stored request from before this change still spins, as it did", () => {
    const slot = scenePictureSlot({ imageRequest: request, createdAt: "2026-01-01T00:00:00.000Z" }, undefined);
    assert.equal(mediaSlotSpins(slot), true);
    assert.equal(scenePictureSlot({ imageRequest: { ...request, needed: false }, createdAt: "x" }, undefined), null, "a dropped request shows nothing");
  });

  const message = narrate({ imageRequest: request });

  await test("a scene picture the backend declines is closed with its reason, and the passage stops spinning", async () => {
    assert.equal(mediaSlotSpins(scenePictureSlot(getCampaignMessage(message.id), undefined)), true);
    setScript(DECLINE);
    const events = await eventsDuring(campaign.id, () =>
      quietly(() => fulfillMessageImage(campaign.id, message.id, request, campaign.settings)),
    );
    const live = events.find((event) => event.type === "media_status" && event.data.state === "failed");
    assert.ok(live, "the table was told live, as before");
    assert.match(live.data.reason, /answered without a picture: "I can't help draw that scene\."/);

    const stored = getCampaignMessage(message.id);
    assert.equal(stored.generatedImage, undefined);
    assert.equal(stored.imageRequest.needed, false);
    assert.equal(stored.imageRequest.failed, live.data.reason, "the stored reason is the live one");
    assert.equal(stored.imageRequest.prompt, request.prompt, "the rest of the request is kept");

    // A reload: no live status, only the stored message.
    const slot = scenePictureSlot(stored, undefined);
    assert.equal(mediaSlotSpins(slot), false, "the placeholder would spin after a reload");
    assert.deepEqual([slot.status.state, slot.status.reason], ["failed", live.data.reason]);
    // Open clients get the closed request too.
    const updated = events.find((event) => event.type === "message_updated");
    assert.equal(updated?.data.message.imageRequest.failed, live.data.reason);
  });

  await test("asking for the picture again opens a fresh request, and one that paints clears the failure", async () => {
    setScript(PAINT);
    const result = handleGenerateImage(getCampaignById(campaign.id), JSON.stringify({ prompt: "The ford at dusk" }));
    assert.equal(result.illustrating, message.id);
    const asked = getCampaignMessage(message.id);
    assert.equal(asked.imageRequest.needed, true);
    assert.equal(asked.imageRequest.failed, undefined);
    assert.equal(mediaSlotSpins(scenePictureSlot(asked, undefined)), true, "a picture on its way spins");
    await queueDrained();
    const painted = getCampaignMessage(message.id);
    assert.ok(painted.generatedImage, "the picture was painted");
    assert.equal(scenePictureSlot(painted, undefined), null);
  });

  const location = upsertCurrentLocation({ campaignId: campaign.id, name: "The Drowned Ford", layoutDescription: "a river crossing" });
  const arrival = narrate({ locationId: location.id });

  await test("a map the backend declines is recorded on the place, and the narration stops charting", async () => {
    assert.equal(locationMapSlot(getLocation(location.id), arrival.createdAt, undefined), null, "a place nobody asked to draw charts");
    setScript(DECLINE);
    const events = await eventsDuring(campaign.id, () => quietly(() => enqueueLocationMap(getCampaignById(campaign.id), location.id)));
    const live = events.find((event) => event.type === "media_status" && event.data.state === "failed");
    assert.ok(live, "the table was told live, as before");

    const stored = getLocation(location.id);
    assert.equal(stored.mapImage, null);
    assert.equal(stored.mapFailed, live.data.reason);
    assert.equal(listLocations(campaign.id).find((entry) => entry.id === location.id).mapFailed, live.data.reason, "a reload's list carries it");
    const slot = locationMapSlot(stored, arrival.createdAt, undefined);
    assert.equal(mediaSlotSpins(slot), false, "the map placeholder would spin after a reload");
    assert.deepEqual([slot.status.state, slot.status.reason], ["failed", live.data.reason]);
    const updates = events.filter((event) => event.type === "location_updated").map((event) => event.data.location);
    assert.deepEqual(updates.map((place) => [place.mapPending, place.mapFailed]), [[true, null], [false, live.data.reason]], "open clients get the place as stored, waiting and then failed");
  });

  await test("a redraw clears the failure while it waits, and the map it paints shows under the narration", async () => {
    setScript(PAINT);
    const drawn = enqueueLocationMap(getCampaignById(campaign.id), location.id);
    const waiting = getLocation(location.id);
    assert.equal(waiting.mapFailed, null, "a queued redraw still reads as failed after a reload");
    assert.equal(waiting.mapPending, true);
    assert.equal(mediaSlotSpins(locationMapSlot(waiting, arrival.createdAt, undefined)), true);
    await drawn;
    const mapped = getLocation(location.id);
    assert.equal(mapped.mapImage?.width, 48, "the map was painted");
    assert.equal(mapped.mapFailed, null);
    assert.equal(locationMapSlot(mapped, arrival.createdAt, undefined), null, "the map shows, not a placeholder");
  });

  await test("a redraw that fails keeps the map the place already had", async () => {
    const before = getLocation(location.id).mapImage;
    setScript(DECLINE);
    await quietly(() => enqueueLocationMap(getCampaignById(campaign.id), location.id));
    const after = getLocation(location.id);
    assert.deepEqual(after.mapImage, before);
    assert.equal(after.mapFailed, null);
    assert.equal(after.mapPending, false, "a place with a map is never waiting on one");
  });

  await test("a map taken back to the placeholder leaves the narration quiet", () => {
    setLocationMap(location.id, null);
    const cleared = getLocation(location.id);
    assert.deepEqual([cleared.mapImage, cleared.mapFailed, cleared.mapPending], [null, null, false]);
    assert.equal(locationMapSlot(cleared, arrival.createdAt, undefined), null, "it charts a map nobody is drawing");
  });

  await test("a map render a restart dropped fails when the next process starts, and the narration says why", async () => {
    const landing = upsertCurrentLocation({ campaignId: campaign.id, name: "Marrow's Crossing", layoutDescription: "a ferry landing" });
    const crossing = narrate({ locationId: landing.id });
    // Another picture holds the queue, so the map is still waiting when the
    // process stops.
    void enqueueMediaJob("a render that outlives the process", () => new Promise(() => {}));
    void enqueueLocationMap(getCampaignById(campaign.id), landing.id);
    assert.equal(getLocation(landing.id).mapPending, true);
    assert.equal(mediaSlotSpins(locationMapSlot(getLocation(landing.id), crossing.createdAt, undefined)), true);

    // The restart: the queue and the recovery flag lived in memory.
    for (const key of ["__odmMediaQueues", "__odmMediaWaiting", "__odmDmRecovered"]) {
      globalThis[key] = undefined;
    }
    const recovery = await quietly(() => recoverDmAfterRestart());
    assert.equal(recovery.maps, 1, "only the place still waiting is touched");

    const after = getLocation(landing.id);
    assert.deepEqual([after.mapImage, after.mapFailed, after.mapPending], [null, RESTART_MAP_FAILED, false]);
    const slot = locationMapSlot(after, crossing.createdAt, undefined);
    assert.equal(mediaSlotSpins(slot), false, "the narration charts a map that is not coming");
    assert.deepEqual([slot.status.state, slot.status.reason], ["failed", RESTART_MAP_FAILED]);
    assert.equal(getLocation(location.id).mapFailed, null, "a place with nothing on its way is left alone");

    // The redraw the failure line points at still paints.
    setScript(PAINT);
    await enqueueLocationMap(getCampaignById(campaign.id), landing.id);
    assert.ok(getLocation(landing.id).mapImage, "the redraw after the restart was not painted");
  });

  console.log(`\n${passed} media failure checks passed`);
} finally {
  await imageVariantsSettled();
  process.chdir(home);
  removeTempDir(dir);
}
