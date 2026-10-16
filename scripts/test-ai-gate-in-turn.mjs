// The rules audit's gate on the model's damage, healing and binding
// conditions (F17, src/lib/dm/ai-gate.ts), held on the AI's own turn.
// test-enforce-ai-gates.mjs drives the gate through invokeEngine with an AI
// turn, the door a delegated turn uses, and passes. But a DM turn runs the
// model's mutation and encounter calls itself (resolveModelCall in
// src/lib/dm/turn.ts), and those never reached the gate: a heal sent with
// the dice its own tool description offers was refused for having no
// amount, a number of the model's own was applied as written, and a
// paralysis landed with no save. Grok Build, run as the storyteller, hit
// the first of these live.
//
// Each case is one whole DM turn against the scripted fake model
// (scripts/lib/enforce-narrator.mjs), with every die forced.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { combatKit } from "./lib/enforce-combat.mjs";
import { call, fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-ai-gate-in-turn");

const { listRecentRolls } = await import("../src/lib/db/rolls.ts");
const { MUTATION_CAP_PER_TURN } = await import("../src/lib/dm/mutations.ts");

const world = await openWorld({ gameSettings: { ttsEnabled: false } });
const kit = await combatKit(world);
const model = await fakeModel();
model.pointAt(world);
const kara = world.addHero({ name: "Kara", class: "fighter", level: 5, abilities: { str: 16, dex: 10, con: 14, wis: 10 } });
const userId = world.sheet(kara.id).userId;
const maxHp = world.sheet(kara.id).maxHp;

// One DM turn: the model's call, then its narration. Returns what the tool
// answered.
async function turnWith(toolCall, line = "I press on.") {
  model.script([reply({ calls: [toolCall] }), reply({ text: "The moment passes. What do you do?" })]);
  await model.turn(world, line, kara.id, userId);
  assert.equal(world.clearDice(), 0, "a forced die went unrolled");
  const answer = model.requests[1].messages.filter((message) => message.role === "tool").at(-1);
  return JSON.parse(answer.content);
}

await test("Healing sent as dice, as the heal tool offers, is rolled by the server and lands.", async () => {
  world.patch(kara.id, { currentHp: 10 });
  world.dice(3, 4);
  const result = await turnWith(call("heal", { characterId: kara.id, dice: "2d4+2", reason: "a healer's draught" }));
  assert.ok(!result.error, `the heal was refused: ${result.error}`);
  assert.equal(world.sheet(kara.id).currentHp, 19, "2d4+2 on 3 and 4");
});

await test("Damage the model writes as its own number is refused, and the sheet is untouched.", async () => {
  world.patch(kara.id, { currentHp: maxHp });
  const result = await turnWith(call("apply_damage", { characterId: kara.id, amount: 30, type: "fire", reason: "the brazier" }));
  assert.match(result.error ?? "", /Damage is rolled by the server/);
  assert.equal(world.sheet(kara.id).currentHp, maxHp);
});

await test("Damage sent as dice is rolled by the server.", async () => {
  world.patch(kara.id, { currentHp: maxHp });
  world.dice(5, 2);
  const result = await turnWith(call("apply_damage", { characterId: kara.id, dice: "2d6", type: "fire", reason: "the brazier" }));
  assert.ok(!result.error, `the damage was refused: ${result.error}`);
  assert.equal(world.sheet(kara.id).currentHp, maxHp - 7);
});

await test("A paralysis with no save is refused; with one, the server rolls it and a failure lays it.", async () => {
  const conditions = () => world.sheet(kara.id).conditions.map((entry) => entry.toLowerCase());
  const bare = await turnWith(call("set_condition", { characterId: kara.id, condition: "paralyzed", reason: "the ghoul's touch" }));
  assert.match(bare.error ?? "", /cannot be made paralyzed by narration alone/);
  assert.ok(!conditions().includes("paralyzed"), "a paralysis landed with no save");

  world.dice(2);
  const saved = await turnWith(
    call("set_condition", { characterId: kara.id, condition: "paralyzed", saveAbility: "con", saveDc: 10, rounds: 1, reason: "the ghoul's touch" }),
  );
  assert.ok(!saved.error, `the saved paralysis was refused: ${saved.error}`);
  assert.ok(conditions().includes("paralyzed"), "a failed save did not lay the paralysis");
});

await test("A call past the turn's mutation cap is refused before the gate rolls its dice.", async () => {
  world.patch(kara.id, { currentHp: 1 });
  const before = listRecentRolls(world.campaignId, 500).length;
  world.dice(...Array.from({ length: MUTATION_CAP_PER_TURN }, () => 1));
  const heals = Array.from({ length: MUTATION_CAP_PER_TURN + 1 }, () =>
    call("heal", { characterId: kara.id, dice: "1d4", reason: "a trickle of warmth" }),
  );
  model.script([reply({ calls: heals }), reply({ text: "The warmth fades. What do you do?" })]);
  await model.turn(world, "I rest a moment.", kara.id, userId);
  assert.equal(world.clearDice(), 0, "a forced die went unrolled");
  const answers = model.requests[1].messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
  assert.match(answers.at(-1).error ?? "", /Mutation limit reached/);
  assert.equal(listRecentRolls(world.campaignId, 500).length - before, MUTATION_CAP_PER_TURN, "the capped call rolled its dice anyway");
  assert.equal(world.sheet(kara.id).currentHp, 1 + MUTATION_CAP_PER_TURN);
});

await test("Damage to an enemy the model writes as its own number is refused, and the enemy is untouched.", async () => {
  world.patch(kara.id, { conditions: [], conditionMeta: {} });
  await world.beginFight([{ monster: "goblin", count: 1 }], { heroFaces: { [kara.id]: 19 }, enemyFace: 1 });
  const [goblin] = world.enemies();
  kit.setEnemy(goblin.id, { maxHp: 7, currentHp: 7 });
  const result = await turnWith(call("damage_enemy", { enemyId: goblin.id, amount: 7, reason: "a lucky stone" }), "I throw a stone.");
  assert.match(result.error ?? "", /Damage is rolled by the server/);
  assert.equal(world.enemies()[0].currentHp, 7);
});

model.close();
world.close();
finish();
