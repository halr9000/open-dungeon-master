// WF-11: a World entry and its record's own tool link to each other
// exactly, and the URL holds where the author is. Opening a Cast member's
// own tool opens that member's editor; "World entry" there comes back;
// refresh and Back land on the same entry, view and editor.
import { check, eventually } from "../lib.mjs";

export default {
  name: "world-exact-links",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, base, root, api } = t;
    const made = await api.post(`${base}/api/workshops`, { data: { title: "Exact links", description: "" } });
    check(made.ok(), "a workshop for the check");
    const id = (await made.json()).workshop.id;
    // The tools' first-visit tours open a moment after a tool does, over
    // whatever is about to be pressed; this check is about links, so they
    // count as seen on the account before any page loads.
    await api.post(`${base}/api/profile/tours`, { data: { finished: ["world", "cast", "lore", "factions"].map((tool) => ({ id: `workshop-${tool}`, version: 1, how: "ended" })) } });
    const entities = `${base}/api/campaigns/${id}/world/entities`;
    try {
      // Another member first, so the one asked for is not simply the first row.
      await api.post(entities, { data: { typeId: "t_character", name: "Aldo Brine" } });
      const mara = (await (await api.post(entities, { data: { typeId: "t_character", name: "Mara Quill", tagline: "Keeps the lighthouse." } })).json()).entity;
      const bell = (await (await api.post(entities, { data: { typeId: "t_other", name: "The Drowned Bell", text: "It rings at low tide." } })).json()).entity;
      const params = async () => (await t.url()).searchParams;
      const heading = (name) => page.locator(`${root}[data-tour="world-entry"] h3`, { hasText: name });
      const dialog = (name) => page.getByRole("dialog", { name });

      // A link straight to an entry opens it.
      await t.open(`/workshop/${id}?system=world&view=wiki&entry=${encodeURIComponent(mara.ref)}`);
      await eventually(() => heading("Mara Quill").count(), { timeoutMs: 30_000, label: "the linked entry open" });

      // Its own tool opens that member, not the list.
      await page.locator(`${root}button[title="Open Mara Quill's own tool"]`).click();
      await eventually(() => dialog("Mara Quill").count(), { timeoutMs: 20_000, label: "Mara's editor open in the Cast" });
      check((await params()).get("system") === "cast" && (await params()).get("open") === mara.id && (await params()).get("from") === mara.ref, `the URL names the record and the way back: ${page.url()}`);
      await t.shot("cast-editor");

      // Refresh lands on the same editor.
      await t.reload();
      await eventually(() => dialog("Mara Quill").count(), { timeoutMs: 30_000, label: "Mara's editor after a refresh" });

      // "World entry" comes back to her page.
      await dialog("Mara Quill").locator('[data-testid="world-entry-link"]').click();
      await eventually(() => heading("Mara Quill").count(), { timeoutMs: 20_000, label: "back on Mara's World entry" });
      check((await params()).get("system") === "world" && (await params()).get("entry") === mara.ref, `the URL names her entry: ${page.url()}`);

      // Back returns to her editor; closing it leaves "Back to the World entry".
      // The browser's Back only: the app's shell owns its back gesture, and
      // its navigation contract has no Back to drive from here.
      if (!t.app) {
        await page.goBack();
        await eventually(() => dialog("Mara Quill").count(), { timeoutMs: 20_000, label: "Back reopens Mara's editor" });
      } else {
        await page.locator(`${root}button[title="Open Mara Quill's own tool"]`).first().click();
        await eventually(() => dialog("Mara Quill").count(), { timeoutMs: 20_000, label: "Mara's editor reopened" });
      }
      await page.keyboard.press("Escape");
      const backLink = page.locator(`${root}[data-testid="back-to-world-entry"]`);
      await eventually(() => backLink.isVisible(), { timeoutMs: 10_000, label: "the way back to the World entry" });
      await backLink.click();
      await eventually(() => heading("Mara Quill").count(), { timeoutMs: 20_000, label: "back on Mara's entry by the link" });

      // A lore entry the same way, through Lore's own editor.
      await t.open(`/workshop/${id}?system=world&entry=${encodeURIComponent(bell.ref)}`);
      await eventually(() => heading("The Drowned Bell").count(), { timeoutMs: 30_000, label: "the bell's entry" });
      await page.locator(`${root}button[title="Open The Drowned Bell's own tool"]`).click();
      await eventually(() => dialog("The Drowned Bell").count(), { timeoutMs: 20_000, label: "the bell open in Lore" });
      await dialog("The Drowned Bell").locator('[data-testid="world-entry-link"]').click();
      await eventually(() => heading("The Drowned Bell").count(), { timeoutMs: 20_000, label: "back on the bell's entry" });

      // The view is in the URL too: the web survives a refresh.
      await page.locator(`${root}[data-tour="world-view-web"]`).first().click();
      await eventually(async () => (await params()).get("view") === "web", { timeoutMs: 10_000, label: "the web view in the URL" });
      await t.reload();
      await eventually(async () => (await page.locator(`${root}[data-tour="world-view-web"][aria-selected="true"], ${root}[data-tour="world-view-web"][aria-current]`).count()) > 0 || (await params()).get("view") === "web", { timeoutMs: 20_000, label: "the web view after a refresh" });
      check((await params()).get("view") === "web", "the view survived a refresh");
    } finally {
      await api.delete(`${base}/api/workshops/${id}`);
    }
  },
};
