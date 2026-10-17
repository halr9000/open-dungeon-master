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
//   3. the level-up picks (task B3): a level-up names, per grant, the FULL
//      final list of option slugs it holds. The server holds the list to
//      the grant's pool, its earned budget (the per-level counts the grant
//      carries), the no-double-pick rule, and the grant's replacement right
//      — a pick dropped from the stored list is a replacement and rides the
//      flag the pack's data_json carries per level. The settled picks are
//      stored on the sheet (options.picks, keyed `${classId}|${name}`) and
//      priced on read into actions: a picked option whose pack row carries
//      an action economy (a bonus-action form) is an action on the sheet.
//
// The rows in fixtures/sw5e-pack-options.json are copied verbatim from the
// pack (sw5e.sqlite), cut to the fields the readers touch. The plan's
// worked example — "Sentinel level-1 grants 3 lightsaber-form picks" — is
// NOT in the pack and never will be: the source grants no lightsaber forms,
// fighting masteries or maneuvers as class-level option grants anywhere in
// character-classes (the only in-family machine grants are two nested
// sub-grants inside fighter-strategy invocations, and Form Combat
// Training's "learn one lightsaber form" is prose with an empty
// advancement), so the fixture carries the grants the builder really
// writes — berserker instincts, sentinel ideals, fighting styles. Form of
// Ight stays an OPTION row (the pack's options table has it); without a
// grant it is exactly what the allowlist must refuse. The fixture's fighter
// rows turn the replacement flag ON to exercise that reader path: the shape
// is the builder's, and every real row today carries false.
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
  packOptionPoolFor,
  packOptionActionsFor,
  pickedOptionNamesFor,
  grantKeyFor,
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
  // The grants the builder really writes: the sentinel's ideals (the
  // plan's lightsaber-form premise is not in the source — see the header).
  const grants = packOptionGrantsFor("sentinel");
  assert.deepEqual(
    grants.map((row) => row.refSlug),
    ["ideal-of-the-agile", "ideal-of-the-fighter"],
  );
  assert.equal(packOptionGrantsFor("no-such-class").length, 0);
});

test("the sheet's options section surfaces the grants with their pick counts", () => {
  // Sentinel 13: the ideals open at 2nd (two picks), one more at 6th and at
  // 11th — four earned by 13th.
  const sentinel = packOptionGrantsForClasses([{ id: "sentinel", subclass: "", level: 13 }]);
  assert.deepEqual(
    sentinel.map((grant) => [grant.classId, grant.name, grant.family, grant.level, grant.count]),
    [["sentinel", "Sentinel Ideals", "invocation", 2, 4]],
  );
  assert.deepEqual(sentinel[0].picks, { 2: 2, 6: 1, 11: 1 });
  assert.deepEqual(sentinel[0].replacement, { 2: false, 6: false, 11: false });
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
  // Two archetypes in the fixture: the gate must discriminate, not just
  // filter (an engineer fixture of one archetype only filters nothing).
  const armormech = packOptionGrantsForClasses([
    { id: "engineer", subclass: "Armormech Engineering", level: 9 },
  ]);
  assert.deepEqual(
    armormech.map((grant) => grant.name),
    ["Armormech Modifications"],
  );
  const astrotech = packOptionGrantsForClasses([
    { id: "engineer", subclass: "Astrotech Engineering", level: 5 },
  ]);
  assert.deepEqual(astrotech.map((grant) => grant.name), ["Astrotech Modifications"]);
  assert.equal(astrotech[0].family, "invocation");
  // No subclass named: an archetype's grants ride nothing.
  assert.deepEqual(
    packOptionGrantsForClasses([{ id: "engineer", subclass: "", level: 20 }]),
    [],
  );
});

test("a grant's pool answers with the option slugs its rows offer", () => {
  assert.deepEqual(packOptionPoolFor("berserker", "Berserker Instincts"), [
    "fighters-instinct",
    "banthas-instinct",
    "fyrnocks-instinct",
    "loth-cats-instinct",
  ]);
  assert.deepEqual(packOptionPoolFor("berserker", "No Such Grant"), []);
  assert.deepEqual(packOptionPoolFor("no-such-class", "Berserker Instincts"), []);
  // The grant key the picks are stored under.
  assert.equal(grantKeyFor("Berserker", "Berserker Instincts"), "berserker|berserker instincts");
});

test("picked options with an action economy price into actions", () => {
  // Fyrnock's and Loth-cat's instincts are bonus actions in the pack's
  // options table; a pick with no economy (Fighter's Instinct) prices into
  // nothing, and a pick against a grant the class does not hold yet is
  // silent.
  const actions = packOptionActionsFor(
    [{ id: "berserker", subclass: "", level: 9 }],
    {
      "berserker|berserker instincts": [
        "fighters-instinct",
        "fyrnocks-instinct",
        "loth-cats-instinct",
      ],
    },
  );
  assert.deepEqual(
    actions.map((action) => [action.name, action.economy, action.grantName]),
    [
      ["Fyrnock's Instinct", "bonus", "Berserker Instincts"],
      ["Loth-cat's Instinct", "bonus", "Berserker Instincts"],
    ],
  );
  assert.deepEqual(packOptionActionsFor([{ id: "berserker", subclass: "", level: 9 }], {}), []);
  // An archetype's actions ride the subclass the sheet names, as the grants
  // do.
  const armormech = packOptionActionsFor(
    [{ id: "engineer", subclass: "Armormech Engineering", level: 9 }],
    { "engineer|armormech modifications": ["absorption-shield"] },
  );
  assert.deepEqual(armormech.map((action) => action.name), ["Absorption Shield"]);
});

test("a stored pick's name rides the allowlist as picks-provenance", () => {
  // The picks are the pack's own machinery; a name already picked is
  // provenance the same way the grant's pool is (catalog.ts unions the two).
  assert.deepEqual(pickedOptionNamesFor({ options: { grants: [], picks: {} } }, "sentinel"), []);
  assert.deepEqual(
    pickedOptionNamesFor(
      { options: { grants: [], picks: { "sentinel|sentinel ideals": ["ideal-of-the-agile"] } } },
      "sentinel",
    ),
    ["Ideal of the Agile"],
  );
  // Another class's picks prove nothing here.
  assert.deepEqual(
    pickedOptionNamesFor(
      { options: { grants: [], picks: { "berserker|berserker instincts": ["fyrnocks-instinct"] } } },
      "sentinel",
    ),
    [],
  );
});

test("a grant whose option rows have not landed answers with its option_name", () => {
  // The scholar's 'Tech Amateur' grant carries refSlug no option row
  // describes; the allowlist falls back to the option_name the grant's
  // data_json carries.
  assert.deepEqual(packOptionNamesFor("scholar"), ["Wristpad Assist"]);
});

test("the allowlist reads the option names a class's grants declare", () => {
  assert.ok(packOptionNamesFor("sentinel").includes("Ideal of the Agile"));
  assert.ok(packOptionNamesFor("sentinel").includes("Ideal of the Fighter"));
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
  // The sentinel's real grants declare the ideals; Form of Ight — an option
  // row without a grant — is refused now, exactly as the gate promises.
  const sheet = taken({
    ...SENTINEL,
    features: [
      { name: "Force-Empowered Self", source: "class" },
      { name: "Ideal of the Agile", source: "story" },
    ],
  });
  assert.ok(
    sheet.features.some((feature) => feature.name === "Ideal of the Agile" && feature.source === "story"),
    JSON.stringify(sheet.features),
  );
});

test("a mechanical name without a pack grant is still refused", () => {
  // No class here is pack-declared 'Fighting Style': the allowlist is the
  // pack's provenance, not a name list, so an SRD fighter's bare
  // 'Fighting Style' stays refused on the import door as before.
  refused({ ...SENTINEL, class: "sentinel", features: [{ name: "Fighting Style", source: "story" }] });
  // Form of Ight is in the pack's options table, but no sentinel grant
  // declares it — the plan's lightsaber-form premise is not in the source —
  // so it is refused like any other unprovenanced mechanical name.
  refused({ ...SENTINEL, features: [{ name: "Form of Ight", source: "story" }] });
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
      { name: "Ideal of the Agile", source: "choice" },
    ],
  });
  assert.ok(sheet.features.some((feature) => feature.name === "Ideal of the Agile" && feature.source === "choice"));
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

// ---- the level-up picks (task B3) ----

const { buildLevelUp } = await import("../src/lib/srd/level-up.ts");

const BERSERKER = {
  ...SENTINEL,
  name: "Gruar", class: "berserker", level: 1, xp: 300,
  maxHp: 15, hitDice: { die: "d12", total: 1, spent: 0 },
  features: [{ name: "Rage", source: "class" }],
};

function levelUpContext(overrides = {}) {
  return {
    hpMethod: "average",
    multiclassAllowed: true,
    classOf: (id) => {
      const slug = String(id).toLowerCase();
      return classes.classes.some((entry) => entry.slug === slug)
        ? { id: slug, name: packClass(slug).data.name, ...grantsOf(slug) }
        : null;
    },
    racialCantrips: 0,
    spellOf: () => null,
    featOf: () => null,
    subclassOffered: () => false,
    rollDie: () => 3,
    ...overrides,
  };
}

const levelUp = (sheet, request, overrides) => buildLevelUp(sheet, request, levelUpContext(overrides));

test("a level-up pick lands in options.picks", () => {
  // Berserker 2: the instincts open, two picks earned. The request states
  // the grant's full final list; the patch carries the picks keyed
  // `${classId}|${name}`.
  const built = levelUp(BERSERKER, {
    level: 2,
    levelUpOptions: {
      "berserker|berserker instincts": ["fyrnocks-instinct", "loth-cats-instinct"],
    },
  });
  assert.ok(!("error" in built), JSON.stringify(built));
  assert.deepEqual(built.patch.options?.picks, {
    "berserker|berserker instincts": ["fyrnocks-instinct", "loth-cats-instinct"],
  });
});

test("the pick budget is the grant's earned count, not the player's wish", () => {
  // Two instincts are earned by 2nd level; a third is not, at any level.
  const built = levelUp(BERSERKER, {
    level: 2,
    levelUpOptions: {
      "berserker|berserker instincts": [
        "fighters-instinct",
        "fyrnocks-instinct",
        "loth-cats-instinct",
      ],
    },
  });
  assert.ok(
    "error" in built && /2 picks/.test(built.error),
    JSON.stringify(built.error ?? built),
  );
});

test("a pick outside the grant's pool is refused", () => {
  // Absorption Shield rides the engineer's armormech modifications, not the
  // berserker's instincts.
  const built = levelUp(BERSERKER, {
    level: 2,
    levelUpOptions: { "berserker|berserker instincts": ["absorption-shield"] },
  });
  assert.ok("error" in built && /not one of the options/.test(built.error), JSON.stringify(built.error ?? built));
});

test("an option picked twice is refused", () => {
  const built = levelUp(BERSERKER, {
    level: 2,
    levelUpOptions: { "berserker|berserker instincts": ["fyrnocks-instinct", "fyrnocks-instinct"] },
  });
  assert.ok("error" in built && /once/.test(built.error), JSON.stringify(built.error ?? built));
});

test("a pick names a grant the class taking the level opens", () => {
  // The armormech modifications ride the engineer, not the berserker taking
  // this level: the picks come with the class's own level.
  const built = levelUp(BERSERKER, {
    level: 2,
    levelUpOptions: { "engineer|armormech modifications": ["absorption-shield"] },
  });
  assert.ok(
    "error" in built && /not an option grant/.test(built.error),
    JSON.stringify(built.error ?? built),
  );
});

test("an archetype's picks ride the subclass, as the grants do", () => {
  // The armormech modifications are the Armormech Engineering's; a
  // subclassless engineer picks nothing.
  const ENGINEER = {
    ...SENTINEL, name: "Wex", class: "engineer", level: 2, xp: 900,
    maxHp: 10, hitDice: { die: "d8", total: 2, spent: 0 },
    features: [],
  };
  const built = levelUp(ENGINEER, {
    level: 3,
    subclass: "Armormech Engineering",
    levelUpOptions: { "engineer|armormech modifications": ["absorption-shield", "power-fist"] },
  }, { subclassOffered: () => true });
  assert.ok(!("error" in built), JSON.stringify(built));
  assert.deepEqual(built.patch.options?.picks?.["engineer|armormech modifications"], [
    "absorption-shield",
    "power-fist",
  ]);
});

test("a swap rides the grant's replacement right", () => {
  // The fixture's fighter carries the builder's row shape with the
  // replacement flag ON (every real row today carries false).
  const FIGHTER = {
    ...SENTINEL, name: "Vess", class: "fighter", level: 1, xp: 300,
    maxHp: 12, hitDice: { die: "d10", total: 2, spent: 0 },
    features: [],
  };
  const built = levelUp(
    { ...FIGHTER, options: { grants: [], picks: { "fighter|choose fighting style": ["formation-style"] } } },
    { level: 2, levelUpOptions: { "fighter|choose fighting style": ["area-style"] } },
  );
  assert.ok(!("error" in built), JSON.stringify(built));
  assert.deepEqual(built.patch.options?.picks?.["fighter|choose fighting style"], ["area-style"]);
});

test("a swap without the replacement right is refused", () => {
  // The instincts' real rows carry replacement: false at every level — a
  // pick is kept, and the next grant level adds, never swaps.
  const built = levelUp(
    { ...BERSERKER, level: 2, xp: 900, options: { grants: [], picks: { "berserker|berserker instincts": ["fyrnocks-instinct"] } } },
    { level: 3, levelUpOptions: { "berserker|berserker instincts": ["loth-cats-instinct"] } },
  );
  assert.ok(
    "error" in built && /permanent/.test(built.error),
    JSON.stringify(built.error ?? built),
  );
  // The same list WITH the held pick kept is the plain "one more at 3rd" —
  // budget two, held one, adding one: through.
  const kept = levelUp(
    { ...BERSERKER, level: 2, xp: 900, options: { grants: [], picks: { "berserker|berserker instincts": ["fyrnocks-instinct"] } } },
    { level: 3, levelUpOptions: { "berserker|berserker instincts": ["fyrnocks-instinct", "loth-cats-instinct"] } },
  );
  assert.ok(!("error" in kept), JSON.stringify(kept));
  assert.deepEqual(kept.patch.options?.picks?.["berserker|berserker instincts"], [
    "fyrnocks-instinct",
    "loth-cats-instinct",
  ]);
});

// The pack itself, when one is pointed at (the way the app and the other
// pack-backed tests read CONTENT_DB_PATH): the loader registers the options
// and the grants from the real tables.
const sw5ePackPath = process.env.SW5E_PACK_DB ?? path.resolve(here, "../../sw5e-odm-pack/sw5e.sqlite");
if (fs.existsSync(sw5ePackPath)) {
  process.env.CONTENT_DB_PATH = sw5ePackPath;
  // The world database the stored-sheet tests write to. Set BEFORE any
  // module that transitively loads the db layer (catalog.ts does): the path
  // and key are read at module load, so a later assignment would leave the
  // tests pinned to the app's own database.
  const os = await import("node:os");
  const { randomBytes } = await import("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-pack-options-"));
  process.on("exit", () => removeTempDir(dir));
  process.env.SQLITE_DB_PATH = path.join(dir, "world.sqlite");
  process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { getContentDb } = await import("../src/lib/content/db.ts");
  const { buildLevelUp: realLevelUp } = await import("../src/lib/srd/level-up.ts");
  const { legalityContextFor } = await import("../src/lib/characters/catalog.ts");

  test("the SW5e pack registers its options and grants from the real tables", () => {
    assert.ok(getContentDb(), "content pack opened");
    const instincts = packOptionGrantsFor("berserker").filter((row) => row.name === "Berserker Instincts");
    assert.ok(instincts.length >= 10, "berserker instinct grant rows registered");
    assert.deepEqual(instincts[0].choices, { 2: 2, 7: 1, 13: 1, 17: 1 });
    // The replacement right rides the same data_json, per level (every real
    // row today carries false — the picks are permanent).
    assert.deepEqual(instincts[0].replacement, { 2: false, 7: false, 13: false, 17: false });
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
    // And a real level-up pick lands in options.picks against the real pool.
    const built = realLevelUp(
      {
        ...SENTINEL, name: "Gruar", class: "berserker", level: 1, xp: 300,
        maxHp: 15, hitDice: { die: "d12", total: 1, spent: 0 },
        features: [{ name: "Rage", source: "class" }],
      },
      { level: 2, levelUpOptions: { "berserker|berserker instincts": ["fyrnocks-instinct"] } },
      {
        hpMethod: "average", multiclassAllowed: true, racialCantrips: 0,
        classOf: (id) => {
          const slug = String(id).toLowerCase();
          return classes.classes.some((entry) => entry.slug === slug)
            ? { id: slug, name: packClass(slug).data.name, ...grantsOf(slug) }
            : null;
        },
        spellOf: () => null, featOf: () => null, subclassOffered: () => false, rollDie: () => 3,
      },
    );
    assert.ok(!("error" in built), JSON.stringify(built));
    assert.deepEqual(built.patch.options?.picks?.["berserker|berserker instincts"], ["fyrnocks-instinct"]);
  });

  // The sheet itself: the options section is derived on read (never
  // stored), so a stored sentinel sheet reads back with the grants its
  // classes have opened, over a throwaway world database.
  const { getDatabase } = await import("../src/lib/db/core.ts");
  const { createUser } = await import("../src/lib/db/users.ts");
  const { createCampaign } = await import("../src/lib/db/campaigns.ts");
  const { createSheet, getSheetById, patchSheet } = await import("../src/lib/db/sheets.ts");
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
        features: [{ name: "Ideal of the Agile", source: "story" }],
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

  test("a stored sheet's picks ride the derived section and price into actions", () => {
    getDatabase();
    const dm = createUser("dm2", "x");
    const campaign = createCampaign(dm.id, {
      title: "Picks", description: "", theme: "", maxPlayers: 4, startingLevel: 9, difficulty: "normal",
    });
    const sheet = createSheet(
      campaign.id,
      dm.id,
      9,
      createSheetSchema.parse({
        name: "Gruar", race: "human", class: "berserker",
        abilities: { str: 16, dex: 14, con: 16, int: 9, wis: 9, cha: 9 },
        maxHp: 80, ac: 14, hitDice: { die: "d12", total: 9, spent: 0 },
        proficiencies: { saves: ["str", "con"], skills: [], languages: ["common"], tools: [], armor: [], weapons: [] },
        equipment: [], gold: 0,
      }),
    );
    // The picks are the level-up's settled record (options.picks), stored
    // while the grants themselves stay derived.
    const stored = patchSheet(sheet.id, {
      options: { picks: { "berserker|berserker instincts": ["fyrnocks-instinct", "loth-cats-instinct"] } },
    });
    assert.ok(stored, "patched");
    const read = getSheetById(sheet.id);
    assert.deepEqual(read?.options?.picks?.["berserker|berserker instincts"], [
      "fyrnocks-instinct",
      "loth-cats-instinct",
    ]);
    // The actions view, derived on read: two bonus-action instincts.
    const actions = read?.options?.actions ?? [];
    assert.deepEqual(
      actions.map((action) => [action.name, action.economy, action.family]),
      [
        ["Fyrnock's Instinct", "bonus", "invocation"],
        ["Loth-cat's Instinct", "bonus", "invocation"],
      ],
    );
    // A pick whose option carries no economy prices into no action.
    const quiet = patchSheet(sheet.id, {
      options: { picks: { "berserker|berserker instincts": ["fighters-instinct"] } },
    });
    assert.ok(quiet, "re-patched");
    assert.deepEqual(getSheetById(sheet.id)?.options?.actions ?? [], []);
  });

  test("the write door reads picks-provenance off the stored sheet", () => {
    // catalog.ts unions the grant pools with the names the sheet itself has
    // picked (pickedOptionNamesFor): a pick rides the same allowance
    // whichever door writes next, and stays per class.
    const bare = legalityContextFor({
      door: "library",
      level: 9,
      userId: "picker",
      sheet: { race: "human", class: "berserker", subclass: "", background: "" },
    });
    assert.ok(bare.packDeclaredOptions("berserker").includes("Fighter's Instinct"), "pool names");
    assert.ok(!bare.packDeclaredOptions("sentinel").includes("Fyrnock's Instinct"), "per class");
    const picked = legalityContextFor({
      door: "library",
      level: 9,
      userId: "picker",
      sheet: {
        race: "human", class: "berserker", subclass: "", background: "",
        options: { grants: [], picks: { "berserker|berserker instincts": ["fyrnocks-instinct"] } },
      },
    });
    assert.ok(picked.packDeclaredOptions("berserker").includes("Fyrnock's Instinct"), "picks-provenance");
  });
} else {
  console.log(`skip - pack-backed tests (no SW5e pack at ${sw5ePackPath}; set SW5E_PACK_DB)`);
}

console.log(`\ntest-sw5e-pack-options: ${passed} tests passed.`);
