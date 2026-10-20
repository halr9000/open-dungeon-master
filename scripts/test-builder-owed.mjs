// The builder's "choices left on this step" (src/app/characters/builder/
// owed.ts, submit.ts *Blocks): every pick a step still holds, once per
// block, and the gate is always the first of them.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);
const submit = await import("../src/app/characters/builder/submit.ts");
const { owedHeadline, owedPicks } = await import("../src/app/characters/builder/owed.ts");

const state = { name: "", backgroundSkills: [], bonusLanguages: [], racialAsi: [], racialSkills: [], feats: [], repeatSkills: [] };
const background = { id: "pack_bg", name: "Wanderer", skills: [], skillChoice: { count: 2, from: ["athletics", "survival", "stealth"] }, languages: 1 };
const halfElf = { id: "half_elf", name: "Half-Elf", skills: [], bonusLanguages: 1, asiChoice: { count: 2 }, skillChoice: { count: 2 } };

// Identity: the name and the background's skills, in the gate's order.
const identity = submit.identityBlocks(state, background);
assert.deepEqual(identity.map((entry) => entry.target), ["name", "backgroundSkills"]);
assert.deepEqual(submit.identityBlocker(state, background), identity[0]);
assert.deepEqual(submit.identityBlocks({ ...state, name: "Wren", backgroundSkills: ["athletics", "stealth"] }, background), []);

// Ancestry: no race is the only thing said until one is chosen.
assert.deepEqual(submit.ancestryBlocks(state, undefined).map((entry) => entry.target), ["race"]);
const ancestry = submit.ancestryBlocks(state, halfElf, background);
assert.deepEqual(ancestry.map((entry) => entry.target), ["languages", "racialAsi", "racialSkills"]);
assert.deepEqual(submit.ancestryBlocker(state, halfElf, background), ancestry[0], "the gate is the first owed");

// Abilities: no scores is the only thing said.
assert.deepEqual(submit.abilitiesBlocks({ abilities: null }).map((entry) => entry.target), ["scores"]);

// One link per block, in a player's words; the headline counts them.
const picks = owedPicks([...ancestry, { target: "languages", message: "again" }]);
assert.deepEqual(picks.map((entry) => entry.label), ["Languages", "Ability bonus", "Race skills"]);
assert.equal(picks[0].message, ancestry[0].message);
assert.equal(owedHeadline(picks.length), "Three choices left on this step");
assert.equal(owedHeadline(1), "One choice left on this step");
assert.equal(owedHeadline(0), null);
console.log("test-builder-owed: ok");
