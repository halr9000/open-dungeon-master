// Issue 306: a finished tour belongs to the account, not to the browser.
// Drives GET and POST /api/profile/tours on a real database, then the
// page-side store (src/lib/tours/tour-store.ts) against those handlers with
// a stand-in window per device: the same account on a second device, a
// second account on the same device, cleared storage, a save that fails and
// is sent again, another tab's finish, the old per-browser flags, and a
// server from before the record.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-tour-account-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.chdir(dir);
register("./lib/register-routes.mjs", import.meta.url);

const { createUser, getUserSettings } = await import("../src/lib/db/users.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const toursRoute = await import("../src/app/api/profile/tours/route.ts");
const profileRoute = await import("../src/app/api/profile/route.ts");
const { deviceKey, legacyKey } = await import("../src/lib/tours/account-logic.ts");
const { HAND_TUTORIAL_ID } = await import("../src/lib/tours/registry.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const ada = createUser("tour-ada", "x");
const bo = createUser("tour-bo", "x");
const tokens = { [ada.id]: mintSession(ada.id).token, [bo.id]: mintSession(bo.id).token };
const as = (user) => {
  globalThis.__odmTestToken = user ? tokens[user.id] : undefined;
};
const post = (body) =>
  toursRoute.POST(new Request("http://odm.test/api/profile/tours", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

await test("the route answers the account and records finishes tour by tour", async () => {
  as(null);
  assert.equal((await toursRoute.GET()).status, 401, "signed out is refused");
  as(ada);
  const empty = await (await toursRoute.GET()).json();
  assert.deepEqual(empty, { userId: ada.id, tours: {} });
  const first = await (await post({ finished: [{ id: "table-player", version: 1, how: "ended" }] })).json();
  assert.equal(first.tours["table-player"].how, "ended");
  assert.ok(first.tours["table-player"].at, "the server stamps the time");
  // Another device finishes a different tour: both stand.
  const second = await (await post({ finished: [{ id: "workshop-shelf", version: 1, how: "done" }] })).json();
  assert.deepEqual(Object.keys(second.tours).sort(), ["table-player", "workshop-shelf"]);
  // A page on an older version cannot lower a newer record.
  await post({ finished: [{ id: "table-dm", version: 3, how: "done" }] });
  const lowered = await (await post({ finished: [{ id: "table-dm", version: 1, how: "ended" }] })).json();
  assert.equal(lowered.tours["table-dm"].version, 3);
  as(bo);
  assert.deepEqual((await (await toursRoute.GET()).json()).tours, {}, "another account has its own record");
});

await test("the route names an id it has no tour for and refuses a malformed body", async () => {
  as(ada);
  const mixed = await (await post({ finished: [{ id: "tomorrows-tour", version: 1, how: "done" }, { id: "workshop-hub", version: 1, how: "done" }] })).json();
  assert.deepEqual(mixed.ignored, ["tomorrows-tour"]);
  assert.ok(mixed.tours["workshop-hub"]);
  assert.ok(!("tomorrows-tour" in mixed.tours));
  for (const body of [{}, { finished: [] }, { finished: [{ id: "table-player", version: 0, how: "done" }] }, { finished: [{ id: "table-player", version: 1, how: "skipped" }] }, { finished: "table-player" }]) {
    assert.equal((await post(body)).status, 400, `refused: ${JSON.stringify(body)}`);
  }
  const tooMany = Array.from({ length: 65 }, () => ({ id: "table-player", version: 1, how: "done" }));
  assert.equal((await post({ finished: tooMany })).status, 400);
});

await test("a profile settings save leaves the tours alone", async () => {
  as(ada);
  const before = getUserSettings(ada.id).tours;
  const patched = await profileRoute.PATCH(
    new Request("http://odm.test/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { chimeMuted: true, tours: {} } }) }),
  );
  assert.equal(patched.status, 200);
  assert.deepEqual(getUserSettings(ada.id).tours, before, "the PATCH neither takes nor erases the record");
  assert.equal(getUserSettings(ada.id).chimeMuted, true);
});

// ---- the page's store, one stand-in window per device ----

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const net = { offline: false, legacyServer: false, calls: [] };
let signedIn = null;
globalThis.fetch = async (url, init = {}) => {
  net.calls.push(`${init.method ?? "GET"} ${url}`);
  if (net.offline) {
    throw new TypeError("fetch failed");
  }
  if (net.legacyServer) {
    return new Response("Not found", { status: 404 });
  }
  as(signedIn);
  const request = new Request(`http://odm.test${url}`, init);
  return init.method === "POST" ? toursRoute.POST(request) : toursRoute.GET(request);
};

// A device is a window with its own storage; each page load is a fresh copy
// of the store module, as a reload or another app launch would be.
function device() {
  const target = new EventTarget();
  return { target, localStorage: new MemoryStorage() };
}
let loads = 0;
async function load(on, user) {
  signedIn = user;
  globalThis.window = Object.assign(on.target, { localStorage: on.localStorage });
  loads += 1;
  // A fresh copy per load; Vite would refuse a template specifier here.
  const url = `${new URL("../src/lib/tours/tour-store.ts", import.meta.url).href}?load=${loads}`;
  const store = await import(/* @vite-ignore */ url);
  store.refreshTours();
  return store;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(fn, label) {
  for (let index = 0; index < 400; index += 1) {
    if (fn()) return;
    await tick();
  }
  throw new Error(`${label} did not happen`);
}
const known = (store, id) => until(() => store.tourFinished(id) !== null, `the account's answer for ${id}`);

const laptop = device();
const phone = device();

await test("nothing opens by itself before the account answers; then a new tour reads unfinished", async () => {
  const carla = createUser("tour-carla", "x");
  tokens[carla.id] = mintSession(carla.id).token;
  const page = await load(laptop, carla);
  assert.equal(page.tourFinished("table-player"), null, "unknown while the read is in flight");
  await known(page, "table-player");
  assert.equal(page.tourFinished("table-player"), false);
  page.finishTour("table-player", "done");
  assert.equal(page.tourFinished("table-player"), true, "this page knows at once");
  await until(() => getUserSettings(carla.id).tours?.["table-player"], "the account to record it");

  // The same account on another device, and this device after its storage
  // was cleared: the account is the source of truth for both.
  const other = await load(phone, carla);
  await known(other, "table-player");
  assert.equal(other.tourFinished("table-player"), true, "the phone does not open it again");
  laptop.localStorage.clear();
  const reloaded = await load(laptop, carla);
  await known(reloaded, "table-player");
  assert.equal(reloaded.tourFinished("table-player"), true, "cleared storage does not bring it back");
  assert.equal(reloaded.tourFinished("table-dm"), false, "a tour never finished still opens");
});

await test("a second account on the same device gets its own first tours", async () => {
  const dee = createUser("tour-dee", "x");
  tokens[dee.id] = mintSession(dee.id).token;
  const page = await load(laptop, dee);
  await known(page, "table-player");
  assert.equal(page.tourFinished("table-player"), false);
  assert.equal(page.tourFinished(HAND_TUTORIAL_ID), false);
});

await test("a finish the account could not take stays closed here and is sent again", async () => {
  const eli = createUser("tour-eli", "x");
  tokens[eli.id] = mintSession(eli.id).token;
  const page = await load(laptop, eli);
  await known(page, "workshop-hub");
  net.offline = true;
  page.finishTour("workshop-hub", "ended");
  await tick();
  assert.equal(page.tourFinished("workshop-hub"), true, "closed on this device while the save fails");
  const kept = JSON.parse(laptop.localStorage.getItem(deviceKey(eli.id)));
  assert.ok(kept.pending["workshop-hub"], "kept as pending on the device");
  assert.equal(getUserSettings(eli.id).tours?.["workshop-hub"], undefined);
  // A reload while still offline: the account cannot answer, so nothing
  // opens by itself, and the device still holds the finish.
  const offlinePage = await load(laptop, eli);
  await until(() => net.calls.at(-1)?.startsWith("GET"), "the read to be tried");
  await tick();
  assert.equal(offlinePage.tourFinished("workshop-hub"), null, "no answer, no tour");
  net.offline = false;
  laptop.target.dispatchEvent(new Event("online"));
  await until(() => getUserSettings(eli.id).tours?.["workshop-hub"], "the pending finish to reach the account");
  await until(() => !JSON.parse(laptop.localStorage.getItem(deviceKey(eli.id))).pending["workshop-hub"], "the device to drop it from pending");
  assert.equal(JSON.parse(laptop.localStorage.getItem(deviceKey(eli.id))).done["workshop-hub"].how, "ended");
});

await test("another tab's finish reaches a tab that read the account before it", async () => {
  const fay = createUser("tour-fay", "x");
  tokens[fay.id] = mintSession(fay.id).token;
  const tab = device();
  const first = await load(tab, fay);
  await known(first, "workshop-shelf");
  assert.equal(first.tourFinished("workshop-shelf"), false);
  // The second tab shares the storage; its finish is written there.
  const second = await load(tab, fay);
  await known(second, "workshop-shelf");
  second.finishTour("workshop-shelf", "done");
  assert.equal(first.tourFinished("workshop-shelf"), false, "the first tab has not heard yet");
  const event = new Event("storage");
  event.key = deviceKey(fay.id);
  tab.target.dispatchEvent(event);
  assert.equal(first.tourFinished("workshop-shelf"), true, "the storage event brings it over");
});

await test("the old per-browser flags move to the first account that loads, and only that one", async () => {
  const gus = createUser("tour-gus", "x");
  const hal = createUser("tour-hal", "x");
  tokens[gus.id] = mintSession(gus.id).token;
  tokens[hal.id] = mintSession(hal.id).token;
  const shared = device();
  shared.localStorage.setItem(legacyKey("table-player"), "done");
  shared.localStorage.setItem(legacyKey("app"), "done");
  const page = await load(shared, gus);
  await known(page, "table-player");
  assert.equal(page.tourFinished("table-player"), true, "the flag counts for the account that found it");
  await until(() => getUserSettings(gus.id).tours?.["table-player"], "the flag to reach the account");
  assert.equal(shared.localStorage.getItem(legacyKey("table-player")), null);
  assert.equal(shared.localStorage.getItem(legacyKey("app")), "done", "the app shell's own flag stays");
  const next = await load(shared, hal);
  await known(next, "table-player");
  assert.equal(next.tourFinished("table-player"), false, "the next account on the device meets the tour");
});

await test("a server from before the record keeps the old per-browser flag", async () => {
  net.legacyServer = true;
  const old = device();
  const page = await load(old, ada);
  await known(page, "table-dm");
  assert.equal(page.tourFinished("table-dm"), false);
  page.finishTour("table-dm", "done");
  assert.equal(old.localStorage.getItem(legacyKey("table-dm")), "done");
  assert.equal(page.tourFinished("table-dm"), true);
  net.legacyServer = false;
});

// The last read's own bookkeeping settles a few microtasks after its answer.
await new Promise((resolve) => setTimeout(resolve, 50));
delete globalThis.window;
removeTempDir(dir);
console.log(`test-tour-account: ${passed} passed`);
