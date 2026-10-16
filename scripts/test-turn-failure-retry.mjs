// The model failing partway through a DM turn, and the lead's Retry. The
// pieces had tests of their own (the retry rules in test-retry-turn.mjs are
// pure, the backend's socket-drop retry in test-backend-fetch.mjs), but the
// fake model never failed, so no test ran a turn into a backend error or
// pressed Retry: the halted notice and its link, the turn parked as failed,
// work already applied not being applied again, and the route re-entering
// the saved conversation through the queue to narrate once.
//
// The scripted fake model (scripts/lib/enforce-narrator.mjs) fails a call
// with failure(): an HTTP 500 with an OpenAI-style error body.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call, failure, fakeModel, reply, settleQueue } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-turn-failure-retry");

const { listRecentMessages, findMessageForDmTurn } = await import("../src/lib/db/messages.ts");
const { getDmTurn, getLatestDmTurnId } = await import("../src/lib/db/dm-turns.ts");
const { getDmStatus } = await import("../src/lib/dm/status.ts");
const { DM_HALTED_PREFIX } = await import("../src/lib/campaign-types.ts");

const RETRY_NOTE = /interrupted by an internal error/;

async function retry(world, user, turnId) {
  const route = await world.route("campaigns/[campaignId]/dm-turn/retry");
  world.signIn(user);
  const response = await route.POST(
    new Request("http://test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId }),
    }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  const json = await response.json().catch(() => ({}));
  await settleQueue(world.campaignId);
  return { status: response.status, json };
}

const narrations = (world) => listRecentMessages(world.campaignId, 50).filter((message) => message.authorType === "dm");
const notices = (world) =>
  listRecentMessages(world.campaignId, 50).filter(
    (message) => message.authorType === "system" && message.content.startsWith(DM_HALTED_PREFIX),
  );

async function table() {
  const world = await openWorld({ gameSettings: { ttsEnabled: false } });
  const kara = world.addHero({ name: "Kara", class: "fighter", level: 1 });
  const model = await fakeModel();
  model.pointAt(world);
  return { world, kara, model };
}

await test("A backend error after the turn granted gold parks it as failed with a notice the lead can retry; Retry narrates once and never grants the gold again.", async () => {
  const { world, kara, model } = await table();
  const goldBefore = world.sheet(kara.id).gold;
  const grant = call("modify_gold", { characterId: kara.id, delta: 10, reason: "the council's advance" });
  model.script([reply({ calls: [grant] }), failure(500)]);
  const halted = await model.turn(world, "I take the council's job.", kara.id);
  assert.equal(halted, null, "a halted turn posted narration");

  const turnId = getLatestDmTurnId(world.campaignId);
  assert.equal(getDmTurn(turnId).status, "failed");
  assert.equal(getDmStatus(world.campaignId), "idle", "the table is left waiting on a DM that stopped");
  const [notice] = notices(world);
  assert.ok(notice, "the table was not told the DM stopped");
  assert.equal(notice.dmTurnId, turnId, "the notice does not link the turn to retry");
  assert.equal(world.sheet(kara.id).gold, goldBefore + 10, "the gold granted before the failure");

  model.script([reply({ text: "Mother Hesk counts ten gold onto the table." })]);
  const retried = await retry(world, world.owner, turnId);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(getDmTurn(turnId).status, "done");
  assert.equal(getDmStatus(world.campaignId), "idle", "the retried turn left the table waiting on the DM");
  const said = narrations(world);
  assert.equal(said.length, 1, `expected one narration, found ${said.length}`);
  assert.match(said[0].content, /counts ten gold/);
  assert.equal(world.sheet(kara.id).gold, goldBefore + 10, "the retry granted the gold again");
  // The narration links the turn (for a reroll of its prose); the notice
  // must not any more, or it would still offer a Retry.
  assert.ok(!notices(world)[0].dmTurnId, "the notice still offers a Retry for a finished turn");
  assert.equal(findMessageForDmTurn(turnId)?.id, said[0].id);

  // The retry re-entered the saved conversation: the player's line, the
  // gold's call and its result are all in it, so the model can see the gold
  // was granted and has no reason to grant it again, and the model is told
  // an attempt was interrupted. script() cleared the requests, so the first
  // one is the re-entered call.
  const resumed = model.requests[0];
  const sent = JSON.stringify(resumed.messages);
  assert.match(sent, RETRY_NOTE);
  assert.match(sent, /I take the council's job/, "the retry lost the player's action");
  assert.ok(
    resumed.messages.some((message) => message.role === "assistant" && message.tool_calls?.some((toolCall) => toolCall.id === grant.id)),
    "the retry lost the gold's call",
  );
  assert.ok(
    model.results(resumed).some((entry) => entry.id === grant.id && entry.result.ok),
    "the retry lost the gold's result, so the model would grant it again",
  );

  const again = await retry(world, world.owner, turnId);
  assert.equal(again.status, 409);
  assert.match(again.json.error ?? "", /already finished/);
  assert.equal(narrations(world).length, 1, "a second Retry narrated again");
  model.close();
  world.close();
});

await test("A backend error is written to the server log with its status and the backend's own words, which stay out of the table's notice.", async () => {
  const { world, kara, model } = await table();
  model.script([failure(500, "CUDA out of memory while allocating KV cache on gpu-box-7.internal")]);
  const logged = [];
  const realError = console.error;
  console.error = (...args) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await model.turn(world, "I look for the sexton.", kara.id);
  } finally {
    console.error = realError;
  }
  const line = logged.find((entry) => entry.includes("[dm-turn]"));
  assert.ok(line, `the failed call was not logged: ${JSON.stringify(logged)}`);
  assert.match(line, /\(500\)/, "the log line lost the status");
  assert.match(line, /CUDA out of memory/, "the log line lost what the backend said");
  const [notice] = notices(world);
  assert.ok(notice, "the table was not told the DM stopped");
  assert.doesNotMatch(notice.content, /CUDA|gpu-box/, "the backend's words reached the table");
  model.close();
  world.close();
});

await test("Only the lead can retry a halted turn.", async () => {
  const { world, kara, model } = await table();
  const brom = world.addHero({ name: "Brom", class: "cleric", level: 1 });
  model.script([failure(500)]);
  await model.turn(world, "I look around the square.", kara.id);
  const turnId = getLatestDmTurnId(world.campaignId);
  assert.equal(getDmTurn(turnId).status, "failed");

  const refused = await retry(world, { id: world.sheet(brom.id).userId }, turnId);
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
  assert.equal(getDmTurn(turnId).status, "failed", "a refused retry moved the turn");
  model.close();
  world.close();
});

await test("A retry that fails again leaves a fresh notice with the link, and a second Retry finishes the turn.", async () => {
  const { world, kara, model } = await table();
  model.script([failure(500)]);
  await model.turn(world, "I knock on the sexton's door.", kara.id);
  const turnId = getLatestDmTurnId(world.campaignId);

  model.script([failure(503, "The backend is restarting.")]);
  const first = await retry(world, world.owner, turnId);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(getDmTurn(turnId).status, "failed", "the second failure did not park the turn");
  assert.equal(getDmStatus(world.campaignId), "idle", "a retry that failed left the table waiting on the DM");
  assert.equal(notices(world).length, 2, "the second failure was not reported");
  assert.equal(findMessageForDmTurn(turnId)?.id, notices(world).at(-1).id, "the fresh notice does not carry the link");

  model.script([reply({ text: "Nobody answers; the door gives a little under your knuckles." })]);
  const second = await retry(world, world.owner, turnId);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(getDmTurn(turnId).status, "done");
  assert.equal(narrations(world).length, 1);
  const sent = JSON.stringify(model.requests[0].messages);
  assert.equal(sent.match(new RegExp(RETRY_NOTE.source, "g"))?.length, 1, "the retry note was stacked twice");
  model.close();
  world.close();
});

await test("A main call that starts repeating one long passage is stopped with the halted notice, its tool call never runs, and the lead's Retry narrates once.", async () => {
  const { world, kara, model } = await table();
  const goldBefore = world.sheet(kara.id).gold;
  const passage =
    "Mother Hesk leans across the table, her ledger open to a page of names struck through in red ink, and taps the last one twice as the rain drums on the shutters.";
  assert.ok(passage.length >= 160);
  model.script([
    reply({
      text: (passage + "\n\n").repeat(6),
      calls: [call("modify_gold", { characterId: kara.id, delta: 10, reason: "the council's advance" })],
    }),
  ]);
  const halted = await model.turn(world, "I take the council's job.", kara.id);
  assert.equal(halted, null, "the loop was posted as narration");

  const turnId = getLatestDmTurnId(world.campaignId);
  assert.equal(getDmTurn(turnId).status, "failed");
  assert.equal(getDmStatus(world.campaignId), "idle");
  const [notice] = notices(world);
  assert.ok(notice, "the table was not told the DM stopped");
  assert.match(notice.content, /repeating the same long passage/);
  assert.equal(notice.dmTurnId, turnId, "the notice does not link the turn to retry");
  assert.equal(model.served(), 1, "the halted call was asked again inside the turn");
  assert.equal(world.sheet(kara.id).gold, goldBefore, "a tool call from the cut stream ran");

  model.script([reply({ text: "Mother Hesk slides the job's seal across the table." })]);
  const retried = await retry(world, world.owner, turnId);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(getDmTurn(turnId).status, "done");
  const said = narrations(world);
  assert.equal(said.length, 1, `expected one narration, found ${said.length}`);
  assert.match(said[0].content, /slides the job's seal/);
  assert.ok(!said[0].content.includes(passage), "the loop reached the narration");
  model.close();
  world.close();
});

finish();
