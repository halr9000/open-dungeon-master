// The monster editor's closed groups say what they hold
// (src/app/workshop/bestiary/monster-folds.ts): a set part is never hidden
// unseen, and an empty one says what would go there.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const { monsterFoldSummary } = await import("../src/app/workshop/bestiary/monster-folds.ts");

const bare = { name: "Goblin", extraDamagePerRound: 0, stats: { traits: [], attacks: [] } };
assert.match(monsterFoldSummary("actions", bare), /^None yet/);
assert.match(monsterFoldSummary("spellcasting", bare), /^None/);
assert.equal(monsterFoldSummary("regeneration", bare), "None");
assert.equal(monsterFoldSummary("senses", bare), "None set");

const troll = {
  ...bare,
  stats: {
    traits: ["Keen Smell", "Regeneration"],
    attacks: [],
    routines: [[{ attack: "Bite", count: 1 }]],
    regeneration: { amount: 10, stoppedBy: ["acid", "fire"] },
    senses: { darkvision: 60 },
    skills: { perception: 2 },
    languages: "Giant",
  },
};
assert.equal(monsterFoldSummary("actions", troll), "a Multiattack routine · 2 trait lines");
assert.equal(monsterFoldSummary("regeneration", troll), "Regains 10 hit points a turn, stopped by acid or fire");
assert.equal(monsterFoldSummary("senses", troll), "1 skill · darkvision 60 ft · Giant");

const mage = { ...bare, stats: { traits: [], attacks: [], spellcasting: { dc: 14, attack: 6, slots: { 1: 4 }, spells: [{ name: "Magic Missile" }, { name: "Shield" }] } } };
assert.equal(monsterFoldSummary("spellcasting", mage), "2 spells · save DC 14 · +6 to hit");
console.log("test-monster-folds: ok");
