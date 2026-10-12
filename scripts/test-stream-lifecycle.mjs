// Live streams end when what they hang on ends (audit S2), and catch up
// within bounds (audit P8): a stream opened with a session stops at once
// when that session is signed out, when the account changes its password
// elsewhere or is deleted, and when the campaign is deleted; a reader too
// far behind, or with no real cursor, is told to resync instead of being
// handed the whole history; a reader that stops reading is let go.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stream-lifecycle-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.chdir(dir);
register("./lib/register-routes.mjs", import.meta.url);

const { createUser, deleteSessionsForUser, sessionHolder, pruneExpiredSessions, insertSession } = await import(
  "../src/lib/db/users.ts"
);
const { createCampaign, deleteCampaign, joinByInviteCode } = await import("../src/lib/db/campaigns.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { publishEphemeral, publishPersisted, REPLAY_GAP_LIMIT, planReplay } = await import("../src/lib/events.ts");
const { openStreamCount, STREAMS_PER_USER } = await import("../src/lib/live-streams.ts");
const { getDatabase } = await import("../src/lib/db/core.ts");
const events = await import("../src/app/api/campaigns/[campaignId]/events/route.ts");
const bell = await import("../src/app/api/notifications/stream/route.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const dm = createUser("dm", "x");
const player = createUser("player", "x");
const campaign = createCampaign(dm.id, {
  title: "T",
  description: "",
  theme: "",
  maxPlayers: 4,
  startingLevel: 1,
  difficulty: "normal",
});
joinByInviteCode(player.id, campaign.inviteCode);

// Opens the campaign stream as `token` and reads it in the background.
async function open(token, campaignId = campaign.id, query = "") {
  globalThis.__odmTestToken = token;
  const controller = new AbortController();
  const response = await events.GET(
    new Request(`http://x/api/campaigns/${campaignId}/events${query}`, { signal: controller.signal }),
    { params: Promise.resolve({ campaignId }) },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { text: "", done: false };
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        state.done = true;
        return;
      }
      state.text += decoder.decode(value);
    }
  })();
  await tick();
  return { state, abort: () => controller.abort() };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await tick();
  }
}

await test("signing the account out everywhere ends a stream it already had open", async () => {
  const { token } = mintSession(player.id);
  const stream = await open(token, campaign.id, "?lastSeq=0");
  publishEphemeral(campaign.id, "dm_status", { status: "thinking" });
  await settle();
  assert.match(stream.state.text, /event: dm_status/);
  deleteSessionsForUser(player.id);
  await settle();
  assert.equal(stream.state.done, true, "the stream is closed");
  const before = stream.state.text.length;
  publishEphemeral(campaign.id, "dm_status", { status: "narrating" });
  await settle();
  assert.equal(stream.state.text.length, before, "nothing more is delivered");
  assert.equal(sessionHolder(token), null);
});

await test("a password change elsewhere keeps the session that made it", async () => {
  const kept = mintSession(player.id).token;
  const other = mintSession(player.id).token;
  const keptStream = await open(kept, campaign.id, "?lastSeq=0");
  const otherStream = await open(other, campaign.id, "?lastSeq=0");
  const { createHash } = await import("node:crypto");
  deleteSessionsForUser(player.id, createHash("sha256").update(kept).digest("hex"));
  await settle();
  assert.equal(otherStream.state.done, true);
  assert.equal(keptStream.state.done, false);
  keptStream.abort();
});

await test("the bell's stream ends with its session too", async () => {
  const { token } = mintSession(player.id);
  globalThis.__odmTestToken = token;
  const response = await bell.GET(new Request("http://x/api/notifications/stream"));
  const reader = response.body.getReader();
  let done = false;
  void reader.read().then(function next(result) {
    if (result.done) {
      done = true;
      return;
    }
    return reader.read().then(next);
  });
  deleteSessionsForUser(player.id);
  await settle();
  assert.equal(done, true);
});

await test("deleting the campaign ends every stream reading it", async () => {
  const doomed = createCampaign(dm.id, {
    title: "Doomed",
    description: "",
    theme: "",
    maxPlayers: 4,
    startingLevel: 1,
    difficulty: "normal",
  });
  const stream = await open(mintSession(dm.id).token, doomed.id, "?lastSeq=0");
  deleteCampaign(doomed.id);
  await settle();
  assert.equal(stream.state.done, true);
});

await test("a reader within reach is replayed what it missed, then goes live", async () => {
  const { token } = mintSession(dm.id);
  const from = publishPersisted(campaign.id, "message_added", { message: { id: "m0" } });
  publishPersisted(campaign.id, "message_added", { message: { id: "m1" } });
  publishPersisted(campaign.id, "message_added", { message: { id: "m2" } });
  const stream = await open(token, campaign.id, `?lastSeq=${from}`);
  await settle();
  assert.match(stream.state.text, /"m1"/);
  assert.match(stream.state.text, /"m2"/);
  assert.doesNotMatch(stream.state.text, /"m0"/);
  assert.doesNotMatch(stream.state.text, /event: resync/);
  publishPersisted(campaign.id, "message_added", { message: { id: "m3" } });
  await settle();
  assert.match(stream.state.text, /"m3"/);
  stream.abort();
});

await test("a reader too far behind, or with no real cursor, is told to resync", async () => {
  assert.deepEqual(planReplay("-5", 10), { kind: "resync", latest: 10 });
  assert.deepEqual(planReplay("abc", 10), { kind: "resync", latest: 10 });
  assert.deepEqual(planReplay("11", 10), { kind: "resync", latest: 10 });
  assert.deepEqual(planReplay("1.5", 10), { kind: "resync", latest: 10 });
  assert.deepEqual(planReplay(null, 10), { kind: "replay", from: 0 });
  assert.deepEqual(planReplay("0", REPLAY_GAP_LIMIT + 1), { kind: "resync", latest: REPLAY_GAP_LIMIT + 1 });
  assert.deepEqual(planReplay("1", REPLAY_GAP_LIMIT + 1), { kind: "replay", from: 1 });

  const { token } = mintSession(dm.id);
  const stream = await open(token, campaign.id, "?lastSeq=-1");
  await settle();
  assert.match(stream.state.text, /event: resync/);
  assert.doesNotMatch(stream.state.text, /"m1"/, "no history was sent");
  stream.abort();
});

await test("a reader that stops reading is let go", async () => {
  const { token } = mintSession(dm.id);
  globalThis.__odmTestToken = token;
  const response = await events.GET(new Request(`http://x/api/campaigns/${campaign.id}/events?lastSeq=0`), {
    params: Promise.resolve({ campaignId: campaign.id }),
  });
  const before = openStreamCount();
  // Nothing reads this body. Each event is ~200 KB; the stream lets 4 MB
  // pile up and then closes rather than queueing the session in memory.
  const big = "x".repeat(200_000);
  for (let index = 0; index < 40; index += 1) {
    publishEphemeral(campaign.id, "dm_delta", { text: big });
  }
  await settle();
  assert.equal(openStreamCount(), before - 1);
  await response.body.cancel();
});

await test("one account's streams are capped, the oldest let go first", async () => {
  const opened = [];
  for (let index = 0; index < STREAMS_PER_USER + 2; index += 1) {
    opened.push(await open(mintSession(dm.id).token, campaign.id, "?lastSeq=0"));
  }
  await settle();
  assert.equal(opened[0].state.done, true);
  assert.equal(opened[1].state.done, true);
  assert.equal(opened[opened.length - 1].state.done, false);
  for (const stream of opened) {
    stream.abort();
  }
});

await test("expired sessions are refused by date and swept in bounded batches", () => {
  const db = getDatabase();
  const past = new Date(Date.now() - 1000).toISOString();
  for (let index = 0; index < 5; index += 1) {
    insertSession(`expired-${index}`, player.id, past);
  }
  assert.equal(sessionHolder("expired-0"), null);
  assert.equal(pruneExpiredSessions(new Date().toISOString(), 3), 3);
  assert.equal(pruneExpiredSessions(new Date().toISOString(), 3), 2);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT token_hash FROM sessions WHERE expires_at < ?").all("x");
  assert.ok(plan.some((row) => /idx_sessions_expires/.test(row.detail)), JSON.stringify(plan));
});

await settle();
removeTempDir(dir);
console.log(`\n${passed} stream-lifecycle tests passed.`);
