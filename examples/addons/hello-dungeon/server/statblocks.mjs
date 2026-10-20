// The workshop importer: a text file of sections becomes a workshop bundle.
//
//   # Monster: Bog Hag
//   AC 15, HP 52, CR 3, Size Medium, Type fey, Speed 30 ft.
//   Attack: Claws +5, 2d6+3 slashing
//   Trait: Mimicry. The hag can mimic animal sounds and voices.
//   A gaunt figure draped in weed, who trades in names.
//
//   # Lore: The Drowned Mill
//   The mill stopped turning the night the river ran red.
//
// A real importer (a rulebook PDF reader) does the same at a larger scale:
// read the input file, report progress as it goes, and write a bundle into
// outputDir. The server checks the bundle against the same rules a bundle
// file meets, then shows the DM a preview before anything is created.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SIZES = ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"];

function field(line, label) {
  const match = new RegExp(`${label}\\s+([^,]+)`, "i").exec(line);
  return match ? match[1].trim() : "";
}

function parseMonster(name, lines) {
  const stats = { ac: 12, maxHp: 10, cr: 1, size: "Medium", type: "monstrosity", speed: "30 ft.", attacks: [], traits: [] };
  const prose = [];
  for (const line of lines) {
    if (/^AC\s/i.test(line)) {
      stats.ac = Number.parseInt(field(line, "AC"), 10) || stats.ac;
      stats.maxHp = Number.parseInt(field(line, "HP"), 10) || stats.maxHp;
      const cr = field(line, "CR");
      stats.cr = cr.includes("/") ? Number(cr.split("/")[0]) / Number(cr.split("/")[1]) : Number(cr) || stats.cr;
      const size = field(line, "Size");
      stats.size = SIZES.find((option) => option.toLowerCase() === size.toLowerCase()) ?? stats.size;
      stats.type = field(line, "Type").toLowerCase() || stats.type;
      stats.speed = field(line, "Speed") || stats.speed;
    } else if (/^Attack:/i.test(line)) {
      // "Claws +5, 2d6+3 slashing"
      const match = /^Attack:\s*(.+?)\s+([+-]\d+)\s*,\s*([0-9d+\-\s]+?)\s+([a-z/]+)\s*$/i.exec(line);
      if (match) {
        stats.attacks.push({ name: match[1], toHit: Number(match[2]), damage: match[3].replace(/\s+/g, ""), type: match[4].toLowerCase() });
      }
    } else if (/^Trait:/i.test(line)) {
      stats.traits.push(line.replace(/^Trait:\s*/i, ""));
    } else if (line.trim()) {
      prose.push(line.trim());
    }
  }
  return { name, desc: prose.join(" ").slice(0, 8000), stats, extraDamagePerRound: 0 };
}

export function parseSections(text) {
  const monsters = [];
  const lore = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    if (current.kind === "monster") monsters.push(parseMonster(current.title, current.lines));
    else lore.push({ category: "history", title: current.title, body: current.lines.join("\n").trim(), tags: [], visibility: "party" });
  };
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^#\s*(Monster|Lore)\s*:\s*(.+)$/i.exec(raw.trim());
    if (heading) {
      flush();
      current = { kind: heading[1].toLowerCase(), title: heading[2].trim().slice(0, 120), lines: [] };
    } else if (current) {
      current.lines.push(raw);
    }
  }
  flush();
  return { monsters, lore };
}

export async function importStatblocks(args, ctx) {
  const text = await readFile(args.input.path, "utf8");
  ctx.progress(0, 3, "Reading sections");
  const { monsters, lore } = parseSections(text);
  if (!monsters.length && !lore.length) {
    throw new Error("No '# Monster:' or '# Lore:' sections were found in that file.");
  }
  ctx.progress(1, 3, `Found ${monsters.length} monsters and ${lore.length} lore entries`);
  if (ctx.signal.aborted) throw new Error("Cancelled.");

  const title = path.basename(args.input.name, path.extname(args.input.name));
  let blurb = `${monsters.length} monsters and ${lore.length} lore entries from ${args.input.name}.`;
  const notes = [];
  if (args.options.blurb) {
    try {
      ctx.progress(2, 3, "Asking the storyteller for a blurb");
      const names = monsters.map((monster) => monster.name).join(", ");
      const written = await ctx.sample([`Write one sentence (under 25 words) introducing a workshop of these monsters: ${names}.`], {
        system: "You write short, evocative blurbs for tabletop roleplaying material.",
        maxTokens: 120,
      });
      if (written.trim()) blurb = written.trim().slice(0, 200);
    } catch (error) {
      notes.push(`The blurb was not written: ${error instanceof Error ? error.message : error}`);
    }
  }

  const bundle = {
    kind: "odm.workshop",
    version: 1,
    manifest: { name: title.slice(0, 70) || "Stat blocks", blurb, author: "", inspiredBy: args.input.name, rightsHolder: "" },
    monsters,
    lore,
  };
  // A bundle can be large; a file is the safe way back for any size.
  await writeFile(path.join(args.outputDir, "bundle.json"), JSON.stringify(bundle));
  ctx.progress(3, 3, "Done");
  return { bundleFile: "bundle.json", notes };
}
