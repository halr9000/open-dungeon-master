// What the daily tidy clears and what it must never touch (audit P13,
// src/lib/ops/retention.ts): the story stays, the event log keeps its
// replay window and every "latest of a kind" read, usage totals come out the
// same after old rows merge, freed pages go back to the disk, and only files
// no row names (past a day's grace) are offered for removal.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-retention-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.chdir(dir);
register("./lib/register-routes.mjs", import.meta.url);

const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign } = await import("../src/lib/db/campaigns.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { getDatabase } = await import("../src/lib/db/core.ts");
const { REPLAY_GAP_LIMIT, latestEventOfType, planReplay } = await import("../src/lib/events.ts");
const { usageOverview } = await import("../src/lib/usage/ledger.ts");
const { recordMediaFile } = await import("../src/lib/media-access.ts");
const { removeUnreferencedFiles } = await import("../src/lib/image-files.ts");
const retention = await import("../src/lib/ops/retention.ts");
const storageRoute = await import("../src/app/api/admin/storage/route.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const DAY = 86_400_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const db = getDatabase();
const settings = { description: "", theme: "", maxPlayers: 4, startingLevel: 1, difficulty: "normal" };
const dm = createUser("dm", "x");
const admin = createUser("admin", "x", { isAdmin: true });
const table = createCampaign(dm.id, { title: "Table", ...settings });

await test("a new database hands freed pages back by itself", () => {
  assert.equal(Object.values(db.prepare("PRAGMA auto_vacuum").get())[0], 2);
});

await test("the event log keeps its replay window and every latest-of-a-kind read", async () => {
  const total = REPLAY_GAP_LIMIT + 800;
  const old = iso(now - 40 * DAY);
  const insert = db.prepare(`INSERT INTO campaign_events (campaign_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`);
  const floor = (mode) => JSON.stringify({ floor: { mode, userIds: [], prompt: "" } });
  db.transaction(() => {
    for (let seq = 1; seq <= total; seq += 1) {
      if (seq === 5) insert.run(table.id, seq, "handout_shown", JSON.stringify({ id: "h1" }), old);
      else if (seq === 20) insert.run(table.id, seq, "floor_changed", floor("hold"), old);
      else if (seq === 400) insert.run(table.id, seq, "title_card", JSON.stringify({ title: "Chapter Two" }), old);
      else if (seq === 450) insert.run(table.id, seq, "title_card", JSON.stringify({ title: "Before the boundary" }), old);
      else if (seq % 3 === 0) insert.run(table.id, seq, "floor_changed", floor("open"), old);
      else insert.run(table.id, seq, "message_created", "{}", old);
    }
  })();
  db.prepare(`UPDATE campaigns SET next_seq = ? WHERE id = ?`).run(total + 1, table.id);
  db.prepare(
    `INSERT INTO chapter_snapshots (id, campaign_id, chapter_index, boundary_seq, kind, snapshot_json, created_at) VALUES (?, ?, 1, 500, 'boundary', '{}', ?)`,
  ).run(randomUUID(), table.id, old);
  const latestBefore = ["handout_shown", "title_card", "floor_changed", "message_created"].map((type) => latestEventOfType(table.id, [type]));
  const windowBefore = db.prepare(`SELECT COUNT(*) AS n FROM campaign_events WHERE campaign_id = ? AND seq > ?`).get(table.id, total - REPLAY_GAP_LIMIT).n;

  const removed = await retention.pruneEventLog(now);
  assert.ok(removed > 0, "old events past the window go");
  const has = (seq) => Boolean(db.prepare(`SELECT 1 FROM campaign_events WHERE campaign_id = ? AND seq = ?`).get(table.id, seq));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM campaign_events WHERE campaign_id = ? AND seq > ?`).get(table.id, total - REPLAY_GAP_LIMIT).n, windowBefore);
  assert.equal(planReplay(String(total - REPLAY_GAP_LIMIT), total).kind, "replay", "a page inside the window still replays");
  assert.deepEqual(
    ["handout_shown", "title_card", "floor_changed", "message_created"].map((type) => latestEventOfType(table.id, [type])),
    latestBefore,
  );
  assert.ok(has(5), "the only handout event stays: the table still knows what is on show");
  assert.ok(has(20), "the last held floor stays: the agents' opportunity ids do not move");
  assert.ok(has(400) && has(450), "the newest hundred of each kind stay");
  assert.ok(has(500), "the newest of each kind at a chapter boundary stays for a rewind");
  assert.ok(!has(499), "an older one before the same boundary goes");
  const floors = db.prepare(`SELECT COUNT(*) AS n FROM campaign_events WHERE campaign_id = ? AND type = 'floor_changed'`).get(table.id).n;
  assert.ok(floors >= 100, "the agents' spotlight walk still has its hundred floor events");
});

await test("recent events stay even past the replay window", async () => {
  const other = createCampaign(dm.id, { title: "Busy", ...settings });
  const insert = db.prepare(`INSERT INTO campaign_events (campaign_id, seq, type, payload_json, created_at) VALUES (?, ?, 'message_created', '{}', ?)`);
  db.transaction(() => {
    for (let seq = 1; seq <= REPLAY_GAP_LIMIT + 300; seq += 1) insert.run(other.id, seq, iso(now - DAY));
  })();
  db.prepare(`UPDATE campaigns SET next_seq = ? WHERE id = ?`).run(REPLAY_GAP_LIMIT + 301, other.id);
  await retention.pruneEventLog(now);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM campaign_events WHERE campaign_id = ?`).get(other.id).n, REPLAY_GAP_LIMIT + 300);
});

await test("old prompt traces go, the conversation re-narrate needs stays", () => {
  const insert = db.prepare(
    `INSERT INTO dm_turns (id, campaign_id, status, conversation_json, context_trace_json, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?, ?)`,
  );
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    const id = randomUUID();
    ids.push(id);
    const at = iso(now - (30 - index) * DAY);
    insert.run(id, table.id, JSON.stringify([{ role: "user", content: `turn ${index}` }]), JSON.stringify({ blocks: [index] }), at, at);
  }
  const cleared = retention.clearOldContextTraces(now);
  assert.equal(cleared, 3, "the five newest traces per campaign stay");
  const rows = ids.map((id) => db.prepare(`SELECT conversation_json, context_trace_json FROM dm_turns WHERE id = ?`).get(id));
  assert.deepEqual(rows.map((row) => row.context_trace_json === null), [true, true, true, false, false, false, false, false]);
  assert.ok(rows.every((row) => row.conversation_json.includes("turn")), "every conversation is kept");
});

await test("old usage rows merge by month and the ledger reads the same totals", async () => {
  const insert = db.prepare(
    `INSERT INTO usage_events (at, campaign_id, user_id, kind, role, backend, model, paid, input_tokens, output_tokens, units, duration_ms)
     VALUES (?, ?, ?, ?, 'story', 'local', 'qwen', ?, ?, ?, ?, 10)`,
  );
  for (let index = 0; index < 40; index += 1) {
    const at = iso(now - (100 + index * 2) * DAY);
    insert.run(at, table.id, dm.id, index % 4 === 0 ? "agent" : "text", index % 2, 100 + index, 50, 0);
    insert.run(at, null, dm.id, "image", 0, 0, 0, 1);
  }
  insert.run(iso(now - DAY), table.id, dm.id, "text", 1, 7, 3, 0);
  const strip = ({ campaigns, accounts }) => JSON.stringify({ campaigns, accounts });
  const before = strip(usageOverview());
  const rowsBefore = db.prepare(`SELECT COUNT(*) AS n FROM usage_events`).get().n;
  const folded = await retention.rollUpUsage(now);
  const rowsAfter = db.prepare(`SELECT COUNT(*) AS n FROM usage_events`).get().n;
  assert.ok(folded > 0);
  assert.equal(rowsBefore - rowsAfter, folded);
  assert.equal(strip(usageOverview()), before, "calls, tokens, pictures, agent turns and last use are unchanged");
  assert.equal(await retention.rollUpUsage(now), 0, "a second pass finds nothing left to merge");
});

await test("freed pages go back to the disk", async () => {
  db.exec(`CREATE TABLE ballast (body BLOB)`);
  const insert = db.prepare(`INSERT INTO ballast (body) VALUES (?)`);
  for (let index = 0; index < 200; index += 1) insert.run(randomBytes(16 * 1024));
  db.exec(`DROP TABLE ballast`);
  const free = Object.values(db.prepare("PRAGMA freelist_count").get())[0];
  assert.ok(free > 0);
  const reclaimed = await retention.reclaimSpace();
  assert.ok(reclaimed > 0);
  assert.equal(Object.values(db.prepare("PRAGMA freelist_count").get())[0], 0);
});

await test("compacting an older database switches it to daily returns", async () => {
  db.exec("PRAGMA auto_vacuum = NONE");
  db.exec("VACUUM");
  assert.equal(Object.values(db.prepare("PRAGMA auto_vacuum").get())[0], 0);
  const { before, after } = await retention.compactDatabase();
  assert.ok(before > 0 && after > 0);
  assert.equal(Object.values(db.prepare("PRAGMA auto_vacuum").get())[0], 2);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM campaign_events`).get().n > 0, "nothing is lost");
});

await test("only files no row names, past a day's grace, are offered and removed", async () => {
  const uploads = path.join(dir, "public", "uploads");
  const audio = path.join(dir, "public", "generated-audio");
  fs.mkdirSync(uploads, { recursive: true });
  const put = (file, ageMs) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x".repeat(100));
    const at = new Date(now - ageMs);
    fs.utimesSync(file, at, at);
  };
  const named = randomUUID();
  const prose = randomUUID();
  const lost = randomUUID();
  const fresh = randomUUID();
  const madeOnly = randomUUID();
  for (const stem of [named, prose, lost, madeOnly]) put(path.join(uploads, `${stem}.png`), 3 * DAY);
  put(path.join(uploads, `${lost}.w256.webp`), 3 * DAY);
  put(path.join(uploads, `${fresh}.png`), 60_000);
  put(path.join(uploads, "notes.txt"), 3 * DAY);
  db.prepare(`UPDATE campaigns SET dm_cover_json = ? WHERE id = ?`).run(JSON.stringify({ url: `/uploads/${named}.png` }), table.id);
  db.prepare(`UPDATE campaigns SET description = ? WHERE id = ?`).run(`See https://example.test/uploads/${prose}.png.`, table.id);
  recordMediaFile(`/uploads/${madeOnly}.png`, { userId: dm.id });

  const message = randomUUID();
  db.prepare(`INSERT INTO campaign_messages (id, campaign_id, seq, author_type, content, created_at) VALUES (?, ?, 99999, 'dm', 'Hello', ?)`).run(message, table.id, iso(now));
  put(path.join(audio, table.id, `${message}.mp3`), 3 * DAY);
  put(path.join(audio, table.id, `${randomUUID()}.mp3`), 3 * DAY);
  put(path.join(audio, randomUUID(), `${randomUUID()}.mp3`), 3 * DAY);
  put(path.join(audio, "previews", "voice.mp3"), 30 * DAY);

  const scan = await retention.scanOrphanFiles(now);
  assert.deepEqual(scan.pictures.map((file) => file.url).sort(), [`/uploads/${lost}.png`, `/uploads/${madeOnly}.png`].sort());
  assert.equal(scan.pictures.find((file) => file.url.includes(lost)).files.length, 2, "the WebP copy goes with its original");
  assert.equal(scan.audio.length, 2, "a clip whose message is gone, and a folder whose campaign is gone");

  await retention.removeOrphanFiles(now);
  const exists = (stem, ext = "png") => fs.existsSync(path.join(uploads, `${stem}.${ext}`));
  assert.ok(exists(named) && exists(prose) && exists(fresh), "named, mentioned and fresh files stay");
  assert.ok(!exists(lost) && !exists(lost, "w256.webp") && !exists(madeOnly));
  assert.ok(fs.existsSync(path.join(uploads, "notes.txt")), "a name the server never writes is never touched");
  assert.ok(fs.existsSync(path.join(audio, table.id, `${message}.mp3`)));
  assert.ok(fs.existsSync(path.join(audio, "previews", "voice.mp3")), "the voice preview cache is left alone");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM media_files WHERE path = ?`).get(`/uploads/${madeOnly}.png`).n, 0);
  assert.equal((await retention.scanOrphanFiles(now)).pictures.length + (await retention.scanOrphanFiles(now)).audio.length, 0);
});

await test("a file only its maker's record names is still removed with its campaign", () => {
  const url = `/uploads/${randomUUID()}.png`;
  fs.writeFileSync(path.join(dir, "public", url), "x");
  recordMediaFile(url, { campaignId: table.id });
  assert.deepEqual(removeUnreferencedFiles([url]), [url]);
});

await test("the daily pass waits for the server to settle, then runs once a day, never twice at once", async () => {
  retention.retentionDue(now);
  const state = globalThis.__odmRetention;
  state.startedAt = now;
  state.lastAt = 0;
  assert.equal(retention.retentionDue(now + 60_000), false);
  assert.equal(retention.retentionDue(now + 11 * 60_000), true);
  const first = retention.runRetention(now);
  assert.equal(retention.runRetention(now), first);
  assert.equal(retention.retentionDue(now), false, "not while it runs");
  const report = await first;
  assert.equal(typeof report.eventsRemoved, "number");
  assert.equal(retention.retentionDue(now + DAY - 1), false);
  assert.equal(retention.retentionDue(now + DAY), true);
});

await test("the storage route is the admin's", async () => {
  globalThis.__odmTestToken = mintSession(dm.id).token;
  assert.equal((await storageRoute.GET()).status, 403);
  globalThis.__odmTestToken = mintSession(admin.id).token;
  const response = await storageRoute.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stats.incremental, true);
  assert.equal(typeof body.orphans.bytes, "number");
  const tidy = await storageRoute.POST(new Request("http://x/api/admin/storage", { method: "POST", body: JSON.stringify({ action: "tidy" }) }));
  assert.equal(tidy.status, 200);
  assert.ok((await tidy.json()).report.at);
  const unknown = await storageRoute.POST(new Request("http://x/api/admin/storage", { method: "POST", body: JSON.stringify({ action: "drop" }) }));
  assert.equal(unknown.status, 400);
});

removeTempDir(dir);
console.log(`\n${passed} retention checks passed.`);
