// The name dice on the builder's first step: a roll fits the lineage chosen
// so far, a world pack's people come first, and a roll never hands back the
// name already in the field.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { rollHeroName } = await import("../src/app/characters/builder/heroNames.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("a dwarf's roll is a dwarf's name: a given name and a family name", () => {
  for (let index = 0; index < 50; index += 1) {
    const name = rollHeroName({ raceId: "hill_dwarf" });
    assert.match(name, /^\S+ \S+$/);
    assert.match(name.split(" ")[1], /Stoutheart|Ironfoot|Gravelbeard|Deepdelve|Hammerfall|Coppervein|Stonemantle/);
  }
});

test("before a lineage is chosen, the roll still gives a full name", () => {
  assert.match(rollHeroName({}), /^\S+ \S+$/);
});

test("a world pack's people are rolled instead", () => {
  const packNames = ["Maren Tidewright", "Oskel Brine"];
  for (let index = 0; index < 20; index += 1) {
    assert.ok(packNames.includes(rollHeroName({ raceId: "human", packNames })));
  }
});

test("a roll never repeats the name already in the field", () => {
  const packNames = ["Maren Tidewright", "Oskel Brine"];
  for (let index = 0; index < 20; index += 1) {
    assert.equal(rollHeroName({ packNames, current: "Maren Tidewright" }), "Oskel Brine");
  }
});

console.log(`\ntest-hero-names: ${passed} tests passed.`);
