// Issue 207: the table's text boxes say their limit, and the routes refuse
// with it. Ask turned away a 501-character question with "Invalid question."
// and nothing on screen to warn; the action box did the same at 2,001 with
// "Invalid action."; a public direction was cut at 1,000 without a word.
// Held here:
//
//   the limits each box shows (composerLimit) are the routes' own; a
//   question up to 2,000 characters is asked and kept whole, and handed
//   back whole as the thread for a follow-up; over its limit every route
//   names the limit and the length, and stores nothing.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-input-limits");

const limits = await import("../src/lib/text-limits.ts");
const { MAX_ABSOLUTE_COMMAND_LENGTH } = await import("../src/lib/dm/director-logic.ts");
const { QUESTION_MAX_CHARS } = await import("../src/lib/dm/ask-logic.ts");
const { listAsksForUser } = await import("../src/lib/db/asks.ts");
const { listRecentMessages } = await import("../src/lib/db/messages.ts");

async function post(table, user, name, body) {
  const route = await table.route(name);
  table.signIn(user);
  const response = await route.POST(
    new Request("http://test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ campaignId: table.campaignId }) },
  );
  return { status: response.status, json: await response.json() };
}

await test("each composer mode's limit is the one its route keeps", () => {
  assert.equal(limits.composerLimit("do", false), 2_000);
  assert.equal(limits.composerLimit("say", false), 2_000);
  assert.equal(limits.composerLimit("ooc", false), 2_000);
  assert.equal(limits.composerLimit("narrate", false), 8_000);
  assert.equal(limits.composerLimit("lead", false), 1_000);
  assert.equal(limits.composerLimit("lead", true), MAX_ABSOLUTE_COMMAND_LENGTH);
  assert.equal(limits.textLength("  four  "), 4);
  assert.equal(
    limits.tooLongMessage("A move", 2_000, 2_345),
    "A move can be up to 2,000 characters; this one has 2,345. Shorten it and send it again.",
  );
});

const world = await openWorld();
const hero = world.addHero({ name: "Tavi", class: "rogue", level: 3 });
const model = await fakeModel();
model.pointAt(world);

await test("a question with its scene in it is asked, kept whole, and handed back whole to the follow-up", async () => {
  const scene = `We are in the flooded mill. ${"The goblins argued about the sluice codes while Marla watched from the stair, and the chain on the post rattled each time the wind turned. ".repeat(13)}Did Marla lie to us about the codes?`;
  assert.ok(scene.length > 1_200 && scene.length <= QUESTION_MAX_CHARS, `scene is ${scene.length}`);
  model.script([reply({ text: '{"answer":"The record does not say she lied.","scope":"story","citations":[]}' })]);
  const first = await post(world, world.owner, "campaigns/[campaignId]/ask", { question: scene, scope: "story" });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.ask.question, scene.replace(/\s+/g, " ").trim(), "the question was cut");
  const asked = model.requests.at(-1).messages.at(-1).content;
  assert.ok(asked.endsWith(`QUESTION: ${scene.replace(/\s+/g, " ").trim()}`));

  model.script([reply({ text: '{"answer":"Then ask her at the stair.","scope":"story","citations":[]}' })]);
  const follow = await post(world, world.owner, "campaigns/[campaignId]/ask", { question: "And if she did?", scope: "story" });
  assert.equal(follow.status, 200, JSON.stringify(follow.json));
  const thread = model.requests.at(-1).messages.filter((message) => message.role === "user");
  assert.equal(thread[0].content, scene.replace(/\s+/g, " ").trim(), "the thread clipped an accepted question");
});

await test("a question over the limit hears the limit and its own length, and nothing is stored", async () => {
  const before = listAsksForUser(world.campaignId, world.owner.id).length;
  const sent = model.requests.length;
  const long = "x".repeat(QUESTION_MAX_CHARS + 1);
  const refused = await post(world, world.owner, "campaigns/[campaignId]/ask", { question: long });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /Questions can be up to 2,000 characters; this one has 2,001\./);
  assert.equal(refused.json.maxChars, QUESTION_MAX_CHARS);
  assert.equal(listAsksForUser(world.campaignId, world.owner.id).length, before);
  assert.equal(model.requests.length, sent, "the model was asked anyway");
  const empty = await post(world, world.owner, "campaigns/[campaignId]/ask", { question: "   " });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, "Ask a question first.");
  const shapeless = await post(world, world.owner, "campaigns/[campaignId]/ask", { question: 7 });
  assert.equal(shapeless.json.error, "Invalid question.");
});

await test("a move, a line or table talk over 2,000 characters names its limit", async () => {
  const before = listRecentMessages(world.campaignId, 50).length;
  const long = "a".repeat(2_001);
  for (const [kind, what] of [["do", "A move"], ["say", "A line"], ["ooc", "Table talk"]]) {
    const refused = await post(world, world.owner, "campaigns/[campaignId]/actions", { content: long, kind, characterId: hero.id });
    assert.equal(refused.status, 400, kind);
    assert.equal(refused.json.error, `${what} can be up to 2,000 characters; this one has 2,001. Shorten it and send it again.`);
    assert.equal(refused.json.maxChars, 2_000);
  }
  assert.equal(listRecentMessages(world.campaignId, 50).length, before, "a refused move was written");
});

await test("a public direction over 1,000 characters is refused, not cut", async () => {
  const before = listRecentMessages(world.campaignId, 50).length;
  const refused = await post(world, world.owner, "campaigns/[campaignId]/lead-note", { content: "d".repeat(1_001), wake: false });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /A direction can be up to 1,000 characters; this one has 1,001/);
  assert.equal(listRecentMessages(world.campaignId, 50).length, before);
  const fits = await post(world, world.owner, "campaigns/[campaignId]/lead-note", { content: "d".repeat(1_000), wake: false });
  assert.equal(fits.status, 201, JSON.stringify(fits.json));
  assert.equal(fits.json.message.content.endsWith("d".repeat(1_000)), true, "a direction at the limit was cut");
});

model.close();

await test("a passage the DM in the seat writes over 8,000 characters names its limit", async () => {
  const campaigns = await import("../src/lib/db/campaigns.ts");
  const table = await openWorld({ gameSettings: { dmMode: "human" } });
  table.addHero({ class: "fighter", level: 1 });
  const dm = table.addUser("dm");
  table.addHero({ class: "fighter", level: 1, user: dm });
  assert.equal(campaigns.setHumanDm(table.campaignId, dm.id), true);
  const refused = await post(table, dm, "campaigns/[campaignId]/dm/narrate", { content: "n".repeat(8_001) });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /A passage can be up to 8,000 characters; this one has 8,001/);
  const empty = await post(table, dm, "campaigns/[campaignId]/dm/narrate", { content: "  " });
  assert.equal(empty.json.error, "Write something to narrate.");
});

finish();
