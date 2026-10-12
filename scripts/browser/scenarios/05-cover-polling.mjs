// PR 217: the campaign cover dialog polled for a painting in progress, but
// its effect re-ran only when the answer changed, so a first cover (no
// picture yet, status "queued" twice in a row) stopped being watched after
// one poll and never appeared. The picture backend is stood in for here:
// the route answers queued, queued, generating, then the finished cover, and
// the dialog must keep asking until it gets there.
import { check, eventually } from "../lib.mjs";

const COVER = "/assets/placeholders/campaign-cover.png";

export default {
  name: "cover-polling",
  viewports: ["desktop"],
  // The app's screens call the same route through the host; the stand-in
  // below is a browser-level route, which the app's patched fetch bypasses.
  app: false,
  async run(t) {
    const { page, root, ids } = t;
    let polls = 0;
    await page.route(/\/api\/capabilities(\?|$)/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.images = { ...body.images, configured: true, reachable: true, backend: "stand-in" };
      await route.fulfill({ response, json: body });
    });
    await page.route(new RegExp(`/api/campaigns/${ids.lobbyId}/cover(\\?|$)`), async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        await route.fulfill({ json: { ok: true, cover: null, status: "queued" } });
        return;
      }
      if (method !== "GET") {
        await route.fallback();
        return;
      }
      polls += 1;
      const status = polls <= 2 ? "queued" : polls === 3 ? "generating" : null;
      await route.fulfill({ json: status ? { cover: null, status } : { cover: { id: "stand-in", url: COVER }, status: null } });
    });
    await t.open(`/campaigns/${ids.lobbyId}`);
    await t.tap(page.locator(`${root}[aria-label="Edit campaign settings"]`).first());
    const paint = page.getByRole("button", { name: /^paint one$/i });
    await eventually(() => paint.count(), { label: "the Paint one button in the cover dialog" });
    await t.tap(paint);
    await eventually(() => page.getByRole("button", { name: /painting/i }).count(), { label: "the dialog showing the painting in progress" });
    // Four answers at 2.5 s each: the fix keeps polling through the two
    // unchanged "queued" answers; the old effect stopped after the first.
    await eventually(() => polls >= 4, { timeoutMs: 25_000, label: `the dialog polling past unchanged answers (polled ${polls} times)` });
    await eventually(() => page.getByRole("button", { name: /^paint one$/i }).count(), { label: "the painting finishing in the dialog" });
    check(polls >= 4, `polled ${polls} times`);
    await t.shot("cover-landed");
  },
};
