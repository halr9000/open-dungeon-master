// The SW5e content pack's classes, derived as their rows say (task B1 of the
// SW5e pack plan).
//
// The SW5e pack (a content pack in ODM's format, built by sw5e-odm-pack)
// writes its class rows structurally: prof_saving_throws and the
// proficiencies as arrays of the game's own short codes (lgt, sbl, mvb),
// spellcaster_type as a word, and a class_progression table that carries the
// level-by-level features and grants. classMechanics must read those shapes
// (the Scout row arrived as saves ['str','con'] and no proficiencies, the
// stub answer), and classFeaturesFor must grant a pack class's features from
// class_progression where no bundled table describes the class. The rows in
// fixtures/sw5e-pack-classes.json are copied verbatim from the pack
// (sw5e.sqlite), cut to the fields the derivation reads.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "sw5e-pack-classes.json"), "utf8"));
// The Open5e pack rows, for the SRD-fallback side (the same derivation must
// leave them exactly as test-pack-rows.mjs found them).
const open5e = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "open5e-pack-rows.json"), "utf8"));

const { classMechanics } = await import("../src/lib/content/mechanics.ts");
const { registerPackClassFeatures, packClassFeaturesFor } = await import("../src/lib/content/class-progression.ts");
const { classFeaturesFor } = await import("../src/lib/srd/features.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const packClass = (slug) => {
  const row = pack.classes.find((entry) => entry.slug === slug);
  assert.ok(row, `fixture class ${slug}`);
  return row;
};
const srdRow = (slug) => {
  const row = open5e.srdClasses.find((entry) => entry.slug === slug);
  assert.ok(row, `open5e fixture class ${slug}`);
  return row;
};

// The pack's feature rows, as src/lib/content/db.ts registers them from the
// class_progression table: base-class rows, kind 'feature', one per
// name+level, the proficiency bookkeeping rows off (they are the derivation
// of saves and proficiencies, not sheet features).
const packFeatures = (slug) => {
  const seen = new Set();
  const out = [];
  for (const row of pack.classProgression[slug]) {
    if (row.kind !== "feature" || /^(Class|Multiclass) Proficiencies$/.test(row.name)) {
      continue;
    }
    const key = `${row.level}:${row.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ level: row.level, name: row.name });
  }
  return out;
};
for (const slug of pack.classes.map((row) => row.slug)) {
  registerPackClassFeatures(slug, packFeatures(slug));
}

test("a pack class's saving throws come from its own row, not the stub pair", () => {
  const scout = classMechanics("scout", packClass("scout").data);
  assert.deepEqual(scout.saves, ["str", "dex"]);
  assert.deepEqual(classMechanics("monk", packClass("monk").data).saves, ["str", "dex"]);
  assert.deepEqual(classMechanics("sentinel", packClass("sentinel").data).saves, ["dex", "cha"]);
  assert.deepEqual(classMechanics("berserker", packClass("berserker").data).saves, ["str", "con"]);
});

test("a pack class's armor and weapons are its row's categories, named", () => {
  const scout = classMechanics("scout", packClass("scout").data);
  assert.deepEqual(scout.armor, ["Light armor", "Medium armor"]);
  assert.deepEqual(scout.weapons, ["Simple blasters", "Martial blasters", "Simple vibroweapons", "Martial vibroweapons"]);
  const guardian = classMechanics("guardian", packClass("guardian").data);
  assert.deepEqual(guardian.armor, ["Light armor", "Medium armor"]);
  assert.deepEqual(guardian.weapons, ["Simple lightweapons", "Martial lightweapons", "Simple vibroweapons", "Martial vibroweapons"]);
  // The monk's granular vibroweapon grants arrive as the pack writes them
  // (mvb:<weapon>); naming them is the pack items table's job, not the row's.
  const monk = classMechanics("monk", packClass("monk").data);
  assert.deepEqual(monk.armor, []);
  assert.ok(monk.weapons.includes("Simple blasters"));
  assert.ok(monk.weapons.includes("Simple vibroweapons"));
  assert.ok(!monk.weapons.includes("Martial vibroweapons"), monk.weapons.join(", "));
  assert.ok(monk.weapons.includes("mvb:vibroblade"), monk.weapons.join(", "));
});

test("a pack class's hit die, casting ability and caster type come from its row", () => {
  const scout = classMechanics("scout", packClass("scout").data);
  assert.equal(scout.hitDie, 10);
  assert.equal(scout.spellAbility, "int");
  assert.equal(scout.casterType, "half");
  const consular = classMechanics("consular", packClass("consular").data);
  assert.equal(consular.hitDie, 6);
  assert.equal(consular.spellAbility, "wis");
  assert.equal(consular.casterType, "full");
  // SW5e's three-quarter casters sit on the half table until the pack's own
  // slot model exists (the resource epic): the nearest answer, stated.
  assert.equal(classMechanics("sentinel", packClass("sentinel").data).casterType, "half");
  assert.equal(classMechanics("berserker", packClass("berserker").data).casterType, "none");
  assert.equal(classMechanics("monk", packClass("monk").data).casterType, "none");
});

test("a pack class's features come from its class_progression rows", () => {
  assert.deepEqual(
    packClassFeaturesFor("scout").map((feature) => `${feature.level}:${feature.name}`),
    packFeatures("scout").map((feature) => `${feature.level}:${feature.name}`),
  );
  const level1 = classFeaturesFor("scout", "", 1);
  assert.deepEqual(level1.map((feature) => feature.name), ["Ranger's Quarry", "Pathfinder"]);
  for (const feature of level1) {
    assert.equal(feature.source, "class");
    assert.equal(feature.level, 1);
  }
  const level2 = classFeaturesFor("scout", "", 2).map((feature) => feature.name);
  assert.deepEqual(level2, ["Ranger's Quarry", "Pathfinder", "Techcasting", "Fighting Style"]);
  // The proficiency bookkeeping rows never became sheet features.
  assert.ok(!level2.includes("Class Proficiencies"));
  assert.ok(!level2.includes("Multiclass Proficiencies"));
});

test("a class no table describes grants nothing", () => {
  assert.deepEqual(packClassFeaturesFor("no-such-class"), []);
  assert.deepEqual(classFeaturesFor("no-such-class", "", 3), []);
});

test("SRD classes keep their bundled features and derivation", () => {
  // Registration added pack rows beside the bundled tables; the bundled ones
  // must still answer first, unchanged.
  const fighter = classFeaturesFor("fighter", "", 1).map((feature) => feature.name);
  assert.ok(fighter.includes("Fighting Style"));
  assert.ok(fighter.includes("Second Wind"));
  const wizard = classMechanics("wizard", srdRow("wizard").data);
  assert.deepEqual(wizard.armor, []);
  assert.deepEqual(wizard.weapons, ["Daggers", "darts", "slings", "quarterstaffs", "light crossbows"]);
  const fighterRow = classMechanics("fighter", srdRow("fighter").data);
  assert.deepEqual(fighterRow.armor, ["All armor", "shields"]);
  assert.deepEqual(fighterRow.saves, ["str", "con"]);
});

// The pack itself, when one is pointed at (the way the app and the other
// pack-backed tests read CONTENT_DB_PATH): the registration actually happens
// from the class_progression table, and the catalog serves the rows.
const sw5ePackPath = process.env.SW5E_PACK_DB ?? path.resolve(here, "../../sw5e-odm-pack/sw5e.sqlite");
if (fs.existsSync(sw5ePackPath)) {
  process.env.CONTENT_DB_PATH = sw5ePackPath;
  const { getContentDb } = await import("../src/lib/content/db.ts");
  const { listClasses } = await import("../src/lib/content/index.ts");

  test("the SW5e pack registers its classes' features from class_progression", () => {
    const db = getContentDb();
    assert.ok(db, "content pack opened");
    assert.ok(packClassFeaturesFor("scout").length > 0, "scout features registered");
    const names = classFeaturesFor("scout", "", 2).map((feature) => feature.name);
    assert.deepEqual(names, ["Ranger's Quarry", "Pathfinder", "Techcasting", "Fighting Style"]);
  });

  test("the SW5e pack's class rows serve through the catalog and derive", () => {
    const rows = listClasses({ limit: 200 });
    const scout = rows.find((row) => row.slug === "scout");
    assert.ok(scout, "scout row served");
    const mechanics = classMechanics("scout", scout.data);
    assert.deepEqual(mechanics.saves, ["str", "dex"]);
    assert.deepEqual(mechanics.armor, ["Light armor", "Medium armor"]);
    assert.ok(mechanics.weapons.length > 0);
  });
} else {
  console.log(`skip - pack-backed tests (no SW5e pack at ${sw5ePackPath}; set SW5E_PACK_DB)`);
}

console.log(`\ntest-sw5e-pack-classes: ${passed} tests passed.`);
