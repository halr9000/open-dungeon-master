// The lobby's "what happens next" line (src/lib/dm/lobby-next.ts): every
// seat is told its own next move, waiting names the people waited on, and
// the line agrees with the Begin button's blocker.
import assert from "node:assert/strict";
import { lobbyNext } from "../src/lib/dm/lobby-next.ts";

const base = { solo: false, isDm: false, hasSheet: true, ready: true, canStart: false, blocker: "", needHero: [], notReady: [] };

assert.equal(lobbyNext({ ...base, hasSheet: false, ready: false }).tone, "do");
assert.match(lobbyNext({ ...base, hasSheet: false, ready: false }).text, /choose your hero/);
assert.match(lobbyNext({ ...base, ready: false }).text, /ready up/);
assert.match(lobbyNext({ ...base, isDm: true, hasSheet: false, ready: false }).text, /yours to open/, "the DM needs no hero");
assert.deepEqual(lobbyNext({ ...base, blocker: "Waiting for everyone to ready up.", notReady: ["Ada", "Bram", "Cole"] }), {
  text: "Waiting for Ada, Bram and 1 more to ready up.",
  tone: "wait",
});
assert.match(lobbyNext({ ...base, blocker: "Every player needs a character before the adventure starts.", needHero: ["Ada"] }).text, /Ada to choose a hero/);
assert.equal(lobbyNext({ ...base, blocker: "Waiting for a player to join." }).text, "Waiting for a player to join.", "a blocker with no names says itself");
assert.deepEqual(lobbyNext({ ...base, canStart: true }), { text: "Everyone is ready. Begin the adventure.", tone: "go" });
assert.equal(lobbyNext({ ...base }).tone, "wait", "a ready player who cannot begin waits on the owner or the DM");
assert.match(lobbyNext({ ...base, solo: true, hasSheet: false }).text, /choose your hero/);
assert.equal(lobbyNext({ ...base, solo: true }).tone, "go");
console.log("test-lobby-next: ok");
