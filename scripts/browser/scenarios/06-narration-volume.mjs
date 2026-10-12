// PR 219: a narration level saved as 0 read back as the 0.8 default on the
// next page (the reader took a stored zero for "nothing stored"). The
// header's narration slider must open at the level this browser saved,
// zero included, and a level set on the slider must survive a reload.
import { check, eventually, settle } from "../lib.mjs";

const SLIDER = (root) => `${root}input[aria-label="Narration volume"]`;

export default {
  name: "narration-volume",
  viewports: ["desktop"],
  async run(t) {
    const { page, root, ids } = t;
    // The saved level, as a browser that set it earlier holds it: planted
    // before the page (the server's pages load fresh; the app's shell is
    // already up, so its document takes it directly).
    const plant = () => {
      if (!window.localStorage.getItem("odm_tts_volume_seeded")) {
        window.localStorage.setItem("odm_tts_volume", "0");
        window.localStorage.setItem("odm_tts_muted", "0");
        window.localStorage.setItem("odm_tts_volume_seeded", "1");
      }
    };
    await page.context().addInitScript(plant);
    if (t.app) await page.evaluate(plant);
    await t.open(`/campaigns/${ids.campaignId}`);
    const slider = page.locator(SLIDER(root)).locator("visible=true").first();
    await eventually(() => slider.count(), { timeoutMs: 30_000, label: "the narration volume slider in the table's header" });
    check((await slider.inputValue()) === "0", `a saved narration level of 0 opens at 0 (slider reads ${await slider.inputValue()})`);
    // A level set here is what the next page opens at.
    await slider.fill("0.35");
    await eventually(() => page.evaluate(() => window.localStorage.getItem("odm_tts_volume")).then((v) => v === "0.35"), { label: "the slider writing its level" });
    // The app's shell would need entering again after a reload; the server's
    // page is the one that reloads here (the reader is the same code).
    if (t.app) return;
    await page.reload({ waitUntil: "networkidle" });
    // The slider shows once the page has had a gesture (the browser's
    // autoplay rule); a key press is one.
    await settle(page);
    const again = page.locator(SLIDER(root)).locator("visible=true").first();
    await eventually(() => again.count(), { timeoutMs: 30_000, label: "the slider after a reload" });
    check((await again.inputValue()) === "0.35", `the level set on the slider survives a reload (reads ${await again.inputValue()})`);
  },
};
