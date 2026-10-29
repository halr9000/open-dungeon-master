// WF-12 in the browser: a Cast member's "member of" link with a rank shows
// beside their empty faction under In play, changes nothing until the
// author applies it, and then the Cast's own faction is that one. A false
// belief about their home is shown and never offered.
import { check, eventually } from "../lib.mjs";

export default {
  name: "world-play-fields",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, base, root, api } = t;
    const made = await api.post(`${base}/api/workshops`, { data: { title: "Tied in play", description: "" } });
    check(made.ok(), "a workshop for the check");
    const id = (await made.json()).workshop.id;
    // The tools' first-visit tours open over whatever is about to be pressed.
    await api.post(`${base}/api/profile/tours`, { data: { finished: ["world", "cast"].map((tool) => ({ id: `workshop-${tool}`, version: 1, how: "ended" })) } });
    const entities = `${base}/api/campaigns/${id}/world/entities`;
    const entity = async (typeId, name) => (await (await api.post(entities, { data: { typeId, name } })).json()).entity;
    const heading = (name) => page.locator(`${root}[data-tour="world-entry"] h3`, { hasText: name });
    try {
      const captain = await entity("t_character", "Audit Captain");
      const wardens = await entity("t_faction", "The Salt Wardens");
      const tower = await entity("t_location", "The Drowned Tower");
      const link = (lid, label, to, extra = {}) => ({ id: lid, from: captain.ref, to, label, veracity: "known", oneway: false, rank: "", ...extra });
      const patched = await api.patch(`${base}/api/campaigns/${id}/world`, {
        data: { links: [link("l_member", "member of", wardens.ref, { rank: "Captain" }), link("l_lie", "lives in", tower.ref, { veracity: "believed" })] },
      });
      check(patched.ok(), "the links saved");
      const npc = async () => (await (await api.get(`${base}/api/campaigns/${id}/dm/npcs`)).json()).npcs.find((row) => row.id === captain.id);

      await t.open(`/workshop/${id}?system=world&entry=${encodeURIComponent(captain.ref)}`);
      await eventually(() => heading("Audit Captain").count(), { timeoutMs: 30_000, label: "the captain's entry" });
      const faction = page.locator(`${root}[data-testid="world-in-play-faction"]`);
      await faction.scrollIntoViewIfNeeded();
      check((await faction.locator('[data-testid="world-in-play-current"]').innerText()) === "None", "play holds no faction before the author chooses");
      const offer = faction.locator('[data-testid="world-in-play-link"]');
      check((await offer.getAttribute("data-state")) === "fills", "the member-of link offers to fill the faction");
      check((await offer.innerText()).includes("Captain"), "the rank shows beside the link");
      check(!(await npc())?.factionId, "the link alone set the Cast's faction");
      const home = page.locator(`${root}[data-testid="world-in-play-home"]`);
      check((await home.locator('[data-testid="world-in-play-link"]').getAttribute("data-state")) === "false", "a false belief is shown as one");
      check((await home.getByRole("button").count()) === 0, "a false belief is offered to play");
      await t.shot("in-play");

      await offer.getByRole("button", { name: /Use The Salt Wardens in play/ }).click();
      await eventually(async () => (await faction.locator('[data-testid="world-in-play-current"]').innerText()) === "The Salt Wardens", { timeoutMs: 15_000, label: "play now holds the faction" });
      check((await offer.getAttribute("data-state")) === "same", "the link now reads as agreeing with play");
      check((await npc())?.factionId === wardens.id, "the Cast's own faction is the linked one");
      check(!(await npc())?.location, "applying the faction touched the home");
    } finally {
      await api.delete(`${base}/api/workshops/${id}`);
    }
  },
};
