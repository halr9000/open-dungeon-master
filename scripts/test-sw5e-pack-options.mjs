// The SW5e content pack's option grants, surfaced and admitted (task B2 of
// the SW5e pack plan).
//
// The pack's class_progression carries kind 'option_grant' rows: a class
// feature that opens a list (Berserker Instincts, Choose Fighting Style,
// Lightsaber Forms), one row per option it may grant, the option resolved
// through the options table (family, action economy, uses). Two things must
// read them:
//
//   1. an `options` section on the character sheet, derived (not stored)
//      from the sheet's classes, that surfaces the grants with their
//      per-level pick counts — display only; the picking itself is B3.
//   2. the legality allowlist: a feature whose name the pack declares (an
//      option its class_progression grants) survives a write — today the
//      validator refuses any mechanical-looking feature name no bundled
//      table knows, and options no engine table carries are exactly that.
//      'Fighting Style' WITHOUT a pack grant is still refused: the gate is
//      the pack's provenance, not a name list.
//
// The rows in fixtures/sw5e-pack-options.json are copied verbatim from the
// pack (sw5e.sqlite), cut to the fields the readers touch — except the
// sentinel's two lightsaber-form rows, the plan's worked example: the pack
// carries the options (Form of Ight among them) but no class_progression
// grant rows for the family yet, so the fixture states the row the builder
// writes once it does.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

register("./lib/register-alias.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "sw5e-pack-options.json"), "utf8"));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const {
  registerPackOptions,
  registerPackOptionGrants,
  packOptionBySlug,
  packOptionGrantsFor,
  packOptionGrantsForClasses,
  packOptionNamesFor,
} = await import("../src/lib/content/option-grants.ts");

registerPackOptions(fixture.options);
for (const slug of [...new Set(fixture.grants.map((row) => row.classSlug))]) {
  registerPackOptionGrants(
    slug,
    fixture.grants.filter((row) => row.classSlug === slug),
  );
}

test("a pack option resolves through the options table", () => {
  const option = packOptionBySlug("form-of-ight");
  assert.ok(option, "form-of-ight found");
  assert.equal(option.name, "Form of Ight");
  assert.equal(option.family, "lightsaber_form");
  assert.equal(option.actionEconomy, "bonus");
  assert.equal(packOptionBySlug("no-such-option"), null);
});

test("a class's option grants come from its class_progression rows", () => {
  const grants = packOptionGrantsFor("sentinel");
  assert.deepEqual(
    grants.map((row) => row.refSlug),
    ["form-of-ight", "ataru-form"],
  );
  assert.equal(packOptionGrantsFor("no-such-class").length, 0);
});

test("the sheet's options section surfaces the grants with their pick counts", () => {
  // Sentinel 13: the forms open at 2nd (two picks) and one more at 3rd.
  const sentinel = packOptionGrantsForClasses([{ id: "sentinel", subclass: "", level: 13 }]);
  assert.deepEqual(
    sentinel.map((grant) => [grant.classId, grant.name, grant.family, grant.level, grant.count]),
    [["sentinel", "Lightsaber Forms", "lightsaber_form", 2, 3]],
  );
  assert.deepEqual(sentinel[0].picks, { 2: 2, 3: 1 });
  // Berserker 9: two instincts at 2nd, one more at 7th.
  const berserker = packOptionGrantsForClasses([{ id: "berserker", subclass: "", level: 9 }]);
  assert.equal(berserker[0].name, "Berserker Instincts");
  assert.equal(berserker[0].family, "invocation");
  assert.equal(berserker[0].count, 3);
  // A fighter grants from the pack's own list even though the bundled
  // tables describe the class too: option grants are pack-wins (the
  // slug-collision policy), the SRD table carries no grants of its own.
  const fighter = packOptionGrantsForClasses([{ id: "fighter", subclass: "", level: 5 }]);
  assert.deepEqual(
    fighter.map((grant) => [grant.name, grant.family, grant.level, grant.count]),
    [["Choose Fighting Style", "fighting_style", 1, 1]],
  );
  // A class the pack does not describe grants nothing.
  assert.deepEqual(packOptionGrantsForClasses([{ id: "wizard", subclass: "", level: 3 }]), []);
});

test("an archetype's grants ride the subclass the sheet names", () => {
  const granted = packOptionGrantsForClasses([
    { id: "engineer", subclass: "Armormech Engineering", level: 9 },
  ]);
  assert.deepEqual(
    granted.map((grant) => grant.name),
    ["Armormech Modifications"],
  );
});

test("the allowlist reads the option names a class's grants declare", () => {
  assert.ok(packOptionNamesFor("sentinel").includes("Form of Ight"));
  assert.ok(packOptionNamesFor("sentinel").includes("Ataru Form"));
  assert.deepEqual(packOptionNamesFor("wizard"), []);
});

// ---- the write-time allowlist ----

const { legalizeSheet } = await import("../src/lib/srd/sheet-legality.ts");
const { classMechanics } = await import("../src/lib/content/mechanics.ts");
const options = await import("../src/lib/characters/options.ts");
const classes = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "sw5e-pack-classes.json"), "utf8"));

const packClass = (slug) => {
  const row = classes.classes.find((entry) => entry.slug === slug);
  assert.ok(row, `fixture class ${slug}`);
  return row;
};
const grantsOf = (slug) => classMechanics(slug, packClass(slug).data);

const SENTINEL = {
  name: "Deech", race: "human", class: "sentinel", subclass: "", background: "",
  alignment: "N", gender: "", appearance: "",
  // The human's six +1s ride the standard array, spent exactly (27 points).
  abilities: { str: 16, dex: 16, con: 16, int: 9, wis: 9, cha: 9 },
  racialChoices: { asi: [], skills: [], cantrip: "", tool: "" },
  maxHp: 18, ac: 14, acOverride: false, speed: 30,
  hitDice: { die: "d8", total: 2, spent: 0 }, classes: [], hitDicePools: null,
  proficiencies: {
    saves: ["dex", "cha"], skills: ["athletics", "survival"],
    expertise: [], languages: ["Common"], tools: [], armor: [], weapons: [],
  },
  equipment: [],
  gold: 0, copper: 0, feats: [],
  features: [{ name: "Force-Empowered Self", source: "class" }],
  asiChoices: [], spellcasting: null, portrait: null, notes: "", backstory: "",
};

function context(overrides = {}) {
  const races = options.srdRaceOptions();
  return {
    door: "table",
    level: 2,
    hpMethod: "average",
    startingWealth: "equipment",
    classOf: (id) => {
      const slug = String(id).toLowerCase();
      return classes.classes.some((entry) => entry.slug === slug)
        ? { id: slug, name: packClass(slug).data.name, ...grantsOf(slug) }
        : null;
    },
    race: { ...races.find((entry) => entry.id === "human"), feats: 0 },
    background: null,
    baseline: null,
    abilityPool: null,
    wealthRoll: null,
    priceOf: () => null,
    spellOf: () => null,
    featOf: () => null,
    subclassOffered: () => false,
    packDeclaredOptions: (classId) => packOptionNamesFor(String(classId).toLowerCase()),
    rollDie: () => 3,
    ...overrides,
  };
}

const judge = (sheet, overrides) => legalizeSheet(sheet, context(overrides));
const taken = (sheet, overrides) => {
  const out = judge(sheet, overrides);
  assert.deepEqual(out.problems, []);
  return out.sheet;
};
const refused = (sheet, overrides, label) => {
  const out = judge(sheet, overrides);
  assert.ok(out.problems.length > 0, `${label ?? "the sheet"} was let through`);
  return out.problems;
};

test("a pack-declared option survives a write that would refuse it", () => {
  const sheet = taken({
    ...SENTINEL,
    features: [
      { name: "Force-Empowered Self", source: "class" },
      { name: "Form of Ight", source: "story" },
    ],
  });
  assert.ok(
    sheet.features.some((feature) => feature.name === "Form of Ight" && feature.source === "story"),
    JSON.stringify(sheet.features),
  );
});

test("a mechanical name without a pack grant is still refused", () => {
  // No class here is pack-declared 'Fighting Style': the allowlist is the
  // pack's provenance, not a name list, so an SRD fighter's bare
  // 'Fighting Style' stays refused on the import door as before.
  refused({ ...SENTINEL, class: "sentinel", features: [{ name: "Fighting Style", source: "story" }] });
  // And a story feature the pack says nothing about stays refused too.
  refused({ ...SENTINEL, features: [{ name: "A kind word from the queen", source: "story" }] });
});

test("a pack option sent as the player's pick survives as a choice", () => {
  // The converter writes a customizationOption pick (a form chosen on the
  // FVTT sheet) as source 'choice'; an un-SRD name was dropped silently.
  const sheet = taken({
    ...SENTINEL,
    features: [
      { name: "Force-Empowered Self", source: "class" },
      { name: "Form of Ight", source: "choice" },
    ],
  });
  assert.ok(sheet.features.some((feature) => feature.name === "Form of Ight" && feature.source === "choice"));
  // A pick nothing grants is still dropped.
  const stripped = taken({
    ...SENTINEL,
    features: [
      { name: "Force-Empowered Self", source: "class" },
      { name: "Snapshot Style", source: "choice" },
    ],
  });
  assert.ok(!stripped.features.some((feature) => feature.name === "Snapshot Style"));
});

test("an option the pack grants under another class's name is not admitted", () => {
  // Provenance is per class: a berserker's instinct does not ride a
  // sentinel.
  refused({
    ...SENTINEL,
    class: "sentinel",
    features: [{ name: "Fighter's Instinct", source: "story" }],
  });
});

// The pack itself, when one is pointed at (the way the app and the other
// pack-backed tests read CONTENT_DB_PATH): the loader registers the options
// and the grants from the real tables.
const sw5ePackPath = process.env.SW5E_PACK_DB ?? path.resolve(here, "../../sw5e-odm-pack/sw5e.sqlite");
if (fs.existsSync(sw5ePackPath)) {
  process.env.CONTENT_DB_PATH = sw5ePackPath;
  const { getContentDb } = await import("../src/lib/content/db.ts");

  test("the SW5e pack registers its options and grants from the real tables", () => {
    assert.ok(getContentDb(), "content pack opened");
    const instincts = packOptionGrantsFor("berserker").filter((row) => row.name === "Berserker Instincts");
    assert.ok(instincts.length >= 10, "berserker instinct grant rows registered");
    assert.deepEqual(instincts[0].choices, { 2: 2, 7: 1, 13: 1, 17: 1 });
    const option = packOptionBySlug("fighters-instinct");
    assert.ok(option, "fighters-instinct resolved");
    assert.equal(option.family, "invocation");
    const fighterStyles = packOptionGrantsFor("fighter").filter((row) => row.name === "Choose Fighting Style");
    assert.ok(fighterStyles.length >= 30, "the fighter's style grants registered");
    assert.deepEqual(fighterStyles[0].choices, {});
    assert.ok(packOptionNamesFor("fighter").includes("Formation Style"));
    // The real sheet view over the real pack: a berserker 9 has picked
    // 2 + 1 instincts by now.
    const sheet = packOptionGrantsForClasses([{ id: "berserker", subclass: "", level: 9 }]);
    assert.ok(sheet.some((grant) => grant.name === "Berserker Instincts" && grant.count === 3));
  });

  // The sheet itself: the options section is derived on read (never
  // stored), so a stored sentinel sheet reads back with the grants its
  // classes have opened, over a throwaway world database.
  const os = await import("node:os");
  const { randomBytes } = await import("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-pack-options-"));
  process.on("exit", () => removeTempDir(dir));
  process.env.SQLITE_DB_PATH = path.join(dir, "world.sqlite");
  process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { getDatabase } = await import("../src/lib/db/core.ts");
  const { createUser } = await import("../src/lib/db/users.ts");
  const { createCampaign } = await import("../src/lib/db/campaigns.ts");
  const { createSheet, getSheetById } = await import("../src/lib/db/sheets.ts");
  const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");

  test("a stored sheet reads back with the options section derived", () => {
    getDatabase();
    const dm = createUser("dm", "x");
    const campaign = createCampaign(dm.id, {
      title: "T", description: "", theme: "", maxPlayers: 4, startingLevel: 13, difficulty: "normal",
    });
    const sheet = createSheet(
      campaign.id,
      dm.id,
      13,
      createSheetSchema.parse({
        name: "Deech", race: "human", class: "sentinel",
        abilities: { str: 16, dex: 16, con: 16, int: 9, wis: 9, cha: 9 },
        maxHp: 100, ac: 14, hitDice: { die: "d8", total: 13, spent: 0 },
        proficiencies: { saves: ["dex", "cha"], skills: [], languages: ["common"], tools: [], armor: [], weapons: [] },
        equipment: [], gold: 0,
        features: [{ name: "Form of Ight", source: "story" }],
      }),
    );
    const read = getSheetById(sheet.id);
    assert.ok(read, "sheet stored");
    const grants = read?.options?.grants ?? [];
    // The real pack's grants: the sentinel's ideals (two at 2nd, one more
    // at 6th and at 11th — four earned by 13th).
    const ideals = grants.find((grant) => grant.name === "Sentinel Ideals");
    assert.ok(ideals, JSON.stringify(grants));
    assert.equal(ideals.family, "invocation");
    assert.equal(ideals.count, 4);
    assert.deepEqual(ideals.picks, { 2: 2, 6: 1, 11: 1 });
  });
} else {
  console.log(`skip - pack-backed tests (no SW5e pack at ${sw5ePackPath}; set SW5E_PACK_DB)`);
}

console.log(`\ntest-sw5e-pack-options: ${passed} tests passed.`);
