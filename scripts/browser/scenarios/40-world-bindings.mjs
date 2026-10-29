// WF-17, M2's acceptance in the browser: from a World article, make a real
// stat block, put that exact monster into a fight, and reopen both the
// article and the stat block without searching by name. An Artifact reads
// "Lore only" until an item is linked, and the linked item is one the
// shop's own picker finds.
import { check, eventually } from "../lib.mjs";

export default {
  name: "world-bindings",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, base, root, api } = t;
    const made = await api.post(`${base}/api/workshops`, { data: { title: "Bound records", description: "" } });
    check(made.ok(), "a workshop for the check");
    const id = (await made.json()).workshop.id;
    // The tools' first-visit tours open over whatever is about to be pressed.
    await api.post(`${base}/api/profile/tours`, { data: { finished: ["world", "bestiary", "encounters", "homebrew"].map((tool) => ({ id: `workshop-${tool}`, version: 1, how: "ended" })) } });
    const entities = `${base}/api/campaigns/${id}/world/entities`;
    const params = async () => (await t.url()).searchParams;
    const heading = (name) => page.locator(`${root}[data-tour="world-entry"] h3`, { hasText: name });
    const bound = page.locator(`${root}[data-testid="world-bound"]`);
    // The homebrew shelf is the user's, shared by every run: a name of this
    // run's own, so the roster's name finds this run's monster alone.
    const creature = `The Tidewyrm ${Date.now().toString(36)}`;
    try {
      const wyrm = (await (await api.post(entities, { data: { typeId: "t_other", name: creature, text: "It coils under the sea wall." } })).json()).entity;
      const lantern = (await (await api.post(entities, { data: { typeId: "t_artifact", name: "The Drowned Lantern", text: "It burns under water." } })).json()).entity;

      // From the article: a stat block made and linked.
      await t.open(`/workshop/${id}?system=world&entry=${encodeURIComponent(wyrm.ref)}`);
      await eventually(() => heading(creature).count(), { timeoutMs: 30_000, label: "the creature's article" });
      await bound.getByRole("button", { name: "A stat block" }).click();
      await bound.getByRole("button", { name: /Make a new one/ }).click();
      const record = bound.locator('[data-testid="world-bound-record"]').first();
      await eventually(async () => (await record.innerText().catch(() => "")).includes(creature), { timeoutMs: 15_000, label: "the new stat block linked" });
      await t.shot("linked");

      // That exact monster into a new fight, which opens.
      await record.getByRole("button", { name: /Add to a fight/ }).click();
      await record.getByRole("button", { name: "Add it" }).click();
      await eventually(async () => (await params()).get("system") === "encounters" && Boolean((await params()).get("open")), { timeoutMs: 15_000, label: "the fight opened in Encounters" });
      const roster = page.getByRole("textbox", { name: "Roster" });
      await eventually(() => roster.isVisible(), { timeoutMs: 20_000, label: "the fight's editor" });
      check((await roster.inputValue()).includes(creature), `the roster names the linked monster: ${JSON.stringify(await roster.inputValue())}`);

      // Back to the article, then the stat block by its own button, then back by the Bestiary's.
      await page.keyboard.press("Escape");
      await page.locator(`${root}[data-testid="back-to-world-entry"]`).click();
      await eventually(() => heading(creature).count(), { timeoutMs: 20_000, label: "back on the article" });
      await bound.locator('[data-testid="world-bound-record"]').first().getByRole("button", { name: "Open" }).click();
      const linked = page.locator('[data-testid="linked-entries"]');
      await eventually(() => linked.isVisible(), { timeoutMs: 20_000, label: "the stat block open, naming the article" });
      check((await params()).get("system") === "bestiary", "the stat block opened in the Bestiary");
      await linked.getByRole("button", { name: creature }).click();
      await eventually(() => heading(creature).count(), { timeoutMs: 20_000, label: "the article reopened from the stat block" });

      // An Artifact is lore only until it is an item, and then the shop can stock it.
      await t.open(`/workshop/${id}?system=world&entry=${encodeURIComponent(lantern.ref)}`);
      await eventually(() => heading("The Drowned Lantern").count(), { timeoutMs: 30_000, label: "the artifact's article" });
      check((await page.locator(`${root}[data-testid="world-lore-only"]`).count()) === 1, "the artifact reads as lore only");
      await bound.getByRole("button", { name: "An item" }).click();
      await bound.getByRole("button", { name: /Make a new one/ }).click();
      await eventually(async () => (await page.locator(`${root}[data-testid="world-lore-only"]`).count()) === 0, { timeoutMs: 15_000, label: "lore only no longer, once an item is linked" });
      const items = await (await api.get(`${base}/api/content/items?campaign=${id}&q=${encodeURIComponent("Drowned Lantern")}`)).json();
      const rows = items.results ?? items.entries ?? items.items ?? [];
      check(rows.some((row) => row.name === "The Drowned Lantern" && String(row.slug ?? "").startsWith("homebrew:")), `the shop's item picker finds the linked item: ${JSON.stringify(rows).slice(0, 200)}`);
    } finally {
      await api.delete(`${base}/api/workshops/${id}`);
    }
  },
};
