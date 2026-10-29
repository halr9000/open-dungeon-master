// Issue 305: the lead's Context panel says which world lore entries the
// last turn carried and why, and which it held back. Read against the trace
// the route answers (the seeded one, or a turn another scenario ran on this
// table since): one row an entry, kept rows plain, held-back close matches
// red, near matches muted, secrets marked, counts matching.
import { check, eventually, openPanelTab } from "../lib.mjs";

export default {
  name: "lore-trace",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, api, base } = t;
    const answer = await (await api.get(`${base}/api/campaigns/${ids.quietId}/context-trace`)).json();
    const lore = answer.trace?.lore;
    check(Boolean(lore), "the quiet table's last turn left a lore trace");
    await t.open(`/campaigns/${ids.quietId}`);
    await openPanelTab(t, "context");
    const panel = page.locator(`${root}[data-testid="lore-trace"]`).locator("visible=true").first();
    await eventually(() => panel.count(), { timeoutMs: 30_000, label: "the World lore section" });
    await panel.scrollIntoViewIfNeeded();
    const text = (await panel.textContent()).replace(/\s+/g, " ");
    const kept = lore.picks.filter((pick) => pick.included).length;
    const matched = lore.picks.filter((pick) => !pick.weak).length;
    check(text.includes(`World lore${kept}/${matched} entries`) || text.includes(`World lore ${kept}/${matched} entries`), `the counts (${kept}/${matched}) head the section (${text})`);
    const rows = panel.locator("li");
    check((await rows.count()) === lore.picks.length, `one row an entry (${await rows.count()} of ${lore.picks.length})`);
    for (const [index, pick] of lore.picks.entries()) {
      const row = rows.nth(index);
      const rowText = (await row.textContent()).replace(/\s+/g, " ");
      check(rowText.startsWith(pick.title), `row ${index + 1} names ${pick.title} (${rowText})`);
      check(rowText.includes(pick.reason), `row ${index + 1} says why (${rowText})`);
      check(/\(secret\)/.test(rowText) === Boolean(pick.secret), `row ${index + 1} marks a secret only when it is one`);
      const state = pick.included ? "kept" : pick.weak ? "near" : "held";
      check((await row.getAttribute("data-lore-pick")) === state, `row ${index + 1} reads as ${state}`);
    }
    // The seeded moment asked for every crossing: the pinned guild is kept
    // and the festival and the lich are not. Only that turn's trace is held
    // to it; a turn another scenario ran here since asked something else,
    // and what its moment matches is its own business (the rows above are
    // still checked against it).
    if (answer.turnId === ids.quietLoreTurnId) {
      check(lore.picks.some((pick) => pick.title === "The Ferry Guild" && pick.pinned && pick.included), "the pinned guild is kept");
      check(!lore.picks.some((pick) => /Harvest Festival|Lich of the Fens/.test(pick.title) && pick.included), "unrelated lore is never kept");
    }
    await t.shot("lore-trace");
  },
};
