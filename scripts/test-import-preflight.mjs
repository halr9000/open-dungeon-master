// Issue #301: the import plan names, before the button, every card the
// arc's caps would leave out, says that every card is kept whole, and
// passes on the readability notes (issue #302). Pure, like the planner.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { planImport } = await import("../src/lib/workshop/import.ts");
const { emptyExisting, emptySource } = await import("../src/lib/workshop/import-kinds.ts");
const { ARC_LIMITS } = await import("../src/lib/dm/arc-logic.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
}

function board({ beats = 0, moments = 0, proseNotes = [] } = {}) {
  return {
    links: { npcs: [], maps: [], encounters: [], locations: [] },
    common: null,
    beats: Array.from({ length: beats }, (_, i) => `Beat ${i + 1}: a thing`),
    beatTitles: Array.from({ length: beats }, (_, i) => `Beat ${i + 1}`),
    moments,
    momentTitles: Array.from({ length: moments }, (_, i) => `Moment ${i + 1}`),
    arcProblem: "",
    proseNotes,
  };
}

function plan(extra) {
  return planImport({
    selection: ["storyboard"],
    source: { ...emptySource(), storyboard: [{ id: "board", name: "The board" }] },
    existing: emptyExisting(),
    ...extra,
  });
}

const messages = (list) => list.map((entry) => entry.message);

test("a board that fits says every card is kept whole and warns of nothing", () => {
  const result = plan({ board: board({ beats: 50, moments: 30 }) });
  assert.ok(!messages(result.warnings).some((line) => /cannot join/.test(line)), messages(result.warnings).join("\n"));
  assert.ok(messages(result.notes).some((line) => /kept whole as a prep card/.test(line) && /read_card/.test(line)));
  assert.equal(result.board.newBeats, 50);
});

test("a fresh arc past the beat cap names the cards left out", () => {
  const result = plan({ board: board({ beats: ARC_LIMITS.beats + 3 }) });
  const warning = messages(result.warnings).find((line) => /cannot join it/.test(line));
  assert.ok(warning, messages(result.warnings).join("\n"));
  assert.match(warning, new RegExp(`An arc holds ${ARC_LIMITS.beats} beats; the board's last 3 cannot join it: "Beat ${ARC_LIMITS.beats + 1}", "Beat ${ARC_LIMITS.beats + 2}", "Beat ${ARC_LIMITS.beats + 3}"`));
  assert.match(warning, /keep their full text as a prep card/);
  assert.equal(result.board.newBeats, ARC_LIMITS.beats);
});

test("more than four cards left out are counted after the first four", () => {
  const result = plan({ board: board({ beats: ARC_LIMITS.beats + 9 }) });
  const warning = messages(result.warnings).find((line) => /cannot join it/.test(line));
  assert.match(warning, /"Beat \d+", "Beat \d+", "Beat \d+", "Beat \d+" and 5 more/);
});

test("moments past the arc's event room are named, and the room is what is not pending", () => {
  const result = plan({
    board: board({ beats: 2, moments: 4 }),
    targetArc: { beats: ["Old beat one", "Old beat two"], acts: 1, room: 100, actRoom: true, eventRoom: 2 },
    arcMode: "append",
  });
  const warning = messages(result.warnings).find((line) => /cannot join it/.test(line));
  assert.ok(warning, messages(result.warnings).join("\n"));
  assert.match(warning, /room for 2 more planned events \(it holds \d+\); 2 of the board's 4 scenes on routes cannot join it: "Moment 3", "Moment 4"/);
  assert.match(warning, /keep their full text as a prep card/);
  assert.match(warning, /the arc will not offer them as a planned event/);
});

test("a fresh import counts the event cap when there is no arc yet", () => {
  const result = plan({ board: board({ beats: 2, moments: ARC_LIMITS.events + 1 }) });
  const warning = messages(result.warnings).find((line) => /scenes on routes cannot join it/.test(line));
  assert.ok(warning, messages(result.warnings).join("\n"));
  assert.match(warning, new RegExp(`1 of the board's ${ARC_LIMITS.events + 1} scenes on routes cannot join it: "Moment ${ARC_LIMITS.events + 1}"`));
});

test("a board joining a long arc names the beats past its room, skipping ones it already has", () => {
  const result = plan({
    board: board({ beats: 5 }),
    targetArc: { beats: ["Beat 2: a thing"], acts: 1, room: 2, actRoom: true, eventRoom: 10 },
    arcMode: "append",
  });
  const warning = messages(result.warnings).find((line) => /cannot join it/.test(line));
  assert.ok(warning, messages(result.warnings).join("\n"));
  // Beat 2 is already in the arc; of the fresh four, two fit and "Beat 4"
  // and "Beat 5" are named.
  assert.match(warning, /room for 2 more beats \(it holds \d+\); the last 2 of the board's cannot join it: "Beat 4", "Beat 5"/);
  assert.equal(result.board.newBeats, 2);
});

test("readability notes ride as notes, not warnings, and name the card", () => {
  const result = plan({
    board: board({ beats: 2, proseNotes: [{ title: "The mill", message: "3 places read as a missing space after a sentence. It may have been written this way; the text is kept as it is." }] }),
  });
  assert.ok(messages(result.notes).some((line) => /^"The mill" may read oddly: 3 places/.test(line)), messages(result.notes).join("\n"));
  assert.ok(!messages(result.warnings).some((line) => /read oddly/.test(line)));
});

console.log(`import preflight: ${passed} tests passed`);
