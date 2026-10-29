// Two gear-step defects in the character builder.
//
// Changing one either-or line of the class kit, or the weapon named for one
// of its open slots, brought back every kit item the player had removed,
// from every line. Now only the items of the line that changed come back;
// every other removal stands.
//
// The gear shelf offered magic items under "Ask your DM before starting
// with one of these", though the purse refuses every magic item and no
// table rule lets a DM allow one. They are off the shelf and out of its
// search until such a rule exists; the server still refuses them.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { openBuilder } = await import("./lib/enforce-builder.mjs");
const { builderActions } = await import("../src/app/characters/builder/useBuilderDerived.ts");
const { GEAR_SHELF, isMagicRow } = await import("../src/app/characters/builder/EquipmentSection.tsx");
const kits = await import("../src/lib/srd/starting-kit.ts");
const { judgeStartingGear } = await import("../src/lib/srd/starting-wealth.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const builder = await openBuilder();
const barbarian = builder.classes.find((entry) => entry.id === "barbarian");
const kit = kits.classKitFor("barbarian");

// A builder state whose kit setters apply their update in place, so a test
// reads what one tap of the gear step leaves behind.
function stateWith(fields) {
  const state = builder.stateOf({ kitChoices: { options: [], picks: [] }, ...fields });
  const apply = (key) => (next) => {
    state[key] = typeof next === "function" ? next(state[key]) : next;
  };
  state.setKitChoices = apply("kitChoices");
  state.setRemovedAutoNames = apply("removedAutoNames");
  state.setEquipment = apply("equipment");
  return state;
}

test("each line of the barbarian's kit names its own items", () => {
  assert.deepEqual(kits.kitLineNames(kit, null, 0), ["Greataxe"]);
  assert.deepEqual(kits.kitLineNames(kit, { options: [0, 1], picks: ["Club"] }, 1), ["Club"]);
  assert.ok(kits.kitLineNames(kit, null, 2).includes("Javelin"));
  assert.equal(kits.kitLineOfSlot(kit, { options: [1, 1], picks: [] }, 0), 0);
  assert.equal(kits.kitLineOfSlot(kit, { options: [1, 1], picks: [] }, 1), 1);
  assert.equal(kits.kitLineOfSlot(kit, { options: [0, 0], picks: [] }, 0), -1);
});

test("a new choice on one line keeps the removals from every other line", () => {
  const state = stateWith({ removedAutoNames: ["Greataxe", "Javelin"] });
  builderActions(state, barbarian).chooseKitOption(1, 1);
  assert.deepEqual(state.kitChoices.options, [0, 1, 0]);
  assert.deepEqual(state.removedAutoNames, ["Greataxe", "Javelin"]);
});

test("a new choice on a line brings back that line's removed items", () => {
  const state = stateWith({ removedAutoNames: ["Handaxe", "Javelin"] });
  builderActions(state, barbarian).chooseKitOption(1, 1);
  builderActions(state, barbarian).chooseKitOption(1, 0);
  assert.deepEqual(state.removedAutoNames, ["Javelin"]);
});

test("naming another weapon for a slot brings back only that slot's line", () => {
  const state = stateWith({ kitChoices: { options: [0, 1, 0], picks: ["Spear"] }, removedAutoNames: ["Spear", "Javelin"] });
  builderActions(state, barbarian).pickKitSlot(0, "Club");
  assert.deepEqual(state.kitChoices.picks, ["Club"]);
  assert.deepEqual(state.removedAutoNames, ["Javelin"]);
});

test("the pack the builder shows keeps a removed item off after another line changes", () => {
  const state = stateWith({ removedAutoNames: ["Javelin"] });
  builderActions(state, barbarian).chooseKitOption(1, 1);
  const { derived } = builder.build({
    race: "human",
    class: "barbarian",
    background: "acolyte",
    kitChoices: state.kitChoices,
    removedAutoNames: state.removedAutoNames,
  });
  const names = derived.fullEquipment.map((item) => item.name);
  assert.ok(!names.includes("Javelin"), names.join(", "));
  assert.ok(names.includes("Spear"), names.join(", "));
  assert.ok(!names.includes("Handaxe"), names.join(", "));
});

test("the gear shelf offers no magic items", () => {
  assert.deepEqual(GEAR_SHELF.map((section) => section.params?.kind), ["weapon", "armor", "gear"]);
  assert.ok(!GEAR_SHELF.some((section) => /magic/i.test(`${section.key} ${section.label} ${section.note ?? ""}`)));
});

test("the gear search leaves magic rows out", () => {
  assert.equal(isMagicRow({ name: "Bag of Holding", slug: "bag-of-holding", kind: "magic_item" }), true);
  assert.equal(isMagicRow({ name: "Odd Charm", slug: "odd-charm", kind: "gear", price: { copper: null, magic: true } }), true);
  assert.equal(isMagicRow({ name: "Rope", slug: "rope", kind: "gear", price: { copper: 100, magic: false } }), false);
  assert.equal(isMagicRow({ name: "Longsword", slug: "longsword", kind: "weapon" }), false);
});

test("the purse still refuses a magic item", () => {
  const verdict = judgeStartingGear({
    equipment: [{ name: "Bag of Holding", qty: 1 }],
    freeKit: [],
    coinCopper: 1_000_000,
    priceOf: () => ({ copper: null, magic: true }),
  });
  assert.ok(verdict.problems.some((problem) => problem.includes("magic item")), JSON.stringify(verdict));
});

console.log(`\n${passed} passed`);
