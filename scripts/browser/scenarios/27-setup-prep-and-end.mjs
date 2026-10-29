// Prep and the end of a campaign, once play has begun. Both used to live
// only server-side at a table in play: the import picker was in the lobby
// alone, and nothing sent "ended". The Settings tab now brings prep in
// mid-campaign (here from a finished campaign; a workshop is the same
// copy), and ends the campaign behind a confirm; an ended
// table blocks the composer and says so above it.
import { check, eventually, openPanelTab } from "../lib.mjs";

export default {
  name: "setup-prep-and-end",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, api, base, viewport } = t;
    // One table per viewport: the first run closes its own.
    const campaignId = ids.closing[viewport];
    check(Boolean(campaignId), `the seed has a closing table for ${viewport}`);
    await t.open(`/campaigns/${campaignId}`);

    // The Settings tab: in the rail on a desktop, under More on a phone.
    await openPanelTab(t, "settings");

    // Bring in prep: the source's roll table, chosen and copied.
    const prep = page.locator(`${root}[data-setup-prep]`).locator("visible=true").first();
    await eventually(() => prep.count(), { timeoutMs: 20_000, label: "Bring in prep in the Settings tab" });
    await prep.scrollIntoViewIfNeeded();
    // The kit's Select: a menu button named by its label, rows as radio items.
    await t.tap(prep.getByRole("button", { name: "Start from" }));
    await t.tap(page.getByRole("menuitemradio", { name: ids.prepSourceTitle }).locator("visible=true").first());
    const bring = prep.getByRole("button", { name: /Bring it in/ });
    await eventually(() => bring.isEnabled(), { label: "Bring it in enabled once the source is chosen" });
    await t.shot("prep-chosen");
    await t.tap(bring);
    await eventually(async () => /Brought 1 item/.test(await prep.innerText()), { label: "the import's note" });
    // The import's own plan, asked again, now finds the table already here.
    const again = await (
      await api.get(`${base}/api/campaigns/${campaignId}/import?sourceId=${ids.prepSourceId}&select=tables`)
    ).json();
    check(again.plan?.kept === 1, `the source's roll table landed at the table (kept ${again.plan?.kept})`);

    // End the campaign: a confirm first, then every seat sees it ended.
    const end = page.locator(`${root}[data-end-campaign]`).locator("visible=true").first();
    await end.scrollIntoViewIfNeeded();
    await t.tap(end);
    const dialog = page.getByRole("dialog");
    await eventually(() => dialog.count(), { label: "the confirm before ending" });
    check(/cannot be undone/i.test(await dialog.innerText()), "the confirm says ending is for good");
    // The dialog's title row stays put while its body scrolls; it must sit
    // above the message, not over its first line.
    await eventually(async () => {
      const head = await dialog.locator("h2").first().boundingBox();
      const body = await dialog.locator("p").first().boundingBox();
      return Boolean(head && body && body.y >= head.y + head.height - 1);
    }, { label: "the confirm's message below its title row" });
    await t.shot("end-confirm");
    await t.tap(dialog.getByRole("button", { name: "End the campaign" }));
    await eventually(async () => {
      const data = await (await api.get(`${base}/api/campaigns/${campaignId}`)).json();
      return data.campaign?.status === "ended";
    }, { label: "the campaign saved as ended" });
    await eventually(() => page.locator(`${root}[data-campaign-ended]`).locator("visible=true").count(), {
      label: "the Settings tab saying the campaign has ended",
    });
    check((await page.locator(`${root}[data-setup-prep]`).count()) === 0, "an ended campaign offers no more prep");

    // The table view: the banner, and a composer that takes nothing more.
    const tableView = page.locator(`${root}.cine-bottombar button`).filter({ hasText: /^\s*Table\s*$/ }).locator("visible=true").first();
    if (await tableView.count()) {
      await t.tap(tableView);
    }
    await eventually(() => page.locator(`${root}.campaign-ended-banner`).locator("visible=true").count(), {
      label: "the ended banner above the composer",
    });
    await t.shot("ended");
    const refused = await api.post(`${base}/api/campaigns/${campaignId}/import`, {
      data: { sourceId: ids.prepSourceId, select: ["tables"] },
    });
    check(refused.status() === 400, `importing into an ended campaign answered ${refused.status()}`);
  },
};
