// Stage 1 of the reconciliation policy on its own
// (scripts/reconcile/core.mjs): pure, so the providers are synthetic — no
// pack database, no filesystem. The fixture is Maurice's real sheet
// (scripts/fixtures/maurice-sheet.json): the legacy-writer case the policy
// was written for — a name-spelled "nature" where the pack stores `nat`, and
// Techie's Technology grant the old writer never wrote.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { reconcileSheetSkills } = await import("../scripts/reconcile/core.mjs");

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

// A stand-in for the pack's active skill set: short-code ids, the names
// players spell ("Nature", "Technology") resolve by name.
const PACK = {
  ins: "Insight",
  med: "Medicine",
  lor: "Lore",
  nat: "Nature",
  tec: "Technology",
  pil: "Piloting",
  prc: "Perception",
};
const packResolver = (entry) => {
  const wanted = String(entry).trim();
  if (PACK[wanted]) {
    return { id: wanted, name: PACK[wanted] };
  }
  const found = Object.entries(PACK).find(([, name]) => name.toLowerCase() === wanted.toLowerCase());
  return found ? { id: found[0], name: found[1] } : null;
};
const noopResolver = () => null;

test("canonicalize rewrites a name-spelled entry to the pack id", () => {
  const sheet = { proficiencies: { skills: ["Nature"] } };
  const result = reconcileSheetSkills(sheet, {
    resolveEntry: packResolver,
    classOffers: ["Nature"],
    backgroundSkills: [],
  });
  assert.deepEqual(result.sheet.proficiencies.skills, ["nat"]);
  assert.equal(result.ops.length, 1);
  assert.equal(result.ops[0].op, "canonicalize");
  assert.equal(result.ops[0].from, "Nature");
  assert.equal(result.ops[0].to, "nat");
  assert.equal(result.summary.result, "success");
});

test("apply-missing-grant writes a recorded feat pick the list lacks", () => {
  const sheet = {
    proficiencies: { skills: ["ins"] },
    feats: ["Techie"],
    featChoices: { Techie: { skills: ["Technology"] } },
  };
  const result = reconcileSheetSkills(sheet, {
    resolveEntry: packResolver,
    classOffers: ["Insight"],
    feats: [{ name: "Techie", spec: { fixedSkills: [] }, picks: { skills: ["Technology"] } }],
  });
  assert.deepEqual(result.sheet.proficiencies.skills, ["ins", "tec"]);
  assert.deepEqual(
    result.ops.map((op) => op.op),
    ["apply-missing-grant"],
  );
  assert.equal(result.ops[0].to, "tec");
  assert.equal(result.summary.result, "success");
});

test("a second run on a fixed sheet is a no-op (idempotent)", () => {
  const sheet = {
    proficiencies: { skills: ["ins", "nature"] },
    feats: ["Techie", "Naturalist"],
    featChoices: { Techie: { skills: ["Technology"] }, Naturalist: { skills: ["Nature"] } },
  };
  const providers = {
    resolveEntry: packResolver,
    classOffers: ["Insight"],
    backgroundSkills: ["Insight", "Nature"],
    feats: [
      { name: "Techie", spec: { fixedSkills: [] }, picks: { skills: ["Technology"] } },
      { name: "Naturalist", spec: { fixedSkills: [] }, picks: { skills: ["Nature"] } },
    ],
  };
  const first = reconcileSheetSkills(sheet, providers);
  assert.equal(first.summary.applied, 2);
  const second = reconcileSheetSkills(first.sheet, providers);
  assert.deepEqual(second.sheet.proficiencies.skills, first.sheet.proficiencies.skills);
  assert.deepEqual(second.ops, []);
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(second.failures, []);
  assert.equal(second.summary.result, "success");
});

test("an orphan skill is flagged, never touched (partial)", () => {
  const sheet = { proficiencies: { skills: ["prc"] } };
  const result = reconcileSheetSkills(sheet, { resolveEntry: packResolver });
  assert.deepEqual(result.sheet.proficiencies.skills, ["prc"]);
  assert.deepEqual(result.ops, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "orphan-skill");
  assert.equal(result.warnings[0].entry, "prc");
  assert.match(result.warnings[0].evidence, /Perception/);
  assert.equal(result.summary.result, "partial");
});

test("an unresolvable entry is a failure, left as stored", () => {
  const sheet = { proficiencies: { skills: ["qqq"] } };
  const result = reconcileSheetSkills(sheet, { resolveEntry: packResolver });
  assert.deepEqual(result.sheet.proficiencies.skills, ["qqq"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, "unresolvable-skill");
  assert.equal(result.summary.result, "failure");
});

test("a pick under a feat the catalog does not know proves nothing", () => {
  const sheet = {
    proficiencies: { skills: ["ins"] },
    feats: ["Practiced"],
    featChoices: { Practiced: { skills: ["Nature"] } },
  };
  const result = reconcileSheetSkills(sheet, {
    resolveEntry: packResolver,
    classOffers: ["Insight"],
    feats: [{ name: "Practiced", spec: null, picks: { skills: ["Nature"] } }],
  });
  assert.deepEqual(result.sheet.proficiencies.skills, ["ins"]);
  assert.deepEqual(result.ops, []);
  assert.equal(result.warnings.some((w) => w.code === "feat-not-in-catalog"), true);
  assert.equal(result.summary.result, "partial");
});

test("a feat's fixed skills grant even with no pick recorded", () => {
  const sheet = { proficiencies: { skills: [] }, feats: ["Heavily Bridged"] };
  const result = reconcileSheetSkills(sheet, {
    resolveEntry: packResolver,
    feats: [{ name: "Heavily Bridged", spec: { fixedSkills: ["Technology"] }, picks: {} }],
  });
  assert.deepEqual(result.sheet.proficiencies.skills, ["tec"]);
  assert.equal(result.summary.result, "success");
});

// Maurice: the real legacy sheet. The providers stand in for what the pack
// answers (his background and class cover ins/med/lor; the feats are in the
// catalog): Stage 1 should canonicalize `nature` and write the missing `tec`
// in one clean pass — no agent needed.
test("Maurice's sheet reconciles in one clean pass", () => {
  const sheet = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/maurice-sheet.json", import.meta.url)), "utf8"));
  assert.deepEqual(sheet.proficiencies.skills, ["ins", "med", "lor", "nature"]);
  const result = reconcileSheetSkills(sheet, {
    resolveEntry: packResolver,
    classOffers: ["Insight", "Technology", "Piloting"],
    backgroundSkills: ["Insight", "Medicine", "Lore"],
    racialSkills: [],
    feats: [
      { name: "Techie", spec: { fixedSkills: [] }, picks: { skills: ["Technology"] } },
      { name: "Naturalist", spec: { fixedSkills: [] }, picks: { skills: ["Nature"] } },
    ],
  });
  assert.deepEqual(result.sheet.proficiencies.skills, ["ins", "lor", "med", "nat", "tec"]);
  assert.deepEqual(
    result.ops.map((op) => [op.op, op.from ?? "", op.to]),
    [
      ["canonicalize", "nature", "nat"],
      ["apply-missing-grant", "", "tec"],
    ],
  );
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.failures, []);
  assert.equal(result.summary.result, "success");
});

console.log(`test-reconcile-sheet: ${passed} passed`);
