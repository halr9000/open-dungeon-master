// A whole fight, in the order a table plays it: the fight opens, then round
// after round the hero's attack goes through a DM turn (the model's
// pc_attack), the player's End Turn hands the round to the goblins, and the
// DM turn that wakes plays them (the model's enemy_attack) and gives the turn
// back, until the last goblin falls, the fight ends and its XP is paid.
//
// Each of those steps has its own suite (test-enforce-initiative,
// test-enforce-turn-advance, test-enforce-enemies, ...), staged one at a
// time. None ran them in sequence, so nothing checked what a round leaves
// for the next: that an enemy's hit lands on the hero's sheet and stays
// there, that a goblin killed on the hero's turn is not due on the enemies'
// turn, that the round counter and the turn pointer agree after each pass,
// and that the fight ends on the killing blow with the right XP.
//
// SRD goblins (Small, AC 15, 7 HP, scimitar +4 for 1d6+2, darkvision, 50
// XP), the scripted fake model (scripts/lib/enforce-narrator.mjs), dice
// forced per swing and every die checked to be one of them.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { combatKit, DUMMY, TRAINED } from "./lib/enforce-combat.mjs";
import { call, fakeModel, reply, settleQueue } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-whole-fight");

const GOBLIN = {
  ...DUMMY,
  ac: 15,
  maxHp: 7,
  dexMod: 2,
  // No save proficiencies: the saves are the ability modifiers.
  saveMods: { str: -1, dex: 2, con: 0, int: 0, wis: -1, cha: -1 },
  attacks: [{ name: "Scimitar", toHit: 4, damage: "1d6+2", type: "slashing" }],
  cr: 0.25,
  xp: 50,
  size: "Small",
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  senses: { darkvision: 60, passivePerception: 9 },
};

const { listRecentRolls } = await import("../src/lib/db/rolls.ts");
const { startDmTurn } = await import("../src/lib/dm/turn.ts");
const { endOwnTurn } = await import("../src/lib/dm/encounter-tools.ts");

await test("Three rounds against two goblins: hits stay on the sheet, the dead stop acting, the turn comes back each round, and the killing blow ends the fight with its XP", async () => {
  const world = await openWorld({
    campaign: { maxPlayers: 8, difficulty: "deadly" },
    gameSettings: { ttsEnabled: false },
  });
  const kit = await combatKit(world);
  const model = await fakeModel();
  model.pointAt(world);
  const kara = world.addHero({
    name: "Kara",
    class: "fighter",
    level: 3,
    abilities: { str: 16, dex: 10, con: 14, wis: 10 },
    proficiencies: TRAINED,
    equipment: [{ name: "Longsword", qty: 1, equipped: true }],
  });
  const userId = world.sheet(kara.id).userId;
  const maxHp = world.sheet(kara.id).maxHp;
  const xpBefore = world.sheet(kara.id).xp;

  // Kara wins initiative; the goblins roll a 1. Without the content pack (as
  // in CI) a goblin's numbers are synthesized, so the SRD block is pinned.
  await world.beginFight([{ monster: "goblin", count: 2 }], { heroFaces: { [kara.id]: 19 }, enemyFace: 1 });
  for (const goblin of world.enemies()) {
    kit.setEnemy(goblin.id, { ac: 15, maxHp: 7, currentHp: 7, stats: GOBLIN });
  }
  const [first, second] = world.enemies();
  assert.equal(first.currentHp, 7);
  kit.place(kara.id, 5, 5);
  kit.place(first.id, 4, 6);
  kit.place(second.id, 6, 6);

  const turnName = () => {
    const encounter = world.encounter();
    return encounter?.orderReady ? encounter.order[encounter.turnIndex]?.name ?? null : null;
  };
  const enemy = (id) => world.enemies().find((entry) => entry.id === id);
  const damageTaken = () =>
    listRecentRolls(world.campaignId, 200)
      .filter((roll) => roll.attacker?.kind === "enemy" && roll.kind === "damage")
      .reduce((sum, roll) => sum + roll.total, 0);

  // Kara's attack, as the AI DM resolves the player's line: one pc_attack.
  async function karaAttacks(target, faces) {
    world.dice(...faces);
    model.script([
      reply({ calls: [call("pc_attack", { characterId: kara.id, targetEnemyId: target.id, weapon: "Longsword" })] }),
      reply({ text: "Kara's longsword bites." }),
    ]);
    await model.turn(world, `I attack ${target.displayName} with my Longsword.`, kara.id, userId);
    assert.equal(world.clearDice(), 0, "a forced die went unrolled on Kara's attack");
    assert.ok(world.diceLog().every((die) => die.forced), "a die was rolled for real on Kara's attack");
  }

  // The End Turn button, as the player presses it: the route ends her turn
  // and wakes the DM.
  const endTurnRoute = await world.route("campaigns/[campaignId]/encounter/end-turn");
  async function pressEndTurn() {
    world.signIn({ id: userId });
    const response = await endTurnRoute.POST(
      new Request(`http://odm.test/api/campaigns/${world.campaignId}/encounter/end-turn`, { method: "POST" }),
      { params: Promise.resolve({ campaignId: world.campaignId }) },
    );
    return { status: response.status, json: await response.json().catch(() => ({})) };
  }

  // The player's End Turn, then the DM turn it wakes playing every goblin
  // still standing. A miss rolls one die, a hit two. `dead` are goblins the
  // model also tries to play, as a model that lost count might: the server
  // must refuse them without a roll.
  //
  // With `press`, the round goes through the real button and its wake; the
  // DM turn starts on the queue as the route returns, so the dice go in
  // first. Otherwise the turn is ended the same way without the wake, which
  // lets the test read who is due before the DM turn plays them, and the
  // DM turn is started here.
  async function goblinsAct(swings, round, { dead = [], press = false } = {}) {
    const faces = swings.flatMap(([, rolled]) => rolled);
    const attackers = [...dead, ...swings.map(([goblin]) => goblin)];
    const calls = attackers.map((goblin) => call("enemy_attack", { enemyId: goblin.id, targetCharacterId: kara.id }));
    model.script([reply({ calls }), reply({ text: "The goblins press in." })]);
    if (press) {
      world.dice(...faces);
      const pressed = await pressEndTurn();
      assert.equal(pressed.status, 200, `End Turn was refused: ${JSON.stringify(pressed.json)}`);
      await settleQueue(world.campaignId);
      assert.ok(model.requests.length > 0, `round ${round}: End Turn did not wake the DM`);
    } else {
      // The real button's own check: it waits while any enemy is left due.
      assert.equal(endOwnTurn(world.campaignId, userId), true, "End Turn was refused");
      const due = [...(world.encounter().legendary.due ?? [])].sort();
      assert.deepEqual(due, swings.map(([goblin]) => goblin.id).sort(), `round ${round}: the goblins due`);
      world.dice(...faces);
      await startDmTurn(world.campaignId);
    }
    // The model's own calls played the goblins due, each read from the
    // result of its own call: the backstop that plays the ones it leaves
    // (advanceAfterTurn) would roll the same dice, so the hit points alone
    // cannot tell the two apart.
    const answered = new Map(model.requests.flatMap((request) => model.results(request)).map(({ id, result }) => [id, result]));
    for (const [index, goblin] of attackers.entries()) {
      const result = answered.get(calls[index].id);
      if (dead.includes(goblin)) {
        // The DM's own call with nothing to act on: dropped, never narrated.
        assert.equal(result?.retry, true, `round ${round}: ${goblin.displayName}, dead, was not handed back to drop: ${JSON.stringify(result)}`);
        // Refused for being dead: "its turn has not come yet" would tell the
        // model the corpse acts later.
        assert.match(result.error ?? "", /is dead/, `round ${round}: ${goblin.displayName} was refused for something other than being dead`);
      } else {
        assert.ok(Array.isArray(result?.swings), `round ${round}: the model's enemy_attack for ${goblin.displayName} did not play it: ${JSON.stringify(result)}`);
      }
    }
    assert.equal(world.clearDice(), 0, "a forced die went unrolled on the goblins' turn");
    // Only the forced dice: a goblin played twice (the model, then the
    // backstop) rolls for real.
    assert.ok(world.diceLog().every((die) => die.forced), `round ${round}: a die was rolled for real on the goblins' turn`);
    assert.deepEqual(world.encounter().legendary.due ?? [], [], `round ${round}: a goblin was left due`);
    assert.equal(turnName(), "Kara", `round ${round}: the turn did not come back to Kara`);
  }

  // Round 1: Kara cuts the first goblin to 3; it hits back, the second misses.
  assert.equal(world.encounter().round, 1);
  assert.equal(turnName(), "Kara");
  await karaAttacks(first, [18, 1]);
  assert.equal(enemy(first.id).currentHp, 3, "1d8+3 on a 1");
  await goblinsAct([[first, [18, 4]], [second, [1]]], 1, { press: true });
  assert.equal(world.encounter().round, 2);
  assert.equal(world.sheet(kara.id).currentHp, maxHp - damageTaken(), "round 1's hit is not on Kara's sheet");
  assert.equal(world.sheet(kara.id).currentHp, maxHp - 6, "1d6+2 on a 4");

  // Round 2: Kara drops the first goblin on her turn, so only the second acts.
  await karaAttacks(first, [18, 1]);
  assert.equal(enemy(first.id).status, "dead");
  assert.notEqual(world.encounter(), null, "the fight ended with a goblin standing");
  const firstRolls = () =>
    listRecentRolls(world.campaignId, 200).filter((roll) => roll.attacker?.kind === "enemy" && roll.attacker.id === first.id).length;
  const firstRolledBefore = firstRolls();
  await goblinsAct([[second, [18, 3]]], 2, { dead: [first] });
  assert.equal(firstRolls(), firstRolledBefore, "the dead goblin attacked");
  assert.equal(world.encounter().round, 3);
  assert.equal(world.sheet(kara.id).currentHp, maxHp - damageTaken(), "the hits do not add up on Kara's sheet");
  assert.equal(world.sheet(kara.id).currentHp, maxHp - 11, "and 1d6+2 on a 3");

  // Round 3: the killing blow on the last goblin ends the fight and pays out.
  const hpBeforeEnd = world.sheet(kara.id).currentHp;
  await karaAttacks(second, [18, 8]);
  assert.equal(world.encounter(), null, "the fight did not end on the last goblin");
  assert.equal(world.sheet(kara.id).xp - xpBefore, 100, "two goblins at 50 XP, one hero");
  assert.equal(world.sheet(kara.id).currentHp, hpBeforeEnd, "the end of the fight changed Kara's hit points");

  model.close();
  world.close();
});

finish();
