// WF-08, M2's acceptance in the browser: start at Create, from WorldForge's
// empty wiki, make a real monster in the Bestiary, give it a World entry,
// put that exact monster into a fight, and reopen both the article and the
// stat block without searching by name. The NPC and player-character
// choices reach their own editors.
import { check, eventually } from "../lib.mjs";

export default {
  name: "create-chooser",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, base, root, api } = t;
    const made = await api.post(`${base}/api/workshops`, { data: { title: "Made from Create", description: "" } });
    check(made.ok(), "a workshop for the check");
    const id = (await made.json()).workshop.id;
    // The tools' first-visit tours open over whatever is about to be pressed.
    await api.post(`${base}/api/profile/tours`, { data: { finished: ["hub", "world", "bestiary", "encounters", "cast"].map((tool) => ({ id: `workshop-${tool}`, version: 1, how: "ended" })) } });
    const params = async () => (await t.url()).searchParams;
    const chooser = page.getByRole("dialog");
    const heading = (name) => page.locator(`${root}[data-tour="world-entry"] h3`, { hasText: name });
    // The homebrew shelf is the user's, shared by every run: a name of this
    // run's own, so the roster's name finds this run's monster alone.
    const creature = `Ash Mire Drake ${Date.now().toString(36)}`;
    try {
      // From WorldForge's empty wiki: Create, a creature, the Bestiary's own builder.
      await t.open(`/workshop/${id}?system=world`);
      const empty = page.locator(`${root}[data-testid="world-empty-create"] [data-testid="create-open"]`);
      await eventually(() => empty.isVisible(), { timeoutMs: 30_000, label: "Create in the empty wiki" });
      await empty.click();
      await chooser.locator('[data-testid="create-choice-creature"]').click();
      check((await chooser.locator('[data-testid="create-lands"]').innerText()) === "Bestiary", "a creature says it lands in the Bestiary");
      await t.shot("creature-ways");
      await chooser.locator('[data-testid="create-step"]', { hasText: "Build a monster" }).click();
      await eventually(async () => (await params()).get("system") === "bestiary", { timeoutMs: 20_000, label: "the Bestiary" });
      const name = page.getByPlaceholder("Bone Tyrant");
      await eventually(() => name.isVisible(), { timeoutMs: 20_000, label: "the Bestiary's builder opened" });
      await name.fill(creature);
      await page.getByRole("button", { name: "Start from the baseline" }).click();

      // The new stat block, given a World entry, which opens on it.
      const give = page.locator('[data-testid="give-world-entry"]');
      await eventually(() => give.isVisible(), { timeoutMs: 20_000, label: "the new stat block offering a World entry" });
      await t.shot("stat-block");
      await give.click();
      await eventually(async () => (await params()).get("system") === "world" && ((await params()).get("entry") ?? "").startsWith("lore:"), { timeoutMs: 20_000, label: "the new World entry" });
      await eventually(() => heading(creature).count(), { timeoutMs: 20_000, label: "the article for the monster" });

      // That exact monster into a new fight.
      const record = page.locator(`${root}[data-testid="world-bound-record"]`).first();
      check((await record.innerText()).includes(creature), "the article links the new stat block");
      await record.getByRole("button", { name: /Add to a fight/ }).click();
      await record.getByRole("button", { name: "Add it" }).click();
      await eventually(async () => (await params()).get("system") === "encounters" && Boolean((await params()).get("open")), { timeoutMs: 15_000, label: "the fight opened in Encounters" });
      const roster = page.getByRole("textbox", { name: "Roster" });
      await eventually(() => roster.isVisible(), { timeoutMs: 20_000, label: "the fight's editor" });
      check((await roster.inputValue()).includes(creature), `the roster names the new monster: ${JSON.stringify(await roster.inputValue())}`);

      // Back to the article, then the stat block by its own button.
      await page.keyboard.press("Escape");
      await page.locator(`${root}[data-testid="back-to-world-entry"]`).click();
      await eventually(() => heading(creature).count(), { timeoutMs: 20_000, label: "back on the article" });
      await page.locator(`${root}[data-testid="world-bound-record"]`).first().getByRole("button", { name: "Open" }).click();
      const linked = page.locator('[data-testid="linked-entries"]');
      await eventually(() => linked.isVisible(), { timeoutMs: 20_000, label: "the stat block open, naming its article" });
      check((await params()).get("system") === "bestiary", "the stat block opened in the Bestiary");
      await page.keyboard.press("Escape");

      // An NPC from the tool's own header goes to the Cast's editor.
      await page.locator(`${root}[data-testid="create-open"]`).first().click();
      await chooser.locator('[data-testid="create-choice-npc"]').click();
      await chooser.locator('[data-testid="create-step"]').first().click();
      await eventually(async () => (await params()).get("system") === "cast", { timeoutMs: 20_000, label: "the Cast" });
      await eventually(() => page.getByRole("dialog", { name: "Someone new" }).isVisible(), { timeoutMs: 20_000, label: "the NPC editor opened" });
      await t.shot("npc-editor");

      // A player character, from the hub's Create, goes to the character builder.
      await t.open(`/workshop/${id}`);
      const hub = page.locator(`${root}[data-testid="create-open"]`).first();
      await eventually(() => hub.isVisible(), { timeoutMs: 30_000, label: "Create on the hub" });
      await hub.click();
      await chooser.locator('[data-testid="create-choice-pc"]').click();
      await chooser.locator('[data-testid="create-step"]', { hasText: "Build a character" }).click();
      await eventually(async () => (await t.url()).pathname === "/characters/new", { timeoutMs: 20_000, label: "the character builder" });
    } finally {
      await api.delete(`${base}/api/workshops/${id}`);
    }
  },
};
