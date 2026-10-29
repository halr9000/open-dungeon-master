// "Good fits" in the lineage carousel: the core classes a lineage's bonuses
// suit, read from the multiclass table's key abilities.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { lineageFits } = await import("../src/app/characters/builder/lineageFits.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("a +2 Strength lineage suits the Strength classes", () => {
  assert.deepEqual(lineageFits({ asi: { str: 2, con: 1 } }), { kind: "classes", names: ["Barbarian", "Fighter", "Paladin"] });
});

test("a +2 Charisma lineage suits the Charisma casters", () => {
  assert.deepEqual(lineageFits({ asi: { cha: 2 } }).names, ["Bard", "Paladin", "Sorcerer", "Warlock"]);
});

test("a +2 Constitution lineage is read by its smaller bump", () => {
  assert.deepEqual(lineageFits({ asi: { con: 2, wis: 1 } }).names, ["Cleric", "Druid", "Monk", "Ranger"]);
});

test("bumps to all six, or bumps all the player's own, suit any class", () => {
  assert.deepEqual(lineageFits({ asi: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 } }), { kind: "any" });
  assert.deepEqual(lineageFits({ asi: {}, asiChoice: { count: 2, amount: 1 } }), { kind: "any" });
});

test("no bonuses at all say nothing", () => {
  assert.equal(lineageFits({ asi: {} }), null);
});

console.log(`\ntest-lineage-fits: ${passed} tests passed.`);
