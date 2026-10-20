// Every class's job in a fight (Tank, DPS, Healer, Support, Control,
// Utility) and which of the core four it plays like: the bundled classes
// carry both in their data files, and any other class gets a reading of its
// numbers, marked as suggested.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { CLASS_ROLES, classRoles } = await import("../src/lib/srd/class-roles.ts");
const { SRD_CLASSES } = await import("../src/lib/srd/index.ts");
const { CUSTOM_CLASSES } = await import("../src/lib/classes/index.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("every bundled class has one or two known roles and a plays-like line", () => {
  for (const klass of [...SRD_CLASSES, ...CUSTOM_CLASSES]) {
    assert.ok(klass.roles?.length >= 1 && klass.roles.length <= 2, `${klass.id} roles`);
    for (const role of klass.roles) assert.ok(CLASS_ROLES.includes(role), `${klass.id}: ${role}`);
    assert.ok(klass.playsLike, `${klass.id} playsLike`);
    assert.equal(classRoles(klass).suggested, false, klass.id);
  }
});

test("a content pack's row for a bundled class reads the bundled entry's", () => {
  assert.deepEqual(classRoles({ id: "paladin" }), { roles: ["Tank", "Healer"], playsLike: "Fighter + Cleric", suggested: false });
});

test("a class no file describes is read from its numbers, as a suggestion", () => {
  assert.deepEqual(classRoles({ id: "brew-medic", casterType: "half", spellAbility: "wis", spellListFrom: "cleric" }), {
    roles: ["Healer", "Support"],
    playsLike: "Cleric",
    suggested: true,
  });
  assert.equal(classRoles({ id: "brew-guard", hitDie: 12, armor: ["heavy", "shields"], casterType: "none" }).roles[0], "Tank");
  assert.equal(classRoles({ id: "brew-sneak", hitDie: 8, armor: ["light"], casterType: "none" }).playsLike, "Rogue");
  assert.equal(classRoles({ id: "brew-mage", casterType: "full", spellAbility: "int" }).roles[0], "Control");
});

console.log(`\ntest-class-roles: ${passed} tests passed.`);
