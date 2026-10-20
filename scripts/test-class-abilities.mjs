// "Place them for a fighter" on the builder's Abilities step: the standard
// array and a thrown pool laid on the abilities in the class's order, and the
// line that names what the class leans on. A first-time player otherwise
// spreads the 15 at random.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { abilityPriority, keyAbilities, poolSlotsFor, standardFor } = await import(
  "../src/app/characters/builder/classAbilities.ts"
);

const ARRAY = [15, 14, 13, 12, 10, 8];
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("every order names all six abilities once", () => {
  for (const id of ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard", "artificer", "some-homebrew"]) {
    const order = abilityPriority({ id, spellAbility: "wis", saves: ["dex", "wis"] });
    assert.equal(new Set(order).size, 6, id);
  }
});

test("a fighter's 15 goes on Strength and the 14 on Constitution", () => {
  const scores = standardFor({ id: "fighter" }, ARRAY);
  assert.equal(scores.str, 15);
  assert.equal(scores.con, 14);
  assert.equal(scores.cha, 8);
  assert.deepEqual(Object.values(scores).sort((a, b) => a - b), [...ARRAY].sort((a, b) => a - b));
});

test("a wizard's 15 goes on Intelligence", () => {
  assert.equal(standardFor({ id: "wizard" }, ARRAY).int, 15);
});

test("the key abilities follow the multiclass table", () => {
  assert.deepEqual(keyAbilities({ id: "fighter" }), [["str"], ["dex"]]);
  assert.deepEqual(keyAbilities({ id: "paladin" }), [["str", "cha"]]);
});

test("a class the table does not list leans on its casting ability, then Constitution", () => {
  const order = abilityPriority({ id: "not-a-real-class", spellAbility: "cha", saves: ["wis", "cha"] });
  assert.equal(order[0], "cha");
  assert.equal(order[1], "con");
});

test("a thrown pool puts its highest total on the first ability", () => {
  const totals = [9, 17, 12, 15, 8, 13];
  const slots = poolSlotsFor({ id: "rogue" }, totals);
  assert.equal(totals[slots.dex], 17);
  assert.equal(totals[slots.con], 15);
  assert.equal(new Set(Object.values(slots)).size, 6, "each throw on one ability");
});

console.log(`\ntest-class-abilities: ${passed} tests passed.`);
