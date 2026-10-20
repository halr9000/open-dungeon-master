// Client issue 46: the table's panels move and resize, the arrangement is
// this browser's own and comes back after a reload, Reset always gives the
// table's own arrangement back, and none of it disturbs play: a draft in
// the composer, the board and the side panel's contents carry on through
// every move, and the server never hears of it. A phone keeps its bottom
// bar whatever a wide window arranged.
import { check, eventually, sleep, openPanelTab } from "../lib.mjs";

const KEY = "odm:table-layout:player";

const readLayout = (page) => page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "null"), KEY);
const clearLayouts = (page) =>
  page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("odm:table-layout:") || key === "odm_side_panel_wide") window.localStorage.removeItem(key);
    }
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
// What a reload reads: the saved arrangement again, not the page's memory
// of it (the apps keep their screens across a visit, so a reload there is
// the store forgetting and reading localStorage afresh).
const rereadLayouts = (page) => page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));

const boxOf = (locator) => locator.boundingBox();

// The table's first-visit tour opens a moment after the table does, over
// everything; closed first, so it never takes the first drag as its click.
async function dismissTour(page) {
  const tour = page.locator('[role="dialog"][aria-label="Guided tour"]');
  await eventually(() => tour.count(), { timeoutMs: 4_000 }).catch(() => 0);
  for (let attempt = 0; attempt < 3 && (await tour.count()); attempt += 1) {
    await page.keyboard.press("Escape");
    await sleep(250);
  }
}

async function drag(page, from, dx, dy, steps = 8) {
  const box = await boxOf(from);
  check(Boolean(box), "the thing to drag is on screen");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps });
  await sleep(120);
  await page.mouse.up();
  await sleep(300);
}

export default {
  name: "table-layout",
  viewports: ["desktop", "laptop", "phone"],
  async run(t) {
    const { page, root, ids, viewport } = t;
    const layoutCalls = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.includes("/api/") && /layout|arrange/i.test(pathname)) layoutCalls.push(request.url());
    });
    await t.open(`/campaigns/${ids.campaignId}`);
    await dismissTour(page);
    await clearLayouts(page);
    await eventually(() => page.locator(`${root}.cine-stage`).count(), { timeoutMs: 30_000, label: "the table's stage" });
    const row = page.locator(`${root}.cine-row`).first();
    const slot = (id) => page.locator(`${root}.tlay-slot[data-pane="${id}"]`).first();
    const composer = page.locator(`${root}[data-tour="composer-input"] textarea`).locator("visible=true").first();
    const menuButton = page.locator(`${root}[data-tour="header-layout"]`);

    if (viewport === "phone") {
      // A saved arrangement from a wide window: Notes in a pane of its own.
      await page.evaluate((key) => {
        const layout = {
          version: 1,
          locked: false,
          chronicle: null,
          floating: [],
          columns: [
            { width: 236, panes: [{ id: "rail", size: 1 }] },
            { width: null, panes: [{ id: "table", size: 1 }] },
            { width: 384, panes: [{ id: "panel", size: 0.5 }, { id: "tab:notes", size: 0.5 }] },
          ],
        };
        window.localStorage.setItem(key, JSON.stringify(layout));
        window.dispatchEvent(new StorageEvent("storage", { key }));
      }, KEY);
      await sleep(800);
      check(!(await menuButton.isVisible().catch(() => false)), "a phone has no layout menu");
      check((await row.getAttribute("data-tlay")) === null, "a phone's row is never rearranged");
      check((await page.locator(`${root}.cine-row [role="separator"]`).count()) === 0, "a phone has no lines to drag");
      check((await page.locator(`${root}.tlay-slot[data-pane="tab:notes"]`).count()) === 0, "no pane of its own on a phone");
      // Notes is in the phone's bar, or under More when the bar is full.
      const how = await openPanelTab(t, "notes");
      check(how === "direct" || how === "more", "Notes is reachable from the phone's bottom bar");
      await eventually(() => page.locator(`${root}.cine-panel`).locator("visible=true").count(), { label: "the phone's panel opening on Notes" });
      await t.shot("phone");
      await clearLayouts(page);
      return;
    }

    // ---- the table's own arrangement, its widths the reader's ----
    check((await row.getAttribute("data-tlay")) === null, "the table's own arrangement draws the flex row it always had");
    const panel = page.locator(`${root}.cine-panel`).first();
    const panelBefore = (await boxOf(panel)).width;
    check(Math.abs(panelBefore - 384) <= 1, `the side panel opens at 24rem (${panelBefore})`);
    await composer.fill("A draft that outlives every move");
    const panelLine = page.locator(`${root}[role="separator"][aria-label="Resize Side panel"]`).first();
    await eventually(() => panelLine.count(), { label: "the line beside the side panel" });
    await drag(page, panelLine, -120, 0);
    const panelAfter = (await boxOf(panel)).width;
    check(Math.abs(panelAfter - (panelBefore + 120)) <= 4, `dragging the line widens the panel by what it moved (${panelBefore} to ${panelAfter})`);
    await eventually(async () => Math.abs(((await readLayout(page))?.columns?.at(-1)?.width ?? 0) - panelAfter) <= 4, {
      label: "the panel's width saved in this browser",
    });
    check((await row.getAttribute("data-tlay")) === null, "a resize keeps the flex row");

    // ---- the fight stage's scroll ----
    const chronicleLine = page.locator(`${root}[role="separator"][aria-label="Resize the chronicle"]`).first();
    if (viewport === "desktop") {
      await eventually(() => chronicleLine.count(), { label: "the line beside the chronicle" });
      const scroll = page.locator(`${root}.cine-chat-staged > .cine-fight > .cine-chronicle`).first();
      const before = (await boxOf(scroll)).width;
      await drag(page, chronicleLine, 80, 0);
      const after = (await boxOf(scroll)).width;
      check(after > before + 40, `the chronicle widens when its line is dragged (${before} to ${after})`);
      await eventually(async () => (await readLayout(page))?.chronicle > 0, { label: "the chronicle's width saved" });
    }

    // Too far: the table keeps its floor.
    await drag(page, panelLine, -4000, 0, 12);
    const table = page.locator(`${root}.cine-chat`).first();
    check((await boxOf(table)).width >= 355, `the table keeps room for the story (${(await boxOf(table)).width})`);
    check((await composer.inputValue()) === "A draft that outlives every move", "the draft survives resizing");

    // ---- arranging ----
    // The board's picture and the composer are marked, so it can be told
    // afterwards that no move remounted them (a remount is a new element).
    await page.evaluate((prefix) => {
      window.__tlayBoard = document.querySelector(`${prefix}[aria-label^="Board view"] canvas[data-painted-map]`);
      window.__tlayComposer = document.querySelector(`${prefix}[data-tour="composer-input"] textarea`);
    }, root);
    await t.tap(menuButton.first());
    await t.tap(page.getByRole("menuitem", { name: /arrange the table/i }).first());
    await eventually(() => page.locator(`${root}.tlay-arrange`).count(), { label: "the arrange bar" });
    check((await row.getAttribute("data-tlay")) === "custom", "arranging draws each panel in its place");
    if (viewport === "desktop") {
      // Placed, the fight stage keeps its own grid: the scroll beside the board, not above it.
      const scrollBox = await boxOf(page.locator(`${root}.cine-chat-staged > .cine-fight > .cine-chronicle`).first());
      const boardBox = await boxOf(page.locator(`${root}.cine-chat-staged > .cine-fight > .cine-fight-board`).first());
      check(scrollBox.x + scrollBox.width <= boardBox.x + 2, "the staged board stays beside the chronicle while arranging");
    }
    await t.shot("arranging");
    const arrange = page.locator(`${root}.tlay-arrange`).first();
    for (const name of ["Notes", "Story"]) {
      await t.tap(arrange.locator("button").filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).first());
      await sleep(400);
    }
    await eventually(() => slot("tab:notes").isVisible(), { label: "Notes in a pane of its own" });
    await eventually(() => slot("tab:story").isVisible(), { label: "Story in a pane of its own" });
    check(
      (await page.locator(`${root}.cine-rail [data-tour="tab-notes"]`).count()) === 0,
      "a tab with a pane leaves the side panel's rail",
    );
    check((await slot("tab:notes").locator('[data-tour="tab-notes"]').count()) === 1, "the pane's bar answers the tour's Notes step");
    check((await composer.inputValue()) === "A draft that outlives every move", "the draft survives new panes");

    // The keyboard moves a pane: left joins the table's column, right brings it back.
    const notesGrip = page.locator(`${root}button[aria-label="Move Notes"]`).first();
    const notesX = (await boxOf(slot("tab:notes"))).x;
    await notesGrip.focus();
    await page.keyboard.press("ArrowLeft");
    await eventually(async () => (await boxOf(slot("tab:notes"))).x < notesX - 50, { label: "Notes moving left with the arrow key" });
    check(await notesGrip.evaluate((node) => node === document.activeElement), "the grip keeps focus as its pane moves");
    await page.keyboard.press("ArrowRight");
    await eventually(async () => Math.abs((await boxOf(slot("tab:notes"))).x - notesX) < 2, { label: "Notes back with the other arrow" });

    // Dragging a pane by its grip to the far edge opens a column there.
    const rowBox = await boxOf(row);
    const grip = await boxOf(notesGrip);
    await page.mouse.move(grip.x + 30, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + rowBox.width - 6, rowBox.y + rowBox.height / 2, { steps: 10 });
    await sleep(200);
    check((await page.locator(`${root}.tlay-drop`).count()) === 1, "the place it would land shows while it is dragged");
    await page.mouse.up();
    await eventually(async () => {
      const saved = await readLayout(page);
      return saved?.columns?.at(-1)?.panes?.[0]?.id === "tab:notes";
    }, { label: "Notes docked in a new column at the end of the row" });
    const notesBox = await boxOf(slot("tab:notes"));
    check(Math.abs(notesBox.x + notesBox.width - (rowBox.x + rowBox.width)) <= 2, "the new column sits at the row's edge");

    // Floating: in the row, and still whole when the window shrinks.
    await t.tap(page.locator(`${root}button[aria-label="Float Story"]`).first());
    await eventually(() => slot("tab:story").getAttribute("data-floating").then((value) => value !== null), { label: "Story afloat" });
    await drag(page, page.locator(`${root}button[aria-label="Move Story"]`).first(), 2000, 2000, 10);
    const size = page.viewportSize();
    await page.setViewportSize({ width: 1100, height: 700 });
    await sleep(700);
    const inside = async () => {
      const rowNow = await boxOf(row);
      const story = await boxOf(slot("tab:story"));
      return story.x >= rowNow.x - 1 && story.y >= rowNow.y - 1 && story.x + story.width <= rowNow.x + rowNow.width + 1 && story.y + story.height <= rowNow.y + rowNow.height + 1;
    };
    check(await inside(), "a floating pane stays inside the row when the window shrinks");
    check((await boxOf(table)).width >= 355, "the table keeps its floor in a small window");
    await page.setViewportSize(size);
    await sleep(500);
    await t.tap(page.locator(`${root}button[aria-label="Dock Story"]`).first());
    await eventually(() => slot("tab:story").getAttribute("data-floating").then((value) => value === null), { label: "Story docked again" });

    // A pane set aside keeps what was typed in it.
    const noteTitle = slot("tab:notes").locator("input").first();
    await noteTitle.fill("A note half written");
    await t.tap(page.locator(`${root}button[aria-label="Hide Notes"]`).first());
    await eventually(() => slot("tab:notes").evaluate((node) => node.hidden), { label: "Notes set aside" });
    await t.tap(arrange.locator("button").filter({ hasText: /show notes/i }).first());
    await eventually(() => slot("tab:notes").evaluate((node) => !node.hidden), { label: "Notes shown again" });
    check((await noteTitle.inputValue()) === "A note half written", "a pane shown again still holds what was typed in it");
    await noteTitle.fill("");
    check(
      await page.evaluate(() => Boolean(window.__tlayComposer?.isConnected && (!window.__tlayBoard || window.__tlayBoard.isConnected))),
      "the board and the composer are the same elements after every move: nothing was remounted",
    );

    // Done: the arrangement stays, the bar goes.
    await t.tap(arrange.getByRole("button", { name: /^\s*done\s*$/i }).first());
    await eventually(async () => (await page.locator(`${root}.tlay-arrange`).count()) === 0, { label: "the arrange bar closing" });
    check((await row.getAttribute("data-tlay")) === "custom", "the arrangement stays after Done");
    check((await composer.inputValue()) === "A draft that outlives every move", "the draft survives the whole arrangement");
    await t.shot("arranged");

    // ---- kept: the same arrangement after a reload ----
    const saved = await readLayout(page);
    if (t.app) {
      await rereadLayouts(page);
    } else {
      await page.reload({ waitUntil: "networkidle" });
      await sleep(1_500);
    }
    await eventually(() => slot("tab:notes").isVisible(), { timeoutMs: 30_000, label: "Notes' pane after the reload" });
    check(JSON.stringify(await readLayout(page)) === JSON.stringify(saved), "the saved arrangement reads back as itself");
    check((await row.getAttribute("data-tlay")) === "custom", "the arrangement is drawn again after the reload");

    // ---- maximize and hide keep what a pane holds ----
    await composer.fill("Still here after a maximize");
    await t.tap(page.locator(`${root}button[aria-label="Maximize Notes"]`).first());
    await eventually(async () => {
      const notes = await boxOf(slot("tab:notes"));
      const rowNow = await boxOf(row);
      return Math.abs(notes.width - rowNow.width) <= 2 && Math.abs(notes.height - rowNow.height) <= 2;
    }, { label: "Notes filling the row" });
    check(await slot("table").evaluate((node) => node.hidden), "the table is out of sight, not gone");
    await page.keyboard.press("Escape");
    await eventually(() => slot("table").evaluate((node) => !node.hidden), { label: "Escape restoring the arrangement" });
    check((await composer.inputValue()) === "Still here after a maximize", "the draft survives a maximize");
    await t.tap(page.locator(`${root}button[aria-label="Hide Notes"]`).first());
    await eventually(() => slot("tab:notes").evaluate((node) => node.hidden), { label: "Notes hidden" });

    // ---- lock, then reset ----
    await t.tap(menuButton.first());
    await t.tap(page.getByRole("menuitemcheckbox", { name: /lock layout/i }).first());
    await sleep(400);
    check((await page.locator(`${root}.cine-row [role="separator"]`).count()) === 0, "a locked arrangement has no lines to drag");
    check((await page.locator(`${root}button[aria-label="Move Notes"], ${root}button[aria-label="Hide Story"]`).count()) === 0, "nor anything that moves or hides a pane");
    await t.tap(menuButton.first());
    check((await page.getByRole("menuitem", { name: /arrange the table/i }).count()) === 0, "locked, the menu offers no arranging");
    await t.tap(page.getByRole("menuitemcheckbox", { name: /lock layout/i }).first());
    await sleep(300);
    await t.tap(menuButton.first());
    await t.tap(page.getByRole("menuitem", { name: /reset layout/i }).first());
    await eventually(async () => (await row.getAttribute("data-tlay")) === null, { label: "Reset bringing back the flex row" });
    check((await page.locator(`${root}.tlay-slot[data-pane^="tab:"]`).count()) === 0, "Reset puts every tab back in the rail");
    check((await page.locator(`${root}.cine-rail [data-tour="tab-notes"]`).count()) === 1, "Notes is back in the rail");
    check(Math.abs((await boxOf(panel)).width - 384) <= 1, "the side panel is at 24rem again");
    check((await composer.inputValue()) === "Still here after a maximize", "the draft survives Reset");
    await composer.fill("");

    // Nothing of it ever left the browser.
    check(layoutCalls.length === 0, `the arrangement never reaches the server (${layoutCalls.join(", ")})`);
    await clearLayouts(page);
  },
};
