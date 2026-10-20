// The setup step (the manifest's setup.tool): run once per installed
// version, before the addon is used, with the folders it may fill. A real
// addon downloads its models or checks its tools here; this one paints the
// floor texture its board view loads from its asset library, to show the
// path end to end: what is written to publicDir is served at
// <assetsUrl><name> to every board view of this addon.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodePng } from "./png.mjs";

const SIZE = 64;

// A worn flagstone, light grey on transparent, for the view to lay over
// each floor square at low opacity.
function flagstone() {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const joint = x % 32 < 2 || y % 32 < 2 || (y < 32 ? false : (x + 16) % 32 < 2);
      const grain = Math.round(random() * 40);
      const index = (y * SIZE + x) * 4;
      rgba[index] = joint ? 20 : 200 + grain / 2;
      rgba[index + 1] = joint ? 20 : 196 + grain / 2;
      rgba[index + 2] = joint ? 24 : 188 + grain / 2;
      rgba[index + 3] = joint ? 140 : 40 + grain;
    }
  }
  return encodePng(SIZE, SIZE, rgba);
}

// `settings` are the admin's (ODM_ADDON_SETTINGS). floorTexture is marked
// affectsSetup in addon.json, so changing it runs this again.
export async function runSetup(args, ctx, settings) {
  await mkdir(args.publicDir, { recursive: true });
  const file = path.join(args.publicDir, "flagstone.png");
  if (settings.floorTexture === "none") {
    await rm(file, { force: true });
    return { ok: true, wrote: [] };
  }
  ctx.progress(0, 2, "Painting the floor texture");
  await writeFile(file, flagstone());
  ctx.progress(2, 2, "Done");
  return { ok: true, wrote: ["flagstone.png"] };
}
