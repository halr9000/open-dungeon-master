// The builder's hit points (src/app/characters/builder/builderHp.ts): the
// figure the health explainer, the last step's preview and the save all
// show. Each case is held against the server's own check
// (src/lib/srd/sheet-legality.ts legalizeSheet), so the builder can never
// promise a number the server then changes: Tough, Dwarven Toughness,
// Draconic Resilience, Constitution, level and the table's method all count,
// and a stored character keeps its hit points only where the server would.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { builderHitPoints } = await import("../src/app/characters/builder/builderHp.ts");
const { legalizeSheet } = await import("../src/lib/srd/sheet-legality.ts");
const { derivedMaxHp } = await import("../src/lib/srd/hit-points.ts");
const options = await import("../src/lib/characters/options.ts");
const { bundledPrices } = await import("../src/lib/srd/starting-wealth.ts");
const { checklistSpell } = await import("../src/lib/srd/spell-lists.ts");
const { bundledSubclassName } = await import("../src/lib/srd/features.ts");

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

const classes = options.srdClassOptions();
const races = options.srdRaceOptions();
const backgrounds = options.srdBackgroundOptions();
const FEATS = ["tough", "alert"];

function context(sheet, overrides = {}) {
  const race = races.find((entry) => entry.id === sheet.race);
  return {
    door: "table",
    level: 1,
    hpMethod: "average",
    startingWealth: "equipment",
    classOf: (id) => classes.find((entry) => entry.id === id) ?? null,
    race: race ? { ...race, feats: 0 } : null,
    background: backgrounds.find((entry) => entry.id === sheet.background) ?? null,
    baseline: null,
    abilityPool: null,
    wealthRoll: null,
    priceOf: bundledPrices,
    spellOf: checklistSpell,
    featOf: (name) => (FEATS.includes(name.toLowerCase()) ? { name, prerequisite: "" } : null),
    subclassOffered: (classId, name) => Boolean(bundledSubclassName(classId, name)),
    rollDie: () => 3,
    ...overrides,
  };
}

// A human fighter 5 who took Tough with the 4th-level improvement. The
// scores are a 27 point buy with the human's +1 on each.
const TOUGH_FIGHTER = {
  name: "Brakka", race: "human", class: "fighter", subclass: "Champion", background: "soldier",
  alignment: "N", gender: "", appearance: "",
  abilities: { str: 16, dex: 15, con: 14, int: 13, wis: 11, cha: 9 },
  maxHp: 1, ac: 18, acOverride: false, speed: 30,
  hitDice: { die: "d10", total: 5, spent: 0 }, classes: [], hitDicePools: null,
  proficiencies: {
    saves: ["str", "con"], skills: ["perception", "survival", "athletics", "intimidation"],
    expertise: [], languages: ["Common", "Dwarvish"], tools: ["dice set"], armor: [], weapons: [],
  },
  equipment: [{ name: "Longsword", qty: 1 }, { name: "Chain Mail", qty: 1 }, { name: "Shield", qty: 1 }],
  gold: 10, copper: 0, feats: [],
  features: [{ name: "Fighting Style: Defense", source: "choice" }],
  asiChoices: [{ mode: "feat", feat: "Tough" }], spellcasting: null, portrait: null, notes: "", backstory: "",
};
// The same scores with Constitution 16: Dexterity and Intelligence pay for it.
const CON_16 = { str: 16, dex: 14, con: 16, int: 11, wis: 11, cha: 9 };

const builderFor = (sheet, overrides = {}) =>
  builderHitPoints({
    hitDie: 10,
    classId: sheet.class,
    subclass: sheet.subclass,
    level: 5,
    con: sheet.abilities.con,
    raceId: sheet.race,
    feats: ["Tough"],
    method: "average",
    stored: null,
    ...overrides,
  });

function server(sheet, overrides) {
  const out = legalizeSheet(sheet, context(sheet, { level: 5, ...overrides }));
  assert.deepEqual(out.problems, []);
  return out.sheet.maxHp;
}

test("Tough counts in the explainer, the preview and the save alike", () => {
  const hp = builderFor(TOUGH_FIGHTER);
  // 1st level 10 + 2 + 2, then four levels of 6 + 2 + 2.
  assert.equal(hp.maxHp, 54);
  assert.equal(hp.parts.total, 54);
  assert.equal(hp.parts.bonusPerLevel, 2);
  assert.equal(hp.kept, false);
  assert.equal(server(TOUGH_FIGHTER, { hpMethod: "average" }), 54);
  // Without Tough the old explainer's figure, 44, is the one it showed.
  assert.equal(builderFor(TOUGH_FIGHTER, { feats: [] }).maxHp, 44);
});

test("the table's method moves the explainer with the preview", () => {
  const max = builderFor(TOUGH_FIGHTER, { method: "max" });
  assert.equal(max.maxHp, 14 + 4 * 14);
  assert.equal(max.parts.total, max.maxHp);
  assert.equal(max.parts.face, 10);
  assert.equal(server(TOUGH_FIGHTER, { hpMethod: "max" }), max.maxHp);
  // A table that rolls shows the fixed value and the range the dice give.
  const rolled = builderFor(TOUGH_FIGHTER, { method: "rolled" });
  assert.equal(rolled.maxHp, 54);
  assert.equal(rolled.method, "rolled");
  assert.deepEqual(rolled.range, { min: 14 + 4 * 5, max: 14 + 4 * 14 });
  const dealt = server(TOUGH_FIGHTER, { hpMethod: "rolled" });
  assert.ok(dealt >= rolled.range.min && dealt <= rolled.range.max, String(dealt));
});

test("a library character is made under the average", () => {
  const hp = builderFor(TOUGH_FIGHTER, { method: null });
  assert.equal(hp.maxHp, 54);
  assert.equal(server(TOUGH_FIGHTER, { door: "library", hpMethod: null }), 54);
});

test("an edit keeps the stored hit points while level and Constitution stand", () => {
  const stored = { ...TOUGH_FIGHTER, maxHp: 50 };
  const library = { door: "library", hpMethod: null, baseline: { sheet: stored, level: 5 } };
  const hp = builderFor(stored, { method: null, stored: { maxHp: 50, level: 5, con: 14 } });
  assert.equal(hp.kept, true);
  assert.equal(hp.maxHp, 50);
  assert.equal(server(stored, library), 50);
});

test("an edit that changes Constitution drops the stale hit points, as the server does", () => {
  const stored = { ...TOUGH_FIGHTER, maxHp: 50 };
  const edited = { ...stored, abilities: CON_16 };
  const library = { door: "library", hpMethod: null, baseline: { sheet: stored, level: 5 } };
  const hp = builderFor(edited, { method: null, stored: { maxHp: 50, level: 5, con: 14 } });
  assert.equal(hp.kept, false);
  // 1st level 10 + 3 + 2, then four levels of 6 + 3 + 2.
  assert.equal(hp.maxHp, 59);
  assert.equal(hp.parts.total, 59);
  // The builder sends the stored figure; the server works it out again.
  assert.equal(server(edited, library), 59);
});

test("an edit that changes level drops them too", () => {
  const stored = { ...TOUGH_FIGHTER, maxHp: 50 };
  const atFour = { ...stored, hitDice: { die: "d10", total: 4, spent: 0 } };
  const library = { door: "library", hpMethod: null, level: 4, baseline: { sheet: stored, level: 5 } };
  const hp = builderFor(atFour, { method: null, level: 4, stored: { maxHp: 50, level: 5, con: 14 } });
  assert.equal(hp.kept, false);
  assert.equal(hp.maxHp, 14 + 3 * 10);
  assert.equal(server(atFour, library), hp.maxHp);
});

test("stored hit points out of range are worked out again", () => {
  const stored = { ...TOUGH_FIGHTER, maxHp: 90 };
  const library = { door: "library", hpMethod: null, baseline: { sheet: stored, level: 5 } };
  const hp = builderFor(stored, { method: null, stored: { maxHp: 90, level: 5, con: 14 } });
  assert.equal(hp.kept, false);
  assert.equal(hp.maxHp, 54);
  assert.equal(server(stored, library), 54);
});

test("a table works the hit points out whatever was stored", () => {
  const hp = builderFor(TOUGH_FIGHTER, { method: "average", stored: { maxHp: 50, level: 5, con: 14 } });
  assert.equal(hp.kept, false);
  assert.equal(hp.maxHp, 54);
});

test("lineage and Draconic Resilience count, and the working adds up", () => {
  const dwarf = builderFor(TOUGH_FIGHTER, { raceId: "hill_dwarf" });
  assert.equal(dwarf.parts.bonusPerLevel, 3);
  assert.equal(dwarf.maxHp, 54 + 5);
  const sorcerer = builderHitPoints({
    hitDie: 6, classId: "sorcerer", subclass: "Draconic Bloodline", level: 3, con: 14,
    raceId: "human", feats: [], method: "average", stored: null,
  });
  // 6 + 2, two levels of 4 + 2, and one per sorcerer level.
  assert.equal(sorcerer.parts.featureHp, 3);
  assert.equal(sorcerer.maxHp, 8 + 2 * 6 + 3);
  assert.equal(sorcerer.parts.total, sorcerer.maxHp);
  for (const die of [6, 8, 10, 12]) {
    for (const con of [3, 8, 14, 20]) {
      for (const level of [1, 2, 7, 20]) {
        for (const method of ["average", "max"]) {
          const hp = builderHitPoints({
            hitDie: die, classId: "fighter", subclass: "", level, con,
            raceId: "hill_dwarf", feats: ["Tough"], method, stored: null,
          });
          const label = `d${die} con ${con} level ${level} ${method}`;
          assert.equal(hp.parts.total, hp.maxHp, label);
          assert.equal(hp.maxHp, derivedMaxHp(method, { classes: [{ die, level }], con, perLevelBonus: 3 }), label);
        }
      }
    }
  }
});

console.log(`test-builder-hp: ${passed} passed`);
