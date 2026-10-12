// The narration preference is read again for every passage. A saved zero
// must keep playback silent after a later passage or page reload.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const values = new Map();
globalThis.window = {
  localStorage: { getItem: (key) => values.get(key) ?? null },
};

const { readVolume } = await import("../src/app/campaigns/[campaignId]/useNarrationAudio.ts");
const key = "odm_tts_volume";

for (const [stored, expected] of [
  [null, 0.8],
  ["0", 0],
  ["0.35", 0.35],
  ["1.5", 1],
  ["-0.2", 0],
  ["NaN", 0.8],
]) {
  if (stored === null) values.delete(key);
  else values.set(key, stored);
  assert.equal(readVolume(), expected, `saved narration level ${stored}`);
}

console.log("test-narration-volume: saved zero, fallback, and bounds");
