// "Level up" on a library character opens its build one level up: the title
// says the level it reaches, and Save changes waits while the new level owes
// a pick (a level 3 fighter reaching 4 owes an ability score improvement).
// The library pages are native screens in the app too.
import { check, eventually } from "../lib.mjs";

const visible = (page, root, text) =>
  page.locator(`${root}a, ${root}button`).filter({ hasText: text }).locator("visible=true");

export default {
  name: "library-level-up",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids } = t;
    await t.open(`/characters/${ids.library}`);
    const level = await eventually(async () => {
      const button = visible(page, root, /Level up to \d+/);
      return (await button.count()) ? button.first() : null;
    }, { label: "the Level up button" });
    // textContent, not innerText: the button is set in capitals by CSS.
    const target = Number(/level up to (\d+)/i.exec((await level.textContent()) ?? "")?.[1]);
    await t.tap(level);
    await page.locator(`${root}input[aria-label="Name"]`).locator("visible=true").first().waitFor({ state: "visible", timeout: 30_000 });
    await eventually(async () => {
      const text = (await page.locator(`${root}h1, ${root}h2`).allInnerTexts()).join(" ");
      return new RegExp(`reaches level ${target}`, "i").test(text);
    }, { timeoutMs: 15_000, label: `the title naming level ${target}` });
    const body = (await page.locator(root ? root.trim() : "body").first().innerText()).replace(/\s+/g, " ");
    check(new RegExp(`level ${target}`, "i").test(body), `the build opens at level ${target}`);
    await t.shot("levelled");
    // Level 4 brings an ability score improvement, so nothing is saved until
    // it is picked.
    if (target === 4) {
      check((await visible(page, root, /^Save changes$/).count()) === 0, "Save changes waits for the new improvement");
    }
  },
};
