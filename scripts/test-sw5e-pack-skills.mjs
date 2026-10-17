// The SW5e content pack's skills, replacing the bundled SRD set at mount
// (task B3a of the SW5e pack plan).
//
// Replacement semantics, the standing design rule: a mounted game pack
// REPLACES the bundled SRD content set, never merges. The pack's `skills`
// table (id/name/ability, parsed from the official Foundry config at build
// time) IS the active skill set when the pack is mounted — the SRD 18 minus
// arcana/history/religion, plus lore/piloting/technology at Intelligence,
// fifteen of them the same skills under the Foundry short codes. An SRD-only
// session (no pack, or a pack without the table — every Open5e pack today)
// keeps the bundled 18, byte-unchanged.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ---- SRD-only sessions: nothing registered ----
const { SRD_SKILLS, findSkill, computeSheetDerived } = await import("../src/lib/srd/index.ts");
const {
  activeSkills,
  findActiveSkill,
  activeSkillMatching,
  registerPackSkills,
  packSkills,
  packSkillsMounted,
} = await import("../src/lib/content/skills.ts");

test("an unmounted session keeps the bundled SRD 18, byte-unchanged", () => {
  assert.equal(packSkillsMounted(), false);
  assert.equal(activeSkills(), SRD_SKILLS, "the same array, not a copy");
  assert.equal(SRD_SKILLS.length, 18);
  assert.ok(SRD_SKILLS.some((skill) => skill.id === "arcana"));
  assert.ok(SRD_SKILLS.some((skill) => skill.id === "history"));
  assert.ok(SRD_SKILLS.some((skill) => skill.id === "religion"));
  assert.ok(!SRD_SKILLS.some((skill) => skill.id === "lore"));
});

test("an unmounted session resolves bundled skill ids", () => {
  assert.equal(findSkill("arcana")?.name, "Arcana");
  assert.equal(findActiveSkill("sleight_of_hand")?.ability, "dex");
  assert.equal(findActiveSkill("no-such-skill"), null);
  assert.equal(activeSkillMatching("perception")?.id, "perception");
});

test("registering nothing changes nothing", () => {
  // A pack without a skills table registers no rows: the loader's guard.
  registerPackSkills([]);
  assert.equal(packSkillsMounted(), false);
  assert.equal(packSkills().length, 0);
  assert.equal(activeSkills(), SRD_SKILLS);
  assert.equal(findSkill("religion")?.id, "religion");
});

// ---- the SW5e pack mounted: the pack's table replaces the SRD set ----
const here = path.dirname(fileURLToPath(import.meta.url));
const sw5ePackPath = process.env.SW5E_PACK_DB ?? path.resolve(here, "../../sw5e-odm-pack/sw5e.sqlite");
if (fs.existsSync(sw5ePackPath)) {
  process.env.CONTENT_DB_PATH = sw5ePackPath;
  // The unmounted phase may have opened a default pack (the checkout's own
  // Open5e pack): the memoized handle must go so the loader reads the pack
  // this test points at.
  globalThis.__odmContentDb = undefined;
  const { getContentDb, contentPackInstalled } = await import("../src/lib/content/db.ts");
  const { backgroundMechanics, skillsInText } = await import("../src/lib/content/mechanics.ts");

  test("the mounted pack's skills table replaces the SRD set", () => {
    assert.ok(getContentDb(), "content pack opened");
    assert.equal(contentPackInstalled(), true);
    assert.equal(packSkillsMounted(), true);
    const skills = activeSkills();
    assert.equal(skills.length, 18, "18 pack skills, not 18 SRD + 18 pack");
    assert.deepEqual(
      skills.map((skill) => skill.id),
      ["acr", "ani", "ath", "dec", "ins", "inv", "itm", "lor", "med", "nat", "per", "pil", "prc", "prf", "slt", "ste", "sur", "tec"],
    );
    for (const gone of ["arcana", "history", "religion"]) {
      assert.ok(!skills.some((skill) => skill.id === gone), `${gone} replaced away`);
    }
    // The three additions, at Intelligence, with the pack's own names.
    assert.deepEqual(
      skills.filter((skill) => ["lor", "pil", "tec"].includes(skill.id)).map((skill) => [skill.name, skill.ability]),
      [
        ["Lore", "int"],
        ["Piloting", "int"],
        ["Technology", "int"],
      ],
    );
  });

  test("replacement, never a merge: the SRD ids are not offered beside the pack's", () => {
    const ids = activeSkills().map((skill) => skill.id);
    // The pack's ids are the Foundry short codes; the bundled long ids ride
    // no list beside them.
    assert.ok(!ids.includes("acrobatics"));
    assert.ok(!ids.includes("animal_handling"));
    assert.ok(!ids.includes("sleight_of_hand"));
    // and the derivation resolves the pack's ids, not the bundled ones
    assert.equal(findSkill("tec")?.ability, "int");
    assert.equal(findSkill("acrobatics"), null);
    assert.equal(findActiveSkill("per")?.name, "Persuasion");
  });

  test("a bundled skill id resolves to the active set's equivalent by name", () => {
    // Fifteen skills map 1:1 by name, not by id: the passive-perception
    // style lookups that name a bundled id find the pack's row for it.
    assert.equal(activeSkillMatching("perception")?.id, "prc");
    assert.equal(activeSkillMatching("perception")?.ability, "wis");
    assert.equal(activeSkillMatching("investigation")?.id, "inv");
    // arcana is gone with the pack: nothing answers for it.
    assert.equal(activeSkillMatching("arcana"), null);
  });

  test("a SW5e background's choose-two line parses as a choice over the pack's skills", () => {
    // Jensaarai's line, verbatim from the pack — one of 61 backgrounds the
    // pack writes "Choose two from ...". Lore resolves because the parser
    // reads the ACTIVE set (the pack's rows), not the bundled SRD's.
    const grants = backgroundMechanics({
      skill_proficiencies: "Choose two from Insight, Intimidation, Lore, and Perception",
      languages: "One of your choice",
    });
    assert.deepEqual(grants.skills, [], "no fixed skills: the line is all choice");
    assert.deepEqual(grants.skillChoice, { count: 2, from: ["ins", "itm", "lor", "prc"] });
    // The builder's filter admits it: exactly two skills to train.
    assert.equal(grants.skills.length + (grants.skillChoice?.count ?? 0), 2);
    // The pack's other non-SRD skills resolve by name too.
    assert.deepEqual(skillsInText("Piloting and Technology"), ["pil", "tec"]);
    // A fixed-skills line under the pack reads the pack's ids.
    assert.deepEqual(skillsInText("Athletics and Stealth"), ["ath", "ste"]);
  });

  test("the derived sheet reads the active set", () => {
    const derived = computeSheetDerived({
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
      level: 1,
      proficiencies: { saves: [], skills: ["prc"], expertise: [] },
      spellcasting: null,
    });
    // WIS +1, proficient (+2): the pack's id is derived like any bundled id.
    assert.equal(derived.skills.prc, 3);
    assert.equal(derived.skills.arcana, undefined, "no SRD skill beside the pack's");
    // Passive Perception rides the pack's Perception row (prc): 10 + 3.
    assert.equal(derived.passivePerception, 13);
  });
} else {
  console.log(`skip - pack-backed tests (no SW5e pack at ${sw5ePackPath}; set SW5E_PACK_DB)`);
}

console.log(`\ntest-sw5e-pack-skills: ${passed} tests passed.`);
