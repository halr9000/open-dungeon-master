// A ready-made hero (src/lib/starter/pregens.ts) seated at a table that
// starts above level 1. Each hero is a level 1 sheet with no subclass and no
// improvements chosen; the pregen route seats it at the table's level through
// the table door, which counts a made character as having taken every
// improvement its level earned. Nobody offered this one any, so they were
// never offered at all, and the subclass it skipped stayed blank (backlog
// B6). The same gap closed for a library hero joining above its level in
// issue 293 (scripts/test-character-adapt.mjs, test-build-join-levelup.mjs):
// the skipped improvements are owed, the sheet lists them with the missed
// subclass, and the next level-up takes them.
import assert from "node:assert/strict";
import { suite } from "./lib/enforce-harness.mjs";
import { openCreation } from "./lib/enforce-creation.mjs";

const { test, finish } = suite("test-pregen-join-level");
const campaigns = await import("../src/lib/db/campaigns.ts");
const { asiOwed, readAsiLedger } = await import("../src/lib/srd/asi-ledger.ts");
const { earnedAsiCountFor } = await import("../src/lib/srd/asi.ts");
const { owedChoices, subclassOwed } = await import("../src/lib/srd/owed-choices.ts");
const { pregenById } = await import("../src/lib/starter/pregens.ts");

// Seat a ready-made hero as the player, the way the lobby's picker does.
async function seatPregen(table, id) {
  table.clearSeat();
  table.world.signIn(table.player);
  const pregenRoute = await table.world.route("campaigns/[campaignId]/sheet/pregen");
  const response = await table.call(pregenRoute, "POST", { id }, { campaignId: table.campaignId });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const sheet = table.sheets.getSheetForUser(table.campaignId, table.player.id);
  return { sheet, character: table.characters.getCharacter(sheet.libraryCharacterId) };
}

// What each class has earned by a level, and so what a hero that took none
// is owed: a fighter has an extra improvement at 6.
const earned = (classId, level) => earnedAsiCountFor([{ id: classId, level }]);

for (const [id, classId] of [["kara", "fighter"], ["brakk", "barbarian"]]) {
  for (const level of [1, 4, 8]) {
    await test(`${id} the ${classId}, seated at a level ${level} table, owes the ${earned(classId, level)} improvement(s) and the subclass the level skipped.`, async () => {
      const table = await openCreation({ campaign: { startingLevel: level } });
      const { sheet, character } = await seatPregen(table, id);
      const built = pregenById(id).sheet;
      assert.equal(sheet.level, level);
      assert.equal(sheet.subclass, "", "the seat chose a subclass for the player");
      assert.deepEqual(sheet.abilities, built.abilities, "an improvement was applied for the player");

      const classes = [{ id: classId, level }];
      assert.equal(asiOwed(sheet, classes), earned(classId, level), "the skipped improvements were recorded as taken");
      if (level >= 4) {
        assert.equal(readAsiLedger(sheet.features), 0, "the sheet's count of improvements taken");
        assert.ok(
          owedChoices(sheet).some((line) => new RegExp(`${earned(classId, level)} Ability Score Improvements?`).test(line)),
          `the sheet does not list the owed improvements: ${owedChoices(sheet).join("; ")}`,
        );
      } else {
        assert.ok(!owedChoices(sheet).some((line) => /Ability Score/.test(line)), "a level 1 hero owes no improvement");
      }
      // A fighter and a barbarian both pick a subclass at 3.
      assert.equal(
        owedChoices(sheet).some((line) => new RegExp(`subclass for ${classId}`).test(line)),
        level >= 3,
        `the subclass owed: ${owedChoices(sheet).join("; ")}`,
      );

      // The hero is saved to the player's library at the table's level, and
      // owes the same there.
      assert.equal(character.level, level);
      assert.equal(asiOwed({ level, features: character.sheet.features }, classes), earned(classId, level), "the library copy recorded the improvements as taken");
      table.world.close();
    });
  }
}

// The level-up dialog offers what the sheet owes: the skipped improvement
// beside nothing new at 5, and the subclass the seat missed. This is the body
// it sends when the player takes both.
await test("kara seated at level 4 takes the owed improvement and her Martial Archetype with her first level-up.", async () => {
  const table = await openCreation({ campaign: { startingLevel: 4 } });
  const { world, campaignId, call, sheetRoute, player } = table;
  const { sheet } = await seatPregen(table, "kara");
  campaigns.setCampaignStatus(campaignId, "active");
  const awarded = await world.invoke("award_xp", { characterIds: [sheet.id], amount: 6500 - sheet.xp, reason: "the bridge held" });
  assert.equal(awarded.ok, true, awarded.error);

  assert.equal(asiOwed(sheet, [{ id: "fighter", level: 5 }]), 1);
  assert.equal(subclassOwed({ id: "fighter", subclass: sheet.subclass }, 5), true, "the dialog would not show the subclass step");
  world.signIn(player);
  const levelled = await call(sheetRoute, "PATCH", {
    level: 5,
    levelUpClass: "fighter",
    subclass: "Champion",
    asiChoices: [{ mode: "plus2", ability: "con" }],
  }, { campaignId });
  assert.equal(levelled.status, 200, JSON.stringify(levelled.json));
  const after = table.sheets.getSheetForUser(campaignId, player.id);
  assert.equal(after.level, 5);
  assert.equal(after.subclass, "Champion");
  assert.equal(after.abilities.con, sheet.abilities.con + 2, "the owed improvement did not land");
  assert.equal(asiOwed(after, [{ id: "fighter", level: 5 }]), 0, "the improvement is still owed");
  assert.ok(!owedChoices(after).some((line) => /subclass/.test(line)), "the subclass is still listed as owed");
  world.close();
});

finish();
