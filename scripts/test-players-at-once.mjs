// Two players acting at the same moment, through the door they use (the
// actions route). The DM's queue runs one turn per campaign at a time, and
// requestDmTurn coalesces: moves that land while a turn is still answering
// share one follow-up turn instead of stacking a turn each
// (src/lib/dm/loop.ts, src/lib/dm/queue.ts). A spotlight on several players
// waits for the last of them and then answers all of them at once. The
// pieces had tests of their own, but none posted a second player's move
// while a turn was running, or answered a spotlight through the route.
//
// The first test found a lost move. A move posted while the model was still
// thinking (before any narration streamed) took the seq above the narration,
// so the follow-up turn found the DM's message last, took everything as
// answered and skipped. The narration now holds its place from the turn's
// start (src/lib/dm/narration-slot.ts).
//
// The fake model holds a reply back (held() in scripts/lib/enforce-narrator.mjs),
// so the turn is still mid-answer while the test acts.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call, failure, fakeModel, held, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-players-at-once");

const { listRecentMessages } = await import("../src/lib/db/messages.ts");
const { getFloor } = await import("../src/lib/db/campaigns.ts");
const { dmQueueDepth } = await import("../src/lib/dm/queue.ts");
const { getLatestDmTurnId } = await import("../src/lib/db/dm-turns.ts");

async function until(what, check, ms = 30_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (world) => until("the DM queue to run dry", () => dmQueueDepth(world.campaignId) === 0);

// One move through the actions route, as the composer sends it.
async function act(world, user, content, kind = "do") {
  const route = await world.route("campaigns/[campaignId]/actions");
  world.signIn(user);
  const response = await route.POST(
    new Request("http://test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, kind }),
    }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const transcript = (world) =>
  listRecentMessages(world.campaignId, 50)
    .filter((message) => message.authorType === "player" || message.authorType === "dm")
    .map((message) => message.content);
const sent = (request) => JSON.stringify(request.messages);

async function table() {
  const world = await openWorld({ gameSettings: { ttsEnabled: false } });
  const kara = world.addHero({ name: "Kara", class: "fighter", level: 1 });
  const bram = world.addHero({ name: "Bram", class: "rogue", level: 1 });
  const model = await fakeModel();
  model.pointAt(world);
  return { world, kara, bram, karaUser: world.owner, bramUser: { id: bram.userId }, model };
}

await test("Moves that land while the DM is still answering share one follow-up turn that reads them all, and each narration sits after the moves it answers.", async () => {
  const { world, karaUser, bramUser, model } = await table();
  const first = held(reply({ text: "The chapel door is old oak, swollen with river damp. What do you do?" }));
  model.script([first.entry, reply({ text: "Somewhere above, a shutter bangs once and goes still. What do you do?" })]);

  assert.equal((await act(world, karaUser, "I knock on the chapel door.")).status, 202);
  await until("the first turn to reach the model", () => model.requests.length === 1);

  assert.equal((await act(world, bramUser, "I watch the upper windows.")).status, 202);
  assert.equal((await act(world, karaUser, "I knock again, louder.")).status, 202);
  assert.equal((await act(world, bramUser, "back in a sec", "ooc")).status, 202);
  first.release();
  await settle(world);

  assert.equal(model.served(), 2, `expected the first turn and one follow-up, the model answered ${model.served()} times`);
  assert.doesNotMatch(sent(model.requests[0]), /upper windows/, "the first turn read a move sent after it began");
  assert.match(sent(model.requests[1]), /upper windows/, "the follow-up never read Bram's move");
  assert.match(sent(model.requests[1]), /knock again, louder/, "the follow-up never read Kara's second move");
  assert.deepEqual(transcript(world), [
    "I knock on the chapel door.",
    "The chapel door is old oak, swollen with river damp. What do you do?",
    "I watch the upper windows.",
    "I knock again, louder.",
    "(ooc) back in a sec",
    "Somewhere above, a shutter bangs once and goes still. What do you do?",
  ]);
  model.close();
  world.close();
});

await test("A move posted while a retried turn is still thinking is answered too, and sits after the narration the retry wrote.", async () => {
  const { world, karaUser, bramUser, model } = await table();
  model.script([failure(500)]);
  assert.equal((await act(world, karaUser, "I knock on the chapel door.")).status, 202);
  await settle(world);
  const turnId = getLatestDmTurnId(world.campaignId);

  const retried = held(reply({ text: "The chapel door is old oak, swollen with river damp. What do you do?" }));
  model.script([retried.entry, reply({ text: "Somewhere above, a shutter bangs once and goes still. What do you do?" })]);
  const route = await world.route("campaigns/[campaignId]/dm-turn/retry");
  world.signIn(karaUser);
  const response = await route.POST(
    new Request("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId }) }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  assert.equal(response.status, 200);
  await until("the retried turn to reach the model", () => model.requests.length === 1);

  assert.equal((await act(world, bramUser, "I watch the upper windows.")).status, 202);
  retried.release();
  await settle(world);

  assert.equal(model.served(), 2, `expected the retry and one follow-up, the model answered ${model.served()} times`);
  assert.match(sent(model.requests[1]), /upper windows/, "the follow-up never read Bram's move");
  assert.deepEqual(transcript(world), [
    "I knock on the chapel door.",
    "The chapel door is old oak, swollen with river damp. What do you do?",
    "I watch the upper windows.",
    "Somewhere above, a shutter bangs once and goes still. What do you do?",
  ]);
  model.close();
  world.close();
});

await test("Table talk sent while the DM is answering wakes no second turn.", async () => {
  const { world, karaUser, bramUser, model } = await table();
  const first = held(reply({ text: "Fog curls over the quay. What do you do?" }));
  model.script([first.entry]);

  await act(world, karaUser, "I look for the ferryman.");
  await until("the turn to reach the model", () => model.requests.length === 1);
  await act(world, bramUser, "is anyone else hungry", "ooc");
  await act(world, karaUser, "always", "ooc");
  first.release();
  await settle(world);

  assert.equal(model.served(), 1, "table talk woke the DM");
  model.close();
  world.close();
});

await test("A spotlight on two players waits for both, refuses a third player meanwhile, and answers both in one turn.", async () => {
  const { world, kara, bram, karaUser, bramUser, model } = await table();
  const cass = world.addHero({ name: "Cass", class: "cleric", level: 1 });
  model.script([
    reply({
      text: "The ferryman looks from Kara to Bram. Kara, Bram, what do you each do?",
      calls: [call("request_player_input", { characterIds: [kara.id, bram.id], prompt: "Kara, Bram, what do you each do?" })],
    }),
  ]);
  await act(world, karaUser, "I ask the ferryman about the bell.");
  await settle(world);
  const spotlight = getFloor(world.campaignId);
  assert.equal(spotlight.mode, "spotlight", `the DM's request_player_input left the floor ${spotlight.mode}`);
  assert.deepEqual([...spotlight.userIds].sort(), [kara.userId, bram.userId].sort());

  model.script([reply({ text: "Tam's hands stop on the rope. \"I don't know anything about a bell.\" What do you do?" })]);

  assert.equal((await act(world, karaUser, "I lean on the rail and wait.")).status, 202);
  await settle(world);
  assert.equal(model.served(), 0, "one answer of two woke the DM");
  assert.deepEqual(getFloor(world.campaignId).respondedUserIds, [kara.userId]);

  const refused = await act(world, { id: cass.userId }, "I cut in and ask about the sexton.");
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /waiting on Bram/);
  assert.ok(!transcript(world).includes("I cut in and ask about the sexton."), "a refused move was posted");

  assert.equal((await act(world, bramUser, "I watch his hands.")).status, 202);
  await settle(world);
  assert.equal(model.served(), 1, "the last answer should wake exactly one turn");
  assert.match(sent(model.requests[0]), /lean on the rail/);
  assert.match(sent(model.requests[0]), /watch his hands/);
  assert.equal(getFloor(world.campaignId).mode, "open", "the floor stayed on the spotlight once both answered");
  model.close();
  world.close();
});

finish();
