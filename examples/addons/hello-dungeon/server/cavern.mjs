// The map generator: a cave grown by cellular automaton from the request's
// seed. It returns the three things a map addon can hand back:
//
//   map       the ground the rules read: terrain characters, lights
//   backdrop  a top-down picture covering the whole map (PNG, JPEG or WebP)
//   view      data and files only this addon's board view reads (here, wall
//             heights and a .glb model of the walls)
//
// The server checks the terrain against the rules' alphabet and the map's
// size, stores the picture and the model, and adds the map to the library.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeBoxesGlb } from "./glb.mjs";
import { encodePng } from "./png.mjs";

function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function growCavern({ width, height, seed, openness, pools }) {
  const rand = random(seed);
  let cells = Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    return edge || rand() * 100 > openness ? "#" : ".";
  });
  for (let step = 0; step < 4; step += 1) {
    cells = cells.map((cell, index) => {
      const x = index % width;
      const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return "#";
      let walls = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx || dy) && cells[(y + dy) * width + (x + dx)] === "#") walls += 1;
        }
      }
      return walls >= 5 ? "#" : walls <= 3 ? "." : cell;
    });
  }
  if (pools) {
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index] === "." && rand() < 0.04) cells[index] = "~";
      else if (cells[index] === "." && rand() < 0.05) cells[index] = ",";
    }
  }
  return cells.join("");
}

const PALETTES = {
  slate: { wall: [70, 74, 86], floor: [148, 140, 122], water: [52, 92, 120], rubble: [118, 108, 92] },
  sandstone: { wall: [150, 110, 72], floor: [204, 178, 132], water: [60, 110, 130], rubble: [170, 140, 100] },
};

function paint(terrain, width, height, palette, seed) {
  const tile = 32;
  const rgba = new Uint8Array(width * tile * height * tile * 4);
  const rand = random(seed ^ 0x9e3779b9);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const char = terrain[y * width + x];
      const base = char === "#" ? palette.wall : char === "~" ? palette.water : char === "," ? palette.rubble : palette.floor;
      for (let py = 0; py < tile; py += 1) {
        for (let px = 0; px < tile; px += 1) {
          const grain = (rand() - 0.5) * 18;
          const offset = ((y * tile + py) * width * tile + (x * tile + px)) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            rgba[offset + channel] = Math.max(0, Math.min(255, base[channel] + grain));
          }
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  return encodePng(width * tile, height * tile, rgba);
}

export async function generateCavern(args, ctx, settings) {
  const { width, height, seed, name } = args.request;
  ctx.progress(0, 3, "Growing the cave");
  const terrain = growCavern({ width, height, seed, openness: Number(args.options.openness ?? 55), pools: args.options.pools !== false });
  const rand = random(seed + 7);
  const heights = [...terrain].map((char) => (char === "#" ? 1 + Math.round(rand() * 2) : 0));
  const lights = [];
  for (let index = 0; index < terrain.length && lights.length < 3; index += 1) {
    if (terrain[index] === "." && rand() < 0.02) {
      lights.push({ x: index % width, y: Math.floor(index / width), brightRadius: 2, dimRadius: 4 });
    }
  }
  if (ctx.signal.aborted) throw new Error("Cancelled.");

  ctx.progress(1, 3, "Painting the picture");
  const palette = PALETTES[settings.wallStyle] ?? PALETTES.slate;
  await writeFile(path.join(args.outputDir, "cavern.png"), paint(terrain, width, height, palette, seed));

  ctx.progress(2, 3, "Building the model");
  const boxes = [];
  for (let index = 0; index < terrain.length; index += 1) {
    if (heights[index] > 0) boxes.push({ x: index % width, z: Math.floor(index / width), height: heights[index] });
  }
  await writeFile(path.join(args.outputDir, "cavern.glb"), encodeBoxesGlb(boxes));

  ctx.progress(3, 3, "Done");
  return {
    map: {
      name: `${name}`,
      width,
      height,
      terrain,
      theme: "cave",
      ambient: args.request.ambient,
      outdoors: false,
      lights,
      notes: args.request.summary ? `Asked for: ${args.request.summary}` : "",
      tags: ["cave", "hello-dungeon"],
    },
    backdrop: { file: "cavern.png" },
    view: { data: { heights, palette: settings.wallStyle ?? "slate" }, files: ["cavern.glb"] },
    notes: [`${boxes.length} wall squares, ${lights.length} light${lights.length === 1 ? "" : "s"}.`],
  };
}
