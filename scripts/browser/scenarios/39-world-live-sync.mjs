// WF-21: the workshop's tools stay current. A record written somewhere else
// (another tab, another tool, the API) shows in the open tool without a
// reload; an editor with changes not saved is asked about before the
// author moves to another tool, and keeps its draft when they stay; an
// editor whose changes were saved is not asked about.
import { check, eventually } from "../lib.mjs";

export default {
  name: "world-live-sync",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, base, root, api } = t;
    const made = await api.post(`${base}/api/workshops`, { data: { title: "Live sync", description: "" } });
    check(made.ok(), "a workshop for the check");
    const id = (await made.json()).workshop.id;
    // The tools' first-visit tours open a moment after a tool does, over
    // whatever is about to be pressed; this check is about staying current, so they
    // count as seen on the account before any page loads.
    await api.post(`${base}/api/profile/tours`, { data: { finished: ["world", "cast", "lore", "factions"].map((tool) => ({ id: `workshop-${tool}`, version: 1, how: "ended" })) } });
    const entities = `${base}/api/campaigns/${id}/world/entities`;
    const rail = (label) => page.locator(`${root}[data-tour="system-rail"] button`, { hasText: label }).first();
    const params = async () => (await t.url()).searchParams;
    try {
      const mara = (await (await api.post(entities, { data: { typeId: "t_character", name: "Mara Quill" } })).json()).entity;

      // The Cast, open: a member made elsewhere arrives without a reload.
      await t.open(`/workshop/${id}?system=cast`);
      await eventually(() => page.getByText("Mara Quill").first().isVisible(), { timeoutMs: 30_000, label: "the Cast list" });
      await api.post(entities, { data: { typeId: "t_character", name: "Tomas Reed" } });
      await eventually(() => page.getByText("Tomas Reed").first().isVisible(), { timeoutMs: 15_000, label: "a member made elsewhere shown live" });

      // WorldForge, open: a lore entry written in the Lore tool's own route arrives too.
      await t.open(`/workshop/${id}?system=world`);
      const list = page.locator(`${root}[role="listbox"][aria-label="Entries"]`);
      await eventually(() => list.getByText("Mara Quill").first().isVisible(), { timeoutMs: 30_000, label: "the wiki's list" });
      const lore = await api.post(`${base}/api/campaigns/${id}/lore`, { data: { category: "history", title: "The Drowned Bell", body: "It rings at low tide." } });
      check(lore.ok(), `a lore entry written in Lore (${lore.status()})`);
      await eventually(() => list.getByText("The Drowned Bell").first().isVisible(), { timeoutMs: 15_000, label: "a lore entry written elsewhere shown live" });

      // An editor with changes: moving to another tool asks, and staying keeps the draft.
      await t.open(`/workshop/${id}?system=world&entry=${encodeURIComponent(mara.ref)}`);
      await eventually(() => page.locator(`${root}[data-tour="world-edit"]`).count(), { timeoutMs: 30_000, label: "Mara's entry" });
      await page.locator(`${root}[data-tour="world-edit"]`).first().click();
      const name = page.locator(`${root}form input[required]`).first();
      await eventually(() => name.count(), { timeoutMs: 15_000, label: "the entry editor" });
      await name.fill("Mara Quill the Younger");
      await rail("Cast").click();
      const ask = page.getByRole("button", { name: "Leave them" });
      await eventually(() => ask.isVisible(), { timeoutMs: 10_000, label: "the question before leaving unsaved changes" });
      await t.shot("unsaved");
      await page.getByRole("button", { name: "Cancel" }).click();
      check((await params()).get("system") === "world", "staying kept the author in WorldForge");
      check((await name.inputValue()) === "Mara Quill the Younger", "staying kept the draft");

      // Saved, the editor is no longer asked about.
      await page.locator(`${root}form button[type="submit"]`).first().click();
      await eventually(async () => (await page.locator(`${root}form input[required]`).count()) === 0, { timeoutMs: 15_000, label: "the entry saved" });
      await rail("Cast").click();
      await eventually(async () => (await params()).get("system") === "cast", { timeoutMs: 10_000, label: "moving on once saved, with no question" });
      check(!(await ask.isVisible().catch(() => false)), "a saved editor was asked about");
      await eventually(() => page.getByText("Mara Quill the Younger").first().isVisible(), { timeoutMs: 15_000, label: "the saved name in the Cast" });

      // The Cast's own editor, saved, is not asked about either.
      await page.getByText("Tomas Reed").first().click();
      const sheet = page.getByRole("dialog", { name: "Tomas Reed" });
      await eventually(() => sheet.isVisible(), { timeoutMs: 15_000, label: "Tomas's editor" });
      await sheet.getByPlaceholder("What they do").fill("  Mends nets on the quay  ");
      await sheet.getByRole("button", { name: /Save them/ }).click();
      await eventually(async () => !(await sheet.getByRole("button", { name: /Save them/ }).isDisabled().catch(() => true)), { timeoutMs: 15_000, label: "the Cast save finished" });
      await page.keyboard.press("Escape");
      await rail("Lore").click();
      await eventually(async () => (await params()).get("system") === "lore", { timeoutMs: 10_000, label: "leaving the Cast after a save, with no question" });
    } finally {
      await api.delete(`${base}/api/workshops/${id}`);
    }
  },
};
