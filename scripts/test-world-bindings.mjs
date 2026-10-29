// A World entry linked to the playable records it stands for (audit finding
// WF-17): a creature's stat block in the Bestiary, an artifact's item in
// Homebrew. A link names the record the way the rest of the app does, is
// good only when the record is usable at this table, puts that exact
// monster into a fight, travels in a workshop bundle by name and lands on
// the arrived copy, and is listed in the record's own tool.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-world-bindings");
const { createWorldEntity, updateWorldEntity, worldView, getWorldDoc, saveWorldDoc } = await import("../src/lib/db/world-forge.ts");
const { entriesBoundTo } = await import("../src/lib/db/world-bindings.ts");
const { createHomebrewMonster } = await import("../src/lib/bestiary/homebrew-monsters.ts");
const { draftFromCr } = await import("../src/lib/bestiary/monster-draft.ts");
const { createHomebrew } = await import("../src/lib/db/homebrew.ts");
const { getEncounterTemplate, listEncounterTemplates } = await import("../src/lib/db/encounter-templates.ts");
const { resolveMonster } = await import("../src/lib/bestiary/index.ts");
const { exportWorkshopBundle, importWorkshopBundle } = await import("../src/lib/db/workshop-bundle.ts");
const { readBundle } = await import("../src/lib/workshop/bundle.ts");
const { createWorkshop } = await import("../src/lib/db/workshops.ts");
const { getCampaignById } = await import("../src/lib/db/campaigns.ts");

const world = await openWorld();
const author = world.addUser("bestiarist");
const stranger = world.addUser("stranger");
const shop = createWorkshop(author.id, { title: "Bound world" }).id;
const wyrm = createHomebrewMonster(author.id, draftFromCr("Tidewyrm", 3), "Coils under the sea wall.");
const lantern = createHomebrew(author.id, { kind: "item", name: "Drowned Lantern", data: {} });
const strangers = createHomebrewMonster(stranger.id, draftFromCr("Someone Else's Ooze", 1), "");
const article = createWorldEntity(shop, { typeId: "t_other", name: "The Tidewyrm", text: "It coils under the sea wall." }).entity;
const entity = (ref) => worldView(shop).entities.find((entry) => entry.ref === ref);
const encounterRoute = await world.route("campaigns/[campaignId]/world/entities/[ref]/encounter");
const addToFight = async (body) => {
  world.signIn({ id: author.id });
  const response = await encounterRoute.POST(new Request("http://test/", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ campaignId: shop, ref: article.ref }),
  });
  return { status: response.status, json: await response.json() };
};

await test("An entry links to the author's own stat block and item, and shows what they are.", () => {
  const linked = updateWorldEntity(shop, article.ref, {
    bindings: [
      { kind: "monster", ref: `homebrew:${wyrm.id}` },
      { kind: "item", ref: `homebrew:${lantern.id}` },
    ],
  });
  assert.ok(linked.entity, linked.error);
  const bound = entity(article.ref).bound;
  assert.deepEqual(bound.map((record) => [record.kind, record.name, record.found]), [
    ["monster", "Tidewyrm", true],
    ["item", "Drowned Lantern", true],
  ]);
  assert.equal(bound[0].ownId, wyrm.id);
  assert.match(bound[0].detail, /CR 3/);
});

await test("A link to a record this table cannot use is refused, and nothing else is written.", () => {
  const before = entity(article.ref).entry.bindings;
  const refused = updateWorldEntity(shop, article.ref, { notes: "changed", bindings: [...before, { kind: "monster", ref: `homebrew:${strangers.id}` }] });
  assert.equal(refused.status, 400);
  assert.match(refused.error, /stat block is not one this table can use/);
  assert.deepEqual(entity(article.ref).entry.bindings, before);
  assert.notEqual(entity(article.ref).entry.notes, "changed");
});

await test("Links that are not links are dropped when read, and a Cast member takes none: its stat block is its own.", () => {
  const npc = createWorldEntity(shop, { typeId: "t_character", name: "Wenna" }).entity;
  updateWorldEntity(shop, npc.ref, { bindings: [{ kind: "monster", ref: `homebrew:${wyrm.id}` }] });
  assert.deepEqual(entity(npc.ref).entry.bindings, []);
  // Written straight into the stored document, past every route.
  const doc = getWorldDoc(shop);
  doc.entries[article.ref].bindings.push({ kind: "spell", ref: "fireball" }, { kind: "monster", ref: "<script>" }, { kind: "item", ref: `homebrew:${lantern.id}` });
  saveWorldDoc(shop, doc);
  assert.deepEqual(entity(article.ref).entry.bindings.map((binding) => binding.kind), ["monster", "item"], "a stored link that is not one was read back");
});

await test("That exact monster goes into a new fight, then one more of it into the same fight.", async () => {
  const made = await addToFight({ monster: `homebrew:${wyrm.id}` });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const template = getEncounterTemplate(made.json.templateId);
  assert.equal(template.name, "The Tidewyrm");
  assert.equal(template.enemies.length, 1);
  const setting = getCampaignById(shop).gameSettings;
  assert.equal(resolveMonster(template.enemies[0].monster, setting, { userIds: [author.id] })?.slug, `homebrew:${wyrm.id}`, "the roster fights as another monster");
  assert.equal(template.enemies[0].monster, "Tidewyrm", "a name that finds this monster reads as the name");
  const again = await addToFight({ monster: `homebrew:${wyrm.id}`, templateId: made.json.templateId });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(getEncounterTemplate(made.json.templateId).enemies[0].count, 2);
  assert.equal((await addToFight({ monster: `homebrew:${strangers.id}` })).status, 404, "a monster the entry does not link to went in");
});

await test("A monster whose name would find another goes in by its ref, so it still fights as itself.", async () => {
  const shadow = createHomebrewMonster(author.id, draftFromCr("Goblin", 5), "Not the rulebook's goblin.");
  updateWorldEntity(shop, article.ref, { bindings: [...entity(article.ref).entry.bindings, { kind: "monster", ref: `homebrew:${shadow.id}` }] });
  const made = await addToFight({ monster: `homebrew:${shadow.id}` });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const [row] = getEncounterTemplate(made.json.templateId).enemies;
  const setting = getCampaignById(shop).gameSettings;
  assert.equal(resolveMonster(row.monster, setting, { userIds: [author.id] })?.slug, `homebrew:${shadow.id}`, `"${row.monster}" fights as another goblin`);
});

await test("The record's own tool can list the entries that link to it.", () => {
  assert.deepEqual(entriesBoundTo(shop, getWorldDoc(shop), "monster", `homebrew:${wyrm.id}`).map((entry) => entry.name), ["The Tidewyrm"]);
  assert.deepEqual(entriesBoundTo(shop, getWorldDoc(shop), "item", `homebrew:${lantern.id}`).map((entry) => entry.ref), [article.ref]);
});

await test("Links travel in a workshop bundle by name and land on the copies that arrive with it.", () => {
  const out = exportWorkshopBundle(shop, { name: "Bound world", blurb: "A world with its creatures.", inspiredBy: "Original work", shelf: "used" });
  assert.ok(out.bundle, out.error);
  assert.ok(out.bundle.monsters.some((monster) => monster.name === "Tidewyrm"), "a linked monster was left off the shelf");
  assert.ok(out.bundle.homebrew.some((entry) => entry.name === "Drowned Lantern"), "a linked item was left off the shelf");
  assert.ok(!JSON.stringify(out.bundle.world).includes(wyrm.id), "the bundle names this server's ids");
  const read = readBundle(JSON.stringify(out.bundle));
  assert.ok(!("error" in read), read.error);
  const { workshopId } = importWorkshopBundle(stranger.id, read.bundle);
  const landed = worldView(workshopId).entities.find((entry) => entry.name === "The Tidewyrm");
  const names = landed.bound.filter((record) => record.found).map((record) => record.name).sort();
  assert.deepEqual(names, ["Drowned Lantern", "Goblin", "Tidewyrm"].sort());
  assert.ok(landed.bound.every((record) => !record.ref.includes(wyrm.id)), "a link still points at the other server's monster");
  assert.equal(listEncounterTemplates(workshopId).length >= 1, true);
});

world.close();
finish();
