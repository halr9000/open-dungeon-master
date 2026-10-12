// Issue 210: the Hand's off-hand card and the engine's two-weapon rule give
// the same answer, read the way a player's page reads it (the public
// encounter, on a live update or a reload). A rapier swing lit "Off-hand
// Dagger" while pc_attack refused it, because the card opened on any first
// attack and the public turn never said what the attack was made with.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { combatKit } from "./lib/enforce-combat.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-offhand-agreement");

const { activePublicEncounter } = await import("../src/lib/db/encounter-view.ts");
const { turnFromEncounter } = await import("../src/lib/battlemap/hand-table.ts");
const { deriveHand } = await import("../src/lib/battlemap/hand.ts");

const world = await openWorld();
const kit = await combatKit(world);
const profs = { saves: ["dex", "int"], skills: [], expertise: [], languages: ["Common"], tools: [], armor: ["light"], weapons: ["simple", "martial"] };
const tavi = world.addHero({
  name: "Tavi",
  class: "rogue",
  level: 3,
  abilities: { dex: 16 },
  proficiencies: profs,
  equipment: [
    { name: "Rapier", qty: 1, equipped: true },
    { name: "Dagger", qty: 2, equipped: true },
  ],
});
await kit.fight(1, { heroFaces: { [tavi.id]: 19 } });
const [goblin] = world.enemies();
kit.place(tavi.id, 2, 2);
kit.place(goblin.id, 3, 2);
kit.giveTurn(tavi.id);

// The card as the player's page draws it now: the public encounter, the
// turn adapter, the Hand.
const card = () => {
  const sheet = world.sheet(tavi.id);
  const turn = turnFromEncounter(activePublicEncounter(world.campaignId), sheet, { myTurn: true });
  return deriveHand(sheet, turn).find((entry) => entry.id === "offhand:dagger");
};

await test("after a rapier swing the card is shut with the engine's own reason", async () => {
  const swing = await kit.swing(tavi.id, goblin.id, [15, 3], { weapon: "Rapier" });
  assert.equal(swing.ok, true, swing.error);
  const turn = activePublicEncounter(world.campaignId).turn;
  assert.equal(turn.lightMeleeAttack, false, "the public turn says what the action was made with");
  const shut = card();
  assert.ok(shut.disabled, "the card is lit after a rapier swing");
  const refused = await kit.swing(tavi.id, goblin.id, [15, 3], { weapon: "Dagger", offHand: true });
  assert.equal(refused.ok, false);
  assert.equal(shut.disabled, refused.error, "the card and the engine say different things");
});

await test("after a dagger swing the card opens and the engine takes the swing; then it is spent", async () => {
  kit.freshTurn();
  const swing = await kit.swing(tavi.id, goblin.id, [15, 3], { weapon: "Dagger" });
  assert.equal(swing.ok, true, swing.error);
  assert.equal(activePublicEncounter(world.campaignId).turn.lightMeleeAttack, true);
  assert.equal(card().disabled, null);
  const off = await kit.swing(tavi.id, goblin.id, [15, 3], { weapon: "Dagger", offHand: true });
  assert.equal(off.ok, true, off.error);
  assert.ok(card().disabled, "the bonus action is spent, the card must say so");
});

await test("with Dual Wielder a rapier swing earns the off-hand rapier, on the card and in the engine", async () => {
  await kit.endFight();
  const duelist = world.addHero({
    name: "Sorrel",
    class: "fighter",
    level: 4,
    abilities: { dex: 16 },
    feats: ["Dual Wielder"],
    proficiencies: profs,
    equipment: [{ name: "Rapier", qty: 2, equipped: true }],
  });
  await kit.fight(1, { heroFaces: { [duelist.id]: 19 } });
  const [enemy] = world.enemies();
  kit.place(duelist.id, 5, 5);
  kit.place(enemy.id, 6, 5);
  kit.giveTurn(duelist.id);
  const offCard = () => {
    const sheet = world.sheet(duelist.id);
    const turn = turnFromEncounter(activePublicEncounter(world.campaignId), sheet, { myTurn: true });
    return deriveHand(sheet, turn).find((entry) => entry.id === "offhand:rapier");
  };
  assert.ok(offCard(), "Dual Wielder deals the off-hand card");
  assert.ok(offCard().disabled, "shut before the Attack action");
  const swing = await kit.swing(duelist.id, enemy.id, [15, 3], { weapon: "Rapier" });
  assert.equal(swing.ok, true, swing.error);
  assert.equal(activePublicEncounter(world.campaignId).turn.oneHandMeleeAttack, true);
  assert.equal(offCard().disabled, null);
  const off = await kit.swing(duelist.id, enemy.id, [15, 3], { weapon: "Rapier", offHand: true });
  assert.equal(off.ok, true, off.error);
});

finish();
