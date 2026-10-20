// WF-07 in the import picker: choosing a workshop with a world ticks what
// WorldForge describes with it; unticking Places while WorldForge stays
// ticked is a deliberate exclusion, said beside the switch and counted in
// the plan; ticking WorldForge again brings Places back; and the import
// lands the world with its records.
import { check, eventually } from "../lib.mjs";

export default {
  name: "world-use-in-campaign",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, base, root, api } = t;
    const stamp = Date.now().toString(36);
    const shopTitle = `Harbour world ${stamp}`;
    const shop = await api.post(`${base}/api/workshops`, { data: { title: shopTitle, description: "" } });
    check(shop.ok(), "a workshop with a world");
    const shopId = (await shop.json()).workshop.id;
    const entities = `${base}/api/campaigns/${shopId}/world/entities`;
    const table = await api.post(`${base}/api/campaigns`, { data: { title: `Harbour table ${stamp}`, gameSettings: { ttsEnabled: false } } });
    check(table.ok(), `a campaign to bring it into (${table.status()})`);
    const campaignId = (await table.json()).campaign.id;
    try {
      await api.post(entities, { data: { typeId: "t_character", name: "Captain Mara" } });
      await api.post(entities, { data: { typeId: "t_location", name: "Gullhaven", text: "A harbour." } });
      await api.post(entities, { data: { typeId: "t_other", name: "The Drowned Bell", text: "It rings at low tide." } });

      await t.open(`/campaigns/${campaignId}`);
      const startFrom = page.getByRole("button", { name: "Start from" }).locator("visible=true").first();
      await eventually(() => startFrom.count(), { timeoutMs: 30_000, label: "the import picker" });
      await startFrom.scrollIntoViewIfNeeded();
      await t.tap(startFrom);
      await t.tap(page.getByRole("menuitemradio", { name: shopTitle }).locator("visible=true").first());

      const places = page.getByRole("switch", { name: "Places" }).locator("visible=true").first();
      const worldSwitch = page.getByRole("switch", { name: /WorldForge/ }).locator("visible=true").first();
      await eventually(() => places.count(), { timeoutMs: 15_000, label: "the Places switch" });
      check((await places.getAttribute("aria-checked")) === "true", "Places is ticked with the world");
      check(await page.locator('[data-testid="import-world-needs-locations"]').locator("visible=true").first().isVisible(), "Places says WorldForge needs it");

      // Places left out on purpose: said beside it, and counted in the plan.
      await t.tap(places);
      await eventually(async () => /Left out on purpose/.test(await page.locator('[data-testid="import-world-needs-locations"]').locator("visible=true").first().innerText()), { label: "Places marked left out on purpose" });
      await eventually(async () => /Leaving out places: WorldForge drops 1 World entry/.test(await page.locator("body").innerText()), { timeoutMs: 15_000, label: "the plan naming what leaving places out loses" });
      await t.shot("left-out");

      // WorldForge off and on again brings Places back with it.
      await t.tap(worldSwitch);
      await t.tap(worldSwitch);
      await eventually(async () => (await places.getAttribute("aria-checked")) === "true", { label: "Places ticked again with the world" });

      const bring = page.getByRole("button", { name: /Bring it in/ }).locator("visible=true").first();
      await eventually(() => bring.isEnabled(), { label: "Bring it in enabled" });
      await t.tap(bring);
      await eventually(async () => /Brought \d+ items? across/.test(await page.locator("body").innerText()), { timeoutMs: 20_000, label: "the import's note" });
      const world = await (await api.get(`${base}/api/campaigns/${campaignId}/world`)).json();
      const names = (world.entities ?? []).map((entity) => entity.name).sort();
      check(JSON.stringify(names) === JSON.stringify(["Captain Mara", "Gullhaven", "The Drowned Bell"]), `the world arrived with its records: ${JSON.stringify(names)}`);
    } finally {
      await api.delete(`${base}/api/workshops/${shopId}`);
    }
  },
};
