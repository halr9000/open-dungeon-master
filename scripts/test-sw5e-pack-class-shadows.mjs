// The content pack's classes shadow the bundled SRD ones, pack-wins (task
// B3a of the SW5e pack plan).
//
// catalog.ts classGrantsFor read the bundled row first: it was the one the
// engines' own tables are keyed by, and the Open5e pack's copy of an SRD
// class says the same in prose. But a mounted pack REPLACES the bundled
// content set, never merges (the standing design rule) — and the SW5e
// pack's fighter and monk share the bundled slugs while saying very
// different things (blasters and vibroweapons, not "simple and martial
// weapons"). When the pack is mounted and declares a class row for the id,
// the pack's row answers; a class the pack does not declare (the SW5e pack
// has no bard) still reads bundled, and a bundled-only session reads
// bundled first exactly as it always has — document-in-id disambiguation
// (issue #115) included.
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

// ---- a bundled-only session: no pack mounted ----
// Pinned before any import touches the database layer.
process.env.CONTENT_DB_PATH = "/nonexistent";

const { classGrantsFor } = await import("../src/lib/characters/catalog.ts");

test("a bundled-only session reads the bundled fighter", () => {
  const grants = classGrantsFor("fighter");
  assert.ok(grants, "fighter found");
  assert.equal(grants.id, "fighter");
  assert.equal(grants.hitDie, 10);
  assert.deepEqual(grants.saves, ["str", "con"]);
  assert.equal(grants.documentSlug, undefined, "the bundled row, not a pack row");
  assert.deepEqual(grants.armor, ["light", "medium", "heavy", "shields"]);
  assert.deepEqual(grants.weapons, ["simple", "martial"]);
  assert.deepEqual(grants.skillChoices, {
    count: 2,
    from: ["acrobatics", "animal_handling", "athletics", "history", "insight", "intimidation", "perception", "survival"],
  });
});

test("a bundled-only session answers only for bundled ids", () => {
  // The document-in-id disambiguation (issue #115): an id carrying a
  // document prefix is a pack row's reading, and with no pack mounted
  // nothing answers for it.
  assert.equal(classGrantsFor("sw5e-fighter"), null);
  assert.equal(classGrantsFor("no-such-class"), null);
});

// ---- the SW5e pack mounted: its rows shadow the bundled slugs ----
const here = path.dirname(fileURLToPath(import.meta.url));
const sw5ePackPath = process.env.SW5E_PACK_DB ?? path.resolve(here, "../../sw5e-odm-pack/sw5e.sqlite");
if (fs.existsSync(sw5ePackPath)) {
  process.env.CONTENT_DB_PATH = sw5ePackPath;
  // The bundled-only phase memoized the no-pack answer; the handle must go
  // so the loader reads the pack this test points at.
  globalThis.__odmContentDb = undefined;
  const { contentPackInstalled } = await import("../src/lib/content/db.ts");

  test("the pack's fighter wins over the bundled SRD fighter", () => {
    assert.equal(contentPackInstalled(), true);
    const grants = classGrantsFor("fighter");
    assert.ok(grants, "fighter found");
    assert.ok(grants.documentSlug, "the pack row answers, not the bundled one");
    assert.equal(grants.name, "Fighter");
    assert.equal(grants.hitDie, 10);
    assert.deepEqual(grants.saves, ["str", "con"]);
    // Its own proficiencies, not the bundled sentence's: the SW5e fighter
    // trains blasters and vibroweapons, and no shield category the pack row
    // does not declare.
    assert.deepEqual(grants.armor, ["Light armor", "Medium armor", "Heavy armor"]);
    assert.deepEqual(grants.weapons, [
      "Simple blasters",
      "Martial blasters",
      "Simple vibroweapons",
      "Martial vibroweapons",
    ]);
  });

  test("the pack's monk wins too", () => {
    const grants = classGrantsFor("monk");
    assert.ok(grants, "monk found");
    assert.ok(grants.documentSlug, "the pack row answers");
    assert.deepEqual(grants.saves, ["str", "dex"]);
    assert.deepEqual(grants.armor, []);
    assert.ok(grants.weapons.includes("Simple blasters"));
    assert.ok(grants.weapons.includes("mvb:vibroblade"));
    assert.ok(!grants.weapons.includes("simple"), JSON.stringify(grants.weapons));
    assert.ok(!grants.weapons.includes("martial"));
  });

  test("a class the pack does not declare still reads bundled", () => {
    const bard = classGrantsFor("bard");
    assert.ok(bard, "bard found");
    assert.equal(bard.documentSlug, undefined, "the bundled row");
    assert.equal(bard.hitDie, 8);
  });

  test("the pack class's skill choices come from the pack's skill set", () => {
    // The pack rows declare no skill choices of their own (prof_skills is
    // empty); the fallback pool is the active skill set — the pack's 18 —
    // never the SRD's beside it.
    const from = classGrantsFor("fighter").skillChoices.from;
    assert.equal(classGrantsFor("fighter").skillChoices.count, 2);
    for (const gone of ["arcana", "history", "religion"]) {
      assert.ok(!from.includes(gone), `${gone} not offered`);
    }
    for (const added of ["lor", "pil", "tec"]) {
      assert.ok(from.includes(added), `${added} offered`);
    }
  });
} else {
  console.log(`skip - pack-backed tests (no SW5e pack at ${sw5ePackPath}; set SW5E_PACK_DB)`);
}

console.log(`\ntest-sw5e-pack-class-shadows: ${passed} tests passed.`);
