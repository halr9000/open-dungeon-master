// A Cast member's faction and home, as play reads them, beside the World
// links that say something about them (audit finding WF-12). A "member of"
// link with a rank, or a "lives in" link, used to leave the Cast's faction
// and home empty while the world's prose said otherwise. Now each such link
// is shown as a proposal with its effect, applied only when the author
// picks it; a false belief is never applied, a hidden truth only as the
// truth, and no other link touches play.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-world-play-fields");
const { createWorldEntity, worldView, patchWorldDoc } = await import("../src/lib/db/world-forge.ts");
const { getNpcById } = await import("../src/lib/db/npcs.ts");
const { createWorkshop } = await import("../src/lib/db/workshops.ts");

const world = await openWorld();
const author = world.addUser("chronicler");
const stranger = world.addUser("passerby");
const shop = createWorkshop(author.id, { title: "Tied world" }).id;
const make = (typeId, name) => createWorldEntity(shop, { typeId, name }).entity;
const captain = make("t_character", "Audit Captain");
const wardens = make("t_faction", "The Salt Wardens");
const hand = make("t_faction", "The Gilded Hand");
const harbour = make("t_location", "Gull Harbour");
const tower = make("t_location", "The Drowned Tower");
const entity = (ref) => worldView(shop).entities.find((entry) => entry.ref === ref);
const npc = () => getNpcById(captain.id);
const link = (id, label, to, extra = {}) => ({ id, from: captain.ref, to, label, veracity: "known", oneway: false, rank: "", ...extra });
const setLinks = (links) => patchWorldDoc(shop, { links });
const route = await world.route("campaigns/[campaignId]/world/entities/[ref]/play");
const apply = async (body, as = author) => {
  world.signIn({ id: as.id });
  const response = await route.POST(new Request("http://test/", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ campaignId: shop, ref: captain.ref }) });
  return { status: response.status, json: await response.json() };
};
const adapter = (field) => entity(captain.ref).inPlay.find((entry) => entry.field === field);

await test("A \"member of\" link with a rank is shown beside an empty faction, and does not fill it by itself.", () => {
  setLinks([link("l_member", "member of", wardens.ref, { rank: "Captain" })]);
  assert.equal(npc().factionId, "", "the link was mirrored into play without the author choosing it");
  const faction = adapter("faction");
  assert.equal(faction.current, null);
  assert.deepEqual(faction.candidates.map((entry) => [entry.name, entry.rank, entry.state]), [["The Salt Wardens", "Captain", "fills"]]);
  assert.equal(adapter("home"), undefined, "a column no link speaks to was offered");
});

await test("Applying it sets the Cast's faction, and the entry then reads that play agrees.", async () => {
  const done = await apply({ field: "faction", link: "l_member" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(npc().factionId, wardens.id);
  assert.equal(entity(captain.ref).table.faction, "The Salt Wardens");
  assert.equal(adapter("faction").candidates[0].state, "same");
});

await test("A link that disagrees with the Cast is a review, changed only when the author chooses it.", async () => {
  setLinks([link("l_member", "member of", wardens.ref, { rank: "Captain" }), link("l_hand", "member of", hand.ref)]);
  const states = Object.fromEntries(adapter("faction").candidates.map((entry) => [entry.name, entry.state]));
  assert.deepEqual(states, { "The Salt Wardens": "same", "The Gilded Hand": "differs" });
  assert.equal(npc().factionId, wardens.id);
  assert.equal((await apply({ field: "faction", link: "l_hand" })).status, 200);
  assert.equal(npc().factionId, hand.id);
});

await test("A false belief is never applied; a hidden truth only when the author says to use the truth.", async () => {
  setLinks([link("l_lie", "member of", wardens.ref, { veracity: "believed" }), link("l_secret", "lives in", tower.ref, { veracity: "hidden" })]);
  assert.equal(adapter("faction").candidates[0].state, "false");
  const lie = await apply({ field: "faction", link: "l_lie" });
  assert.equal(lie.status, 400);
  assert.match(lie.json.error, /false belief/);
  assert.equal(npc().factionId, hand.id, "a false belief moved the faction");
  const unsure = await apply({ field: "home", link: "l_secret" });
  assert.equal(unsure.status, 400);
  assert.equal(npc().location, "", "a hidden truth was applied without the author choosing the truth");
  assert.equal((await apply({ field: "home", link: "l_secret", truth: true })).status, 200);
  assert.equal(npc().location, "The Drowned Tower");
});

await test("\"Lives in\" and \"located in\" set the home by the place's name; other links never touch play.", async () => {
  setLinks([link("l_lives", "located in", harbour.ref), link("l_ally", "allied with", hand.ref), link("l_guard", "guards", harbour.ref)]);
  const home = adapter("home");
  assert.deepEqual(home.current, { ref: tower.ref, name: "The Drowned Tower" });
  assert.deepEqual(home.candidates.map((entry) => [entry.name, entry.state]), [["Gull Harbour", "differs"]]);
  assert.equal(adapter("faction"), undefined, "\"allied with\" was offered as a faction");
  assert.equal((await apply({ field: "home", link: "l_ally" })).status, 400);
  assert.equal((await apply({ field: "home", link: "l_lives" })).status, 200);
  assert.equal(npc().location, "Gull Harbour");
  assert.equal(adapter("home").candidates[0].state, "same");
});

await test("Only the world's author can apply a link, and only one that starts at this Cast member.", async () => {
  setLinks([link("l_member", "member of", wardens.ref), { id: "l_theirs", from: harbour.ref, to: wardens.ref, label: "member of", veracity: "known", oneway: false, rank: "" }]);
  assert.notEqual((await apply({ field: "faction", link: "l_member" }, stranger)).status, 200);
  assert.equal(npc().factionId, hand.id);
  assert.equal((await apply({ field: "faction", link: "l_theirs" })).status, 400);
  assert.equal((await apply({ field: "rank", link: "l_member" })).status, 400);
});

world.close();
finish();
