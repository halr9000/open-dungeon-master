// World-lore-builder logic: entry normalization, keyword scoring, and the
// budgeted WORLD LORE prompt block.
import assert from "node:assert/strict";
import {
  normalizeLoreInput,
  renderLoreForPrompt,
} from "../src/lib/dm/world-lore-logic.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
}

function entry(overrides = {}) {
  return {
    id: "e1",
    campaignId: "c1",
    category: "factions",
    title: "The Ashen League",
    body: "A merchant cabal running the salt roads; they mark members with a grey ring tattoo.",
    tags: ["merchants", "salt"],
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("normalizeLoreInput validates and bounds", () => {
  assert.equal(normalizeLoreInput({ category: "nonsense", title: "x", body: "y" }), null);
  assert.equal(normalizeLoreInput({ category: "magic", title: "", body: "y" }), null);
  assert.equal(normalizeLoreInput({ category: "magic", title: "x", body: "  " }), null);
  const ok = normalizeLoreInput({
    category: "geography",
    title: `  ${"t".repeat(200)}`,
    body: "b".repeat(9000),
    tags: ["one", "", 5, "two", ...Array(20).fill("x")],
  });
  assert.equal(ok.title.length, 120);
  // Bounded at the bundle's cap (issue #302), so 9,000 characters stay whole.
  assert.equal(ok.body.length, 9000);
  assert.equal(normalizeLoreInput({ category: "magic", title: "x", body: "b".repeat(30_000) }).body.length, 20_000);
  assert.ok(ok.tags.includes("one") && ok.tags.includes("two"));
  assert.ok(ok.tags.length <= 8);
  assert.ok(!ok.tags.includes(""));
});

test("renderLoreForPrompt pins first, dedupes, and clips", () => {
  const pinned = entry({ id: "p1", title: "Pinned Truth", body: "z".repeat(600) });
  const also = entry({ id: "r1", title: "Retrieved" });
  const block = renderLoreForPrompt([pinned], [also, pinned], 1600);
  assert.ok(block.startsWith("WORLD LORE"));
  assert.equal(block.match(/Pinned Truth/g).length, 1);
  assert.ok(block.indexOf("Pinned Truth") < block.indexOf("Retrieved"));
  // Bodies clip to ~300 chars per entry.
  assert.ok(!block.includes("z".repeat(400)));
});

test("renderLoreForPrompt says retrieved entries are the nearest matches, and only when there are some", () => {
  // Retrieval has no relevance cut-off, so the DM is told what it got.
  const retrieved = renderLoreForPrompt([], [entry({ id: "r1", title: "Retrieved" })], 1600);
  assert.ok(retrieved.startsWith("WORLD LORE (established by the party lead; treat as canon. The entries picked"));
  assert.match(retrieved, /nearest matches, nearest first; use only those that bear on it\):/);
  // Pinned entries are the lead's choice, not a pick: unchanged.
  const pinned = renderLoreForPrompt([entry({ id: "p1", title: "Pinned" })], [], 1600);
  assert.ok(pinned.startsWith("WORLD LORE (established by the party lead; treat as canon):\n"));
});

test("renderLoreForPrompt respects the budget and empty case", () => {
  const entries = Array.from({ length: 10 }, (_, index) =>
    entry({ id: `e${index}`, title: `Entry ${index}`, body: "b".repeat(300) }),
  );
  const block = renderLoreForPrompt([], entries, 800);
  // The entry lines and the closing line stay inside the budget; the header
  // is outside it, as it always was.
  const [header, ...body] = block.split("\n");
  assert.ok(header.startsWith("WORLD LORE"));
  assert.ok(body.join("\n").length <= 800, `${body.join("\n").length} characters`);
  // Shorter excerpts fit more entries than the old 300-character cut did, and
  // what still does not fit is named, never silently missing (issue #305).
  assert.ok(body.filter((line) => line.startsWith("- [")).length >= 3);
  assert.ok(!body.some((line) => line.startsWith("- [history] Entry 9:")));
  assert.match(body.at(-1), /^Also bearing on this moment, left out for room \(search_lore reads them\): .*Entry 9/);
  assert.equal(renderLoreForPrompt([], [], 1600), "");
});

console.log(`test-lore-builder: ${passed} tests passed`);

// ---- issue #302: the editor's cap matches the bundle's, and overflow is named ----

{
  const { LORE_BODY_MAX, loreBodyOverflow } = await import("../src/lib/dm/world-lore-logic.ts");
  assert.equal(LORE_BODY_MAX, 20_000, "the lore cap no longer matches what a bundle entry can carry");
  const whole = normalizeLoreInput({ category: "history", title: "The long chronicle", body: "a".repeat(20_000) });
  assert.equal(whole.body.length, 20_000, "a bundle-sized body lost its tail on edit");
  assert.equal(loreBodyOverflow("short"), "");
  assert.equal(loreBodyOverflow(undefined), "");
  const over = loreBodyOverflow(`${"a".repeat(20_000)}the tail`);
  assert.match(over, /^This entry is 20,008 characters; the limit is 20,000\. The last 8 would be lost: "the tail"\./);
  console.log("lore cap: bundle-sized bodies edit whole, overflow is named");
}
