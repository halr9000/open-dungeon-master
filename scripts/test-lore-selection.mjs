// Issue 305: which world lore entries ride a DM turn. Every close match up
// to a cap rides, a lone strong match rides alone, a tag the moment names
// gathers its small set, and the block fits a budget measured from the
// window by shortening excerpts before leaving anything out, naming what it
// left out. Pure: real lexical scores over a fixture corpus, made-up
// similarities where the meaning signal is under test.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { CLOSE_SHARE, LORE_BUDGET_MAX, LORE_BUDGET_MIN, LORE_PICK_MAX, loreBudgetChars, selectLore } = await import(
  "../src/lib/dm/lore-selection.ts"
);
const { computeIdf, lexicalScore } = await import("../src/lib/dm/fusion-logic.ts");
const { LORE_EXCERPT_STEPS, loreExcerpt, renderLoreBlock } = await import("../src/lib/dm/world-lore-logic.ts");
const { computeBudgets, promptWindowTokens, CHARS_PER_TOKEN } = await import("../src/lib/dm/context-budget.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const entry = (id, title, body, extra = {}) => ({
  id,
  campaignId: "c",
  category: "geography",
  title,
  body,
  tags: [],
  pinned: false,
  visibility: "party",
  imagePath: "",
  audience: null,
  attachmentPath: "",
  style: "plain",
  createdAt: "",
  updatedAt: "",
  ...extra,
});

// The scene with four ways in, and a city's worth of other lore.
const CORPUS = [
  entry("north", "The North Gate", "The North Gate of Vharn opens at dawn; the Watch checks every cart and turns away anyone without a writ."),
  entry("drowned", "The Drowned Gate", "Where the river enters Vharn, an old gate lies half under water. Swimmers can pass beneath it at low tide."),
  entry("tanners", "The Tanners' Gate", "The tanners' gate stinks of lye. Its guards take bribes and look the other way after dark."),
  entry("kings", "The Old King's Gate", "Bricked up a century ago, the old king's gate still has a postern the smugglers use."),
  entry("brewers", "The Brewers' Guild", "The guild sets the price of ale in Vharn and collects dues from every tavern keeper."),
  entry("moon", "Moon Worship", "The moon cult meets in the reed beds and sings to the drowned."),
  entry("salt", "The Salt Road", "Caravans carry salt north along the old road, three weeks to the mountain passes."),
  entry("harvest", "Harvest Festival", "At the end of summer the farmers burn a straw giant and dance until morning."),
  entry("lich", "The Lich of the Fens", "A lich sleeps beneath the fens and dreams of the kingdom it lost."),
  entry("ferry", "The Ferryman", "The ferryman charges a silver piece a head and never speaks of what he saw on the water."),
];

// The moment as context-retrieval.ts builds it: the scene line and the
// players' words, and the players' words alone as the ask.
const moment = (ask, scene = "Outside the walls of Vharn at dusk") => ({ scene, ask, query: [scene, ask].filter(Boolean).join("\n") });
function pick(ask, corpus = CORPUS, similarity = () => null, scene, askSimilarity = similarity) {
  const candidates = corpus.map((value) => ({
    id: value.id,
    title: value.title,
    tags: value.tags,
    body: value.body,
    similarity: similarity(value),
    askSimilarity: askSimilarity(value),
  }));
  return selectLore(candidates, moment(ask, scene), "english");
}

// What the default embedder (Xenova/all-MiniLM-L6-v2) answered for this
// city, "The <title>\n<body>" against the moment (scene line and ask) and
// against the ask alone, measured once and kept here so the meaning rule is
// tested on real numbers.
const MINILM = {
  ferryman: {
    whole: { ferry: 0.395, drowned: 0.372, brewers: 0.365, north: 0.33, tanners: 0.21, salt: 0.183, lich: 0.158, kings: 0.145, moon: 0.12, harvest: 0.072 },
    ask: { ferry: 0.453, drowned: 0.202, brewers: 0.2, salt: 0.188, kings: 0.14, north: 0.087, moon: 0.068, tanners: 0.052, lich: 0.027, harvest: 0.016 },
  },
  unseen: {
    whole: { north: 0.436, drowned: 0.393, lich: 0.295, tanners: 0.285, brewers: 0.268, moon: 0.16, salt: 0.146, kings: 0.13, ferry: 0.118, harvest: 0.078 },
    ask: { north: 0.261, lich: 0.256, drowned: 0.24, tanners: 0.224, moon: 0.174, kings: 0.16, salt: 0.145, ferry: 0.141, brewers: 0.07, harvest: 0.056 },
  },
};
const ids = (selection) => selection.picked.map((pick) => pick.id);

test("an ask for every way in brings all four gates and nothing else", () => {
  const selection = pick("What are all the gates we could use to get in?");
  assert.deepEqual(ids(selection).sort(), ["drowned", "kings", "north", "tanners"], JSON.stringify(selection));
  assert.ok(selection.picked.every((entry) => entry.reason.startsWith('the ask names it ("gate")')), JSON.stringify(selection.picked));
  assert.ok(!selection.held.some((held) => held.close), "nothing close was held back");
  assert.ok(!ids(selection).includes("brewers"), "the guild shares only the city's name");
});

test("one strong match rides alone, with no weak company", () => {
  const selection = pick("How much does the ferryman charge to cross?");
  assert.deepEqual(ids(selection), ["ferry"], JSON.stringify(selection));
  // No scene line and no name in the ask: the body decides. (Overlap cannot
  // tell an incidental rare word from the subject: "anyone" would match the
  // North Gate's "anyone without a writ" as strongly as "lye" matches the
  // tanners. The meaning signal separates those when the embedder runs.)
  assert.deepEqual(ids(pick("Where could we buy lye?", CORPUS, () => null, "")), ["tanners"]);
});

test("a moment that names nothing in the lore brings nothing", () => {
  const selection = pick("I draw my sword and wait.", CORPUS, () => null, "A clearing in the woods");
  assert.deepEqual(selection.picked, []);
});

test("meaning admits what stands out to both the moment and the ask, and nothing when it is flat", () => {
  const ask = "Where might we slip into the city unseen?";
  const near = { north: 0.71, drowned: 0.78, tanners: 0.8, kings: 0.76 };
  const selection = pick(ask, CORPUS, (value) => near[value.id] ?? 0.42 + (value.id.length % 3) * 0.02, "");
  assert.deepEqual(ids(selection).sort(), ["drowned", "kings", "north", "tanners"], JSON.stringify(selection));
  assert.ok(selection.picked.every((entry) => entry.reason.includes("meaning matches")));
  // Every entry as near as the next: no signal, nothing rides on meaning.
  const flat = pick(ask, CORPUS, () => 0.9, "");
  assert.deepEqual(flat.picked, []);
});

test("on the default embedder's own numbers: the scene's city name and a stray word in the ask pad nothing", () => {
  // The ferryman question: with the scene line the Drowned Gate, the guild
  // and the North Gate stand within half the way to the ferryman; asked
  // alone they do not. Only the ferryman rides.
  const ferry = pick("How much does the ferryman charge to take us across?", CORPUS, (value) => MINILM.ferryman.whole[value.id], undefined, (value) => MINILM.ferryman.ask[value.id]);
  assert.deepEqual(ids(ferry), ["ferry"], JSON.stringify(ferry));
  // Slipping in unseen: the ask alone puts the lich beside the North Gate;
  // with the scene it is far behind. The two gates both readings agree on ride.
  const unseen = pick("Where might we slip into the city unseen?", CORPUS, (value) => MINILM.unseen.whole[value.id], undefined, (value) => MINILM.unseen.ask[value.id]);
  assert.deepEqual(ids(unseen).sort(), ["drowned", "north"], JSON.stringify(unseen));
  assert.ok(unseen.held.some((held) => held.id === "lich" && !held.close) || !ids(unseen).includes("lich"));
});

test("a tag the ask names gathers its set; a word on everything is a theme, not a set", () => {
  const tagged = CORPUS.map((value) => (["north", "drowned", "tanners", "kings"].includes(value.id) ? { ...value, tags: ["entrances"] } : value));
  const selection = pick("Remind me of the entrances.", tagged);
  assert.deepEqual(ids(selection).sort(), ["drowned", "kings", "north", "tanners"]);
  assert.ok(selection.picked.every((entry) => entry.reason.startsWith('the ask names it ("entrances")')));
  const everywhere = CORPUS.map((value) => ({ ...value, tags: ["vharn"] }));
  const broad = pick("Let's go into Vharn.", everywhere);
  assert.deepEqual(ids(broad), [], `the city's own name does not pull the whole city in (${ids(broad)})`);
});

test("past the cap the close matches are held back, named as close", () => {
  const gates = Array.from({ length: 9 }, (_, index) => entry(`g${index}`, `Gate ${index}`, `Gate number ${index} of the city wall.`));
  // Nine gates in a city's worth of lore: a set, not the theme.
  const filler = Array.from({ length: 12 }, (_, index) => entry(`f${index}`, `Street ${index}`, `Cobbles and puddles on street ${index}.`));
  const selection = pick("Which gate do we take?", [...gates, ...CORPUS.slice(4), ...filler]);
  assert.equal(selection.picked.length, LORE_PICK_MAX);
  const capped = selection.held.filter((held) => held.close);
  assert.equal(capped.length, 3);
  assert.match(capped[0].reason, /^over the cap of 6 entries a turn \(the ask names it/);
  assert.equal(CLOSE_SHARE, 0.5);
});

test("the lore budget is measured from the window, inside its bounds", () => {
  let previous = 0;
  for (const window of [4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144]) {
    const retrieval = computeBudgets(promptWindowTokens(window, 9_000)).retrieval;
    const budget = loreBudgetChars(retrieval, 0);
    assert.ok(budget >= LORE_BUDGET_MIN && budget <= LORE_BUDGET_MAX, `${window}: ${budget}`);
    assert.ok(budget >= previous, "a larger window never shrinks it");
    if (retrieval * CHARS_PER_TOKEN >= LORE_BUDGET_MIN) {
      assert.ok(budget <= retrieval * CHARS_PER_TOKEN, `${window}: inside the retrieval share`);
    }
    previous = budget;
  }
  assert.equal(loreBudgetChars(2_000, 3_000), 5_000, "house rules come off the share");
  assert.equal(loreBudgetChars(0, 0), LORE_BUDGET_MIN);
  assert.equal(loreBudgetChars(Number.NaN, 0), LORE_BUDGET_MIN);
});

const long = (title, paragraphs, extra = {}) => entry(title.toLowerCase().replace(/\W+/g, "-"), title, paragraphs.join("\n\n"), extra);

test("concise excerpts let every pick fit before any is left out", () => {
  const picks = CORPUS.slice(0, 6).map((value) => ({ entry: { ...value, body: `${value.body} ${"More of the same history. ".repeat(20)}` }, reason: "words match" }));
  const wide = renderLoreBlock({ pinned: [], picked: picks, budget: 6_000 });
  assert.ok(picks.every(({ entry: value }) => wide.text.includes(value.title)));
  assert.ok(wide.trace.picks.every((pick) => pick.included && !/excerpt/.test(pick.reason)), "full excerpts when there is room");
  const tight = renderLoreBlock({ pinned: [], picked: picks, budget: 1_100 });
  assert.ok(tight.trace.picks.every((pick) => pick.included), "all six still ride");
  assert.match(tight.trace.picks[0].reason, /excerpt (220|160|120) characters/);
  assert.ok(tight.trace.chars <= tight.trace.budgetChars, `${tight.trace.chars} of ${tight.trace.budgetChars}`);
});

test("what the budget or the cap leaves out is named in the prompt and traced with its reason", () => {
  const pinned = Array.from({ length: 3 }, (_, index) => entry(`p${index}`, `Pinned ${index}`, "p".repeat(300), { pinned: true }));
  const picks = CORPUS.slice(0, 4).map((value) => ({ entry: value, reason: "words match" }));
  const held = [
    { entry: CORPUS[5], reason: "over the cap of 6 entries a turn (words match)", close: true },
    { entry: CORPUS[6], reason: "a near match (rank 7), not close enough to ride", close: false },
  ];
  const { text, trace } = renderLoreBlock({ pinned, picked: picks, held, budget: 1_300 });
  const lines = text.split("\n").slice(1);
  assert.ok(lines.slice(0, 3).every((line) => line.includes("Pinned")), "pinned first");
  const closing = lines.at(-1);
  assert.match(closing, /^Also bearing on this moment, left out for room \(search_lore reads them\): /);
  assert.ok(closing.includes(CORPUS[5].title), "a capped close match is named");
  assert.ok(!closing.includes(CORPUS[6].title), "a weak near match is not");
  const outByBudget = trace.picks.filter((pick) => !pick.included && /over the lore budget/.test(pick.reason));
  assert.ok(outByBudget.length >= 1, JSON.stringify(trace.picks));
  for (const pick of outByBudget) assert.ok(closing.includes(pick.title), `${pick.title} is named`);
  assert.ok(trace.picks.find((pick) => pick.id === CORPUS[6].id).weak);
  assert.ok(trace.chars <= trace.budgetChars, `${trace.chars} of ${trace.budgetChars}`);
  // Pinned entries that do not fit are held back the same way, never cut mid-list silently.
  const crowded = renderLoreBlock({ pinned: Array.from({ length: 8 }, (_, index) => entry(`q${index}`, `Pin ${index}`, "q".repeat(300), { pinned: true })), picked: picks, budget: 900 });
  assert.ok(crowded.trace.picks.some((pick) => pick.pinned && !pick.included && /pinned; held back/.test(pick.reason)));
  assert.match(crowded.text, /left out for room/);
});

test("a long body shows the passage nearest the moment; a secret keeps its marker", () => {
  const body = long("Chronicle", [
    "The founding of the city took three generations of stubborn farmers.",
    "x".repeat(200),
    "In the third winter the ferryman drowned and the river took his boat.",
    "y".repeat(200),
  ]);
  const query = "what happened to the ferryman";
  const idf = computeIdf([query], "english");
  const excerpt = loreExcerpt(body, 160, (text) => lexicalScore(query, text, idf, "english"));
  assert.match(excerpt, /ferryman drowned/);
  const secret = entry("s", "The Inn", `The inn is warm.\n\n:::secret\nThe innkeeper is the cult's ear.\n:::\n\n${"z".repeat(400)} ferryman`);
  const kept = loreExcerpt(secret, 160, (text) => lexicalScore(query, text, idf, "english"));
  assert.match(kept, /^The inn is warm\.\n\n\(SECRET, the party does not know: The innkeeper is the cult's ear\.\)/);
  assert.equal(loreExcerpt(entry("short", "Short", "Brief."), 300), "Brief.");
  assert.equal(LORE_EXCERPT_STEPS[0], 300, "the full excerpt is the old 300 characters");
});

test("a secret entry is marked in the prompt and in the trace", () => {
  const secret = entry("sec", "The Tanners' Bribe", "The captain of the tanners' gate is the cult's.", { visibility: "dm" });
  const { text, trace } = renderLoreBlock({ pinned: [], picked: [{ entry: secret, reason: "words match" }], budget: 1_000 });
  assert.match(text, /The Tanners' Bribe \(SECRET: the party does not know this\)/);
  assert.equal(trace.picks[0].secret, true);
});

test("a draft WorldForge holds back from players is marked as not the party's", () => {
  const draft = { ...entry("dft", "The Second Bell", "A bell rang under the harbour once.", {}), unpublished: true };
  const { text, trace } = renderLoreBlock({ pinned: [], picked: [{ entry: draft, reason: "words match" }], budget: 1_000 });
  assert.match(text, /The Second Bell \(NOT CANON YET: the party does not know this; use it only if it fits\)/);
  assert.equal(trace.picks[0].secret, true);
});

console.log(`test-lore-selection: ${passed} passed`);
