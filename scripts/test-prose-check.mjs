// Issue #302: the readability heuristic names suspicious prose without
// touching it, the overflow line says exactly what a cap would cut, and a
// long body answers a query with its nearest passage.
import assert from "node:assert/strict";
import { checkProse, overflowLine, proseWarningLine } from "../src/lib/workshop/prose-check.ts";
import { bestPassage, splitPassages } from "../src/lib/dm/passage.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
}

test("ordinary prose raises nothing", () => {
  assert.deepEqual(checkProse("The mill stands half-drowned. Its wheel still turns at night, which nobody can explain. Marla says it is the river."), []);
  assert.deepEqual(checkProse(""), []);
  assert.deepEqual(checkProse("Dr. Quist arrived. A.M. departure."), []);
});

test("joined sentences are counted and sampled", () => {
  const warnings = checkProse("The mill stands half-drowned.Its wheel still turns.Nobody can explain it.Marla says it is the river.");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "joined-sentences");
  assert.match(warnings[0].message, /^3 places read as a missing space/);
  assert.ok(warnings[0].samples[0].includes("drowned.Its"), warnings[0].samples[0]);
});

test("one joined pair is not a pattern", () => {
  assert.deepEqual(checkProse("Ask at the Salt.Anchor tavern, by the quay."), []);
});

test("a long run of letters is named", () => {
  const warnings = checkProse(`The keeper said ${"wordswithoutanyspacesbetweenthemforever".repeat(2)} and left.`);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "long-run");
  assert.match(warnings[0].message, /28 or more letters/);
});

test("prose with almost no spaces is flagged once", () => {
  const dense = Array.from({ length: 40 }, (_, i) => `w${i}`).join("") + "." + "x".repeat(10) + " y";
  const text = (dense + " ").repeat(3);
  const kinds = checkProse(text).map((warning) => warning.kind);
  assert.ok(kinds.includes("few-spaces") || kinds.includes("long-run"), kinds.join(","));
});

test("the warning line keeps the text and says so", () => {
  const line = proseWarningLine(checkProse("A road.The mill.The end."));
  assert.match(line, /missing space/);
  assert.match(line, /kept as it is/);
  assert.equal(proseWarningLine([]), "");
});

test("the overflow line says the lengths and the lost tail", () => {
  assert.equal(overflowLine("This card's text", "short", 4_000), "");
  const line = overflowLine("This card's text", `${"a".repeat(4_000)}The part that would be lost.`, 4_000);
  assert.match(line, /^This card's text is 4,028 characters; the limit is 4,000\. The last 28 would be lost: "The part that would be lost\."/);
});

test("passages split on paragraphs and long paragraphs at sentences", () => {
  const body = `First paragraph.\n\nSecond paragraph about the lighthouse keeper.\n\n${"A sentence of the long third paragraph. ".repeat(30)}`;
  const passages = splitPassages(body, 400);
  assert.equal(passages[0], "First paragraph.");
  assert.equal(passages[1], "Second paragraph about the lighthouse keeper.");
  assert.ok(passages.length > 3, "the long paragraph was not windowed");
  assert.ok(passages.slice(2).every((passage) => passage.length <= 400));
  assert.ok(passages[2].endsWith("."), "a window ends at a sentence");
});

test("the best passage is the one the scorer likes, the head otherwise", () => {
  const body = `The coast is grey and the villages poor.\n\n${"x".repeat(300)}\n\nThe lighthouse keeper, Ewan, drowned his brother in the cistern and tells nobody.`;
  const score = (passage) => (passage.toLowerCase().includes("lighthouse") ? 1 : 0);
  assert.match(bestPassage(body, score), /^The lighthouse keeper, Ewan/);
  assert.equal(bestPassage(body, () => 0), "The coast is grey and the villages poor.");
  assert.equal(bestPassage("", score), "");
});

console.log(`prose check: ${passed} tests passed`);
