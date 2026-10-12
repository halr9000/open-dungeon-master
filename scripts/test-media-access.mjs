// Who may open a stored picture or document (audit S6, src/lib/media-access.ts):
// the members of every place that holds it, whoever just made it, every
// account for avatars and covers, the owner for their own library, and the
// administrator. Anyone else hears 404, as for a file that does not exist.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-media-access-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.chdir(dir);
register("./lib/register-routes.mjs", import.meta.url);

const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign, joinByInviteCode } = await import("../src/lib/db/campaigns.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { getDatabase } = await import("../src/lib/db/core.ts");
const { mayReadMedia, recordMediaFile } = await import("../src/lib/media-access.ts");
const { currentUsageScope, enterUsageScope, fillUsageScope, openUsageScope, runInUsageScope } = await import(
  "../src/lib/usage/scope.ts"
);
const { AsyncLocalStorage } = await import("node:async_hooks");
const uploadsRoute = await import("../src/app/uploads/[...path]/route.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const db = getDatabase();
const upload = () => `/uploads/${randomUUID()}.png`;
const settings = { description: "", theme: "", maxPlayers: 4, startingLevel: 1, difficulty: "normal" };

const dm = createUser("dm", "x");
const player = createUser("player", "x");
const outsider = createUser("outsider", "x");
const stranger = createUser("stranger", "x");
const admin = createUser("admin", "x", { isAdmin: true });
const reader = (user, isAdmin = false) => ({ id: user.id, isAdmin });

const table = createCampaign(dm.id, { title: "Table", ...settings });
joinByInviteCode(player.id, table.inviteCode);
const other = createCampaign(outsider.id, { title: "Other", ...settings });

const art = (campaignId, url) =>
  db.prepare(`UPDATE campaigns SET dm_cover_json = ? WHERE id = ?`).run(JSON.stringify({ url }), campaignId);

await test("a campaign's picture is for its members, not for other accounts", () => {
  const url = upload();
  art(table.id, url);
  assert.equal(mayReadMedia(reader(dm), url), true);
  assert.equal(mayReadMedia(reader(player), url), true);
  assert.equal(mayReadMedia(reader(outsider), url), false);
  assert.equal(mayReadMedia(reader(admin, true), url), true, "the administrator opens anything");
});

await test("a copy shared by reference is open to the members of each place that holds it", () => {
  const url = upload();
  art(table.id, url);
  art(other.id, url);
  assert.equal(mayReadMedia(reader(outsider), url), true, "the clone's owner");
  assert.equal(mayReadMedia(reader(player), url), true, "the original's member");
  assert.equal(mayReadMedia(reader(stranger), url), false);
});

await test("avatars and campaign covers are open to every account", () => {
  const avatar = upload();
  const cover = upload();
  db.prepare(`UPDATE users SET avatar_json = ? WHERE id = ?`).run(JSON.stringify({ url: avatar }), dm.id);
  db.prepare(`UPDATE campaigns SET cover_json = ? WHERE id = ?`).run(JSON.stringify({ url: cover }), table.id);
  assert.equal(mayReadMedia(reader(stranger), avatar), true);
  assert.equal(mayReadMedia(reader(stranger), cover), true);
});

await test("an account's own settings and library are its own", () => {
  const url = upload();
  db.prepare(`UPDATE users SET settings_json = ? WHERE id = ?`).run(JSON.stringify({ dice: url }), player.id);
  assert.equal(mayReadMedia(reader(player), url), true);
  assert.equal(mayReadMedia(reader(dm), url), false);
});

await test("a file just made is its maker's, and its campaign's, before any row names it", () => {
  const mine = upload();
  recordMediaFile(mine, { userId: outsider.id });
  assert.equal(mayReadMedia(reader(outsider), mine), true, "the uploader previews it");
  assert.equal(mayReadMedia(reader(player), mine), false);
  const painted = "/generated/1700000000000-comfy-scene.png";
  runInUsageScope({ campaignId: table.id, userId: dm.id }, () => recordMediaFile(painted));
  assert.equal(mayReadMedia(reader(player), painted), true, "a picture painted for the table");
  assert.equal(mayReadMedia(reader(outsider), painted), false);
});

await test("a picture named after the sets were read is open at once", () => {
  const first = upload();
  art(table.id, first);
  assert.equal(mayReadMedia(reader(player), first), true);
  const second = upload();
  // A write that names a stored file (src/lib/db/driver.ts) marks the sets stale.
  db.prepare(`UPDATE campaigns SET dm_cover_json = ? WHERE id = ?`).run(JSON.stringify({ url: second }), table.id);
  assert.equal(mayReadMedia(reader(player), second), true);
});

await test("a member who leaves loses the table's pictures", () => {
  const url = upload();
  art(table.id, url);
  assert.equal(mayReadMedia(reader(player), url), true);
  db.prepare(`DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?`).run(table.id, player.id);
  assert.equal(mayReadMedia(reader(player), url), false);
  joinByInviteCode(player.id, table.inviteCode);
});

await test("paths that are not stored files are never served", () => {
  assert.equal(mayReadMedia(reader(admin, true), "/uploads/../secrets.txt"), false);
  assert.equal(mayReadMedia(reader(admin, true), "/assets/icons/x.png"), false);
});

await test("the route answers an outsider 404 and a member the file", async () => {
  const name = `${randomUUID()}.png`;
  fs.mkdirSync(path.join(dir, "public", "uploads"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "uploads", name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  art(table.id, `/uploads/${name}`);
  const ask = async (user) => {
    globalThis.__odmTestToken = mintSession(user.id).token;
    const response = await uploadsRoute.GET(new Request(`http://x/uploads/${name}`), {
      params: Promise.resolve({ path: [name] }),
    });
    await response.body?.cancel();
    return response.status;
  };
  assert.equal(await ask(player), 200);
  assert.equal(await ask(outsider), 404);
});

await test("who a request is for reaches the route, wherever the helper that learned it resumed", async () => {
  // A context with no scope, like the snapshots Next resumes parts of a
  // request in: currentUser learns the account after awaiting the cookie.
  const elsewhere = AsyncLocalStorage.snapshot();
  const later = () => new Promise((resolve) => setTimeout(resolve, 1));
  async function helper(scope = openUsageScope()) {
    await later();
    elsewhere(() => fillUsageScope(scope, { userId: "maker" }));
  }
  assert.equal(await runInUsageScope({}, async () => (await helper(), currentUsageScope().userId)), "maker");
  // What it replaced: entered from the other context, it never reached the route.
  async function entered() {
    await later();
    elsewhere(() => enterUsageScope({ userId: "lost" }));
  }
  const before = currentUsageScope().userId;
  assert.equal(await runInUsageScope({}, async () => (await entered(), currentUsageScope().userId)), before);
});

removeTempDir(dir);
console.log(`\n${passed} media access checks passed.`);
