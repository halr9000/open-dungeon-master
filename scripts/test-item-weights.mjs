// Item weights (issue #205). The pack's old reader kept only digits and dots,
// so a dart's "1/4 lb." became 14 lb and ten darts outweighed a suit of
// plate. Three parts:
//
// 1. the one reader every door uses (src/lib/content/weight.ts);
// 2. an audit of the real content pack, when this checkout has one (CI has
//    none): every source weight readable, every stored weight the reader's,
//    and the SRD weapons and gear agreeing with ODM's own tables;
// 3. a pack built the old way (the dart row says 14) under a real table:
//    the server reads the right weight anyway, and the 14 a sheet, a library
//    character, a workshop copy or the party's pack already copied is put
//    right on read, while a number someone chose stays theirs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// The real pack is audited where it is; the table in part 3 runs on a pack
// built the old way, so CONTENT_DB_PATH is pointed at that before anything
// from src/ loads (enforce-world registers the "@/" loader).
const realPack = process.env.CONTENT_DB_PATH || path.join(repoRoot, "data", "content", "open5e.sqlite");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "odm-weights-"));
process.on("exit", () => removeTempDir(scratch));
const oldPack = path.join(scratch, "open5e.sqlite");
{
  // The importer's own tables, so every reader finds what it expects.
  const importer = fs.readFileSync(path.join(repoRoot, "scripts", "import-open5e.mjs"), "utf8");
  const schema = /db\.exec\(`(\s*CREATE TABLE spells[\s\S]*?)`\);/.exec(importer)?.[1];
  assert.ok(schema, "the importer's schema is found");
  const db = new Database(oldPack);
  db.exec(schema);
  const insert = db.prepare(
    `INSERT INTO items (slug, name, document_slug, kind, rarity, cost, category, weight, data_json) VALUES (?, ?, ?, ?, '', '', '', ?, ?)`,
  );
  // The numbers v0.26.2's importer stored for these rows.
  insert.run("dart", "Dart", "wotc-srd", "weapon", 14, JSON.stringify({ name: "Dart", weight: "1/4 lb." }));
  insert.run("longsword", "Longsword", "wotc-srd", "weapon", 3, JSON.stringify({ name: "Longsword", weight: "3 lb." }));
  insert.run("srd_sling-bullets", "Sling bullets", "srd-2014", "gear", 0.08, JSON.stringify({ name: "Sling bullets", weight: "0.075", weight_unit: "lb" }));
  db.close();
}
process.env.CONTENT_DB_PATH = oldPack;

const { openWorld, heroInput } = await import("./lib/enforce-world.mjs");
const world = await openWorld();
const { getDatabase } = await import("../src/lib/db/core.ts");
const { itemWeightByName, repairedWeight, searchItems } = await import("../src/lib/content/index.ts");
const { speedFor } = await import("../src/lib/srd/index.ts");
const { encumbranceFor } = await import("../src/lib/srd/encumbrance.ts");
const { createCharacter, getCharacter } = await import("../src/lib/db/characters.ts");
const { createHomebrew, getHomebrew } = await import("../src/lib/db/homebrew.ts");
const { getParty, setParty } = await import("../src/lib/db/party.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

const { readWeightLb, packWeightLb, legacyPackWeightLb } = await import("../src/lib/content/weight.ts");

// ---- 1. the reader ----

await test("whole, decimal and thousands figures, with or without a unit", () => {
  assert.deepEqual(readWeightLb("8 lb."), { pounds: 8, problem: null });
  assert.equal(readWeightLb("8 lbs").pounds, 8);
  assert.equal(readWeightLb("8 pounds").pounds, 8);
  assert.equal(readWeightLb("8").pounds, 8);
  assert.equal(readWeightLb("0.075", "lb").pounds, 0.075);
  assert.equal(readWeightLb("5.000", "lb").pounds, 5);
  assert.equal(readWeightLb(".5 lb").pounds, 0.5);
  assert.equal(readWeightLb("1,000 lb.").pounds, 1000);
  assert.equal(readWeightLb(3).pounds, 3);
  assert.equal(readWeightLb(0).pounds, 0);
});

await test("simple and mixed fractions, typed or printed", () => {
  assert.equal(readWeightLb("1/4 lb.").pounds, 0.25);
  assert.equal(readWeightLb("1/2").pounds, 0.5);
  assert.equal(readWeightLb("1 1/2 lb.").pounds, 1.5);
  assert.equal(readWeightLb("2-1/4 lb").pounds, 2.25);
  assert.equal(readWeightLb("1/3 lb").pounds, 0.3333);
  assert.equal(readWeightLb("½ lb.").pounds, 0.5);
  assert.equal(readWeightLb("1½ lb.").pounds, 1.5);
  assert.equal(readWeightLb("¼").pounds, 0.25);
});

await test("other units turn into pounds", () => {
  assert.equal(readWeightLb("8 oz.").pounds, 0.5);
  assert.equal(readWeightLb("12 ounces").pounds, 0.75);
  assert.equal(readWeightLb("2 kg").pounds, 4.4092);
  assert.equal(readWeightLb("2", "kg").pounds, 4.4092);
  assert.equal(readWeightLb("500 g").pounds, 1.1023);
  // The text's own unit wins over the field beside it.
  assert.equal(readWeightLb("8 lb.", "kg").pounds, 8);
});

await test("nothing stated is unknown without a problem; a dash is the books' nothing", () => {
  for (const blank of [null, undefined, "", "   ", "—", "-", "–"]) {
    assert.deepEqual(readWeightLb(blank), { pounds: null, problem: null }, String(blank));
  }
});

await test("a weight it cannot read is unknown, with the reason, never a made-up number", () => {
  for (const bad of ["2-3 lb.", "varies", "1,5 kg", "1/0 lb.", "lb.", "3 stone", "about 2 lb", "1.2.3"]) {
    const reading = readWeightLb(bad);
    assert.equal(reading.pounds, null, bad);
    assert.ok(reading.problem, `${bad} names its problem`);
  }
  assert.equal(readWeightLb(-1).pounds, null);
  assert.equal(readWeightLb(Number.NaN).pounds, null);
  assert.equal(readWeightLb("2", "stone").pounds, null);
});

await test("the old reader's mistakes, kept only to recognise them", () => {
  assert.equal(legacyPackWeightLb("1/4 lb."), 14);
  assert.equal(legacyPackWeightLb("0.075", "lb"), 0.08);
  assert.equal(legacyPackWeightLb("8 lb."), 8);
  assert.equal(legacyPackWeightLb(""), 0);
});

await test("a pack row is weighed from its own text, the column only when there is none", () => {
  assert.equal(packWeightLb(14, { weight: "1/4 lb." }), 0.25);
  assert.equal(packWeightLb(0.08, { weight: "0.075", weight_unit: "lb" }), 0.075);
  assert.equal(packWeightLb(0, { weight: "" }), 0);
  assert.equal(packWeightLb(65, {}), 65);
  assert.equal(packWeightLb(0, { weight: "varies" }), 0);
});

// ---- 2. the real pack ----

if (fs.existsSync(realPack)) {
  const { SRD_WEAPON_WEIGHT_LB } = await import("../src/lib/srd/weapons.ts");
  const { SRD_GEAR } = await import("../src/lib/srd/adventuring-gear.ts");
  const pack = new Database(realPack, { readonly: true, fileMustExist: true });
  const rows = pack
    .prepare(`SELECT name, kind, document_slug, weight, data_json FROM items WHERE kind != 'magic_item'`)
    .all()
    .map((row) => ({ ...row, data: JSON.parse(row.data_json) }));
  pack.close();

  await test("every source weight in the pack is one the reader can read", () => {
    const unread = rows
      .map((row) => ({ name: row.name, problem: readWeightLb(row.data.weight, row.data.weight_unit).problem }))
      .filter((row) => row.problem);
    assert.deepEqual(unread, []);
  });

  await test("every stored weight is the reader's (rebuild a stale pack: node scripts/import-open5e.mjs)", () => {
    const stale = rows
      .filter((row) => Math.abs(row.weight - packWeightLb(row.weight, row.data)) > 1e-9)
      .map((row) => `${row.name} (${row.document_slug}): stored ${row.weight}, source "${row.data.weight}"`);
    assert.deepEqual(stale, []);
  });

  await test("the pack's SRD weapons and gear weigh what ODM's own tables say", () => {
    const gearByName = new Map(SRD_GEAR.filter((gear) => gear.weightLb).map((gear) => [gear.name.toLowerCase(), gear.weightLb]));
    const disagree = [];
    let compared = 0;
    for (const row of rows) {
      const pounds = packWeightLb(row.weight, row.data);
      const table =
        row.kind === "weapon" ? SRD_WEAPON_WEIGHT_LB[row.name] : row.kind === "gear" ? gearByName.get(row.name.toLowerCase()) : undefined;
      if (!table || !pounds || !["wotc-srd", "srd-2014"].includes(row.document_slug)) {
        continue;
      }
      compared += 1;
      if (Math.abs(table - pounds) > 1e-9) {
        disagree.push(`${row.name}: pack ${pounds}, table ${table}`);
      }
    }
    assert.ok(compared > 50, `compared ${compared} rows`);
    assert.deepEqual(disagree, []);
  });
} else {
  console.log("no content pack here: the pack audit is skipped");
}

// ---- 3. a pack built the old way ----

const storedEquipment = (sheetId) =>
  JSON.parse(getDatabase().prepare(`SELECT equipment_json FROM character_sheets WHERE id = ?`).get(sheetId).equipment_json);

await test("an old pack still weighs a dart at a quarter pound", () => {
  assert.equal(itemWeightByName("Dart"), 0.25);
  assert.equal(itemWeightByName("Darts"), 0.25);
  assert.equal(itemWeightByName("+1 Dart"), 0.25);
  assert.equal(itemWeightByName("Longsword"), 3);
  assert.equal(itemWeightByName("Sling bullets"), 0.075);
  // The builder and a workshop copy take their weight from the search.
  assert.equal(searchItems({ q: "Dart", kind: "weapon" }).find((item) => item.name === "Dart")?.weight, 0.25);
});

await test("only the old reader's exact number is repaired", () => {
  assert.equal(repairedWeight("Dart", 14), 0.25);
  assert.equal(repairedWeight("Darts", 14), 0.25);
  assert.equal(repairedWeight("Sling bullets", 0.08), 0.075);
  assert.equal(repairedWeight("Dart", 1), 1, "a dart someone weighed at 1 lb stays");
  assert.equal(repairedWeight("Longsword", 14), 14, "14 is only wrong for a dart");
  assert.equal(repairedWeight("Iron Pot", 14), 14);
  assert.equal(repairedWeight("Dart", undefined), undefined);
});

await test("a campaign sheet carrying the 14 lb dart reads right, saves right, and moves again", () => {
  const hero = world.addHero({
    abilities: { str: 8 },
    equipment: [
      { name: "Dart", qty: 10, weight: 14 },
      { name: "Longsword", qty: 1, weight: 3 },
      { name: "Iron Pot", qty: 1, weight: 14 },
    ],
  });
  // As v0.26.2 left it in the database.
  getDatabase()
    .prepare(`UPDATE character_sheets SET equipment_json = ? WHERE id = ?`)
    .run(JSON.stringify([{ name: "Dart", qty: 10, weight: 14 }, { name: "Longsword", qty: 1, weight: 3 }, { name: "Iron Pot", qty: 1, weight: 14 }]), hero.id);
  const sheet = world.sheet(hero.id);
  assert.deepEqual(
    sheet.equipment.map((item) => [item.name, item.weight]),
    [["Dart", 0.25], ["Longsword", 3], ["Iron Pot", 14]],
  );
  // What that sheet weighed before: 140 + 3 + 14 lb, past a Strength 8
  // character's 120 lb, so 5 feet even with encumbrance off.
  const before = { ...sheet, equipment: [{ name: "Dart", qty: 10, weight: 14 }, ...sheet.equipment.slice(1)] };
  assert.equal(encumbranceFor({ strength: 8, equipment: before.equipment }).carriedLb, 157);
  assert.equal(speedFor(before, { encumbrance: false }), 5);
  // Now: 2.5 + 3 + 14 lb, and the walking speed back.
  assert.equal(encumbranceFor({ strength: 8, equipment: sheet.equipment }).carriedLb, 19.5);
  assert.equal(speedFor(sheet, { encumbrance: false }), 30);
  assert.equal(speedFor(sheet, { encumbrance: true }), 30);
  // The next write saves the repaired number.
  world.patch(hero.id, { gold: 5 });
  assert.equal(storedEquipment(hero.id)[0].weight, 0.25);
  assert.equal(storedEquipment(hero.id)[2].weight, 14);
});

await test("a library character, a workshop copy and its carried line are repaired too", () => {
  const character = createCharacter(world.owner.id, 1, heroInput({ name: "Shelf Hero", equipment: [{ name: "Darts", qty: 20, weight: 14 }] }));
  assert.equal(getCharacter(character.id).sheet.equipment[0].weight, 0.25);

  const copied = { name: "Dart", source: "published", slug: "dart", document: "wotc-srd" };
  const copy = createHomebrew(world.owner.id, { kind: "item", name: "Dart Variant", data: { itemKind: "gear", weight: 14, copiedFrom: copied } });
  assert.equal(getHomebrew(world.owner.id, copy.id).data.weight, 0.25);
  const changed = createHomebrew(world.owner.id, { kind: "item", name: "Heavy Dart", data: { itemKind: "gear", weight: 2, copiedFrom: copied } });
  assert.equal(getHomebrew(world.owner.id, changed.id).data.weight, 2, "a weight its author set stays");

  const hero = world.addHero({ equipment: [{ name: "Dart Variant", qty: 10, weight: 14, slug: `homebrew:${copy.id}` }] });
  getDatabase()
    .prepare(`UPDATE character_sheets SET equipment_json = ? WHERE id = ?`)
    .run(JSON.stringify([{ name: "Dart Variant", qty: 10, weight: 14, slug: `homebrew:${copy.id}` }]), hero.id);
  assert.equal(world.sheet(hero.id).equipment[0].weight, 0.25);
});

await test("the party's shared pack is repaired on read, on the campaign too", () => {
  const party = getParty(world.campaignId);
  setParty(world.campaignId, { ...party, inventory: [{ name: "Dart", qty: 10, weight: 14 }, { name: "Anvil", qty: 1, weight: 14 }] });
  assert.deepEqual(
    getParty(world.campaignId).inventory.map((item) => item.weight),
    [0.25, 14],
  );
  assert.deepEqual(
    world.campaign().party.inventory.map((item) => item.weight),
    [0.25, 14],
  );
});

world.close();
console.log(`item weights: ${passed} tests passed`);
