// A device world in one file and back (audit C7, src/lib/ops/world-archive.ts):
// the export is a plaintext database with every secret left out plus the
// media, each fingerprinted in a manifest; the import verifies all of it
// before anything is replaced, re-keys the database for this device, gives
// the owner the app's password, and keeps the replaced world aside.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-world-archive-"));
process.env.SQLITE_DB_PATH = path.join(dir, "data", "odm.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.ODM_DEVICE_WORLD = "1";
fs.mkdirSync(path.join(dir, "data"), { recursive: true });
process.chdir(dir);
register("./lib/register-routes.mjs", import.meta.url);

const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign } = await import("../src/lib/db/campaigns.ts");
const { hashPassword, mintSession, verifyPassword } = await import("../src/lib/auth.ts");
const { getDatabase } = await import("../src/lib/db/core.ts");
const { openDatabase } = await import("../src/lib/db/driver.ts");
const { leaveMaintenance, maintenanceState } = await import("../src/lib/maintenance.ts");
const { readTarGz, writeTarGz } = await import("../src/lib/ops/tar.ts");
const world = await import("../src/lib/ops/world-archive.ts");
const route = await import("../src/app/api/admin/world/route.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const db = getDatabase();
const settings = { description: "", theme: "", maxPlayers: 4, startingLevel: 1, difficulty: "normal" };
const owner = createUser("owner", await hashPassword("first-password"), { isAdmin: true });
const friend = createUser("friend", await hashPassword("friend-password"));
const table = createCampaign(owner.id, { title: "The Hollow Crown", ...settings });
db.prepare(`INSERT INTO campaign_messages (id, campaign_id, seq, author_type, content, created_at) VALUES (?, ?, 1, 'dm', ?, ?)`).run(
  randomUUID(),
  table.id,
  "The secret door creaks open.",
  new Date().toISOString(),
);
db.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES ('global_config', ?, ?)`).run(
  JSON.stringify({ text: { provider: "custom", customApiKey: "sk-live-123", customModel: "gpt" }, discord: { clientSecret: "shh" } }),
  new Date().toISOString(),
);
db.prepare(`UPDATE users SET settings_json = ? WHERE id = ?`).run(JSON.stringify({ theme: "dark", openaiApiKey: "sk-user" }), friend.id);
mintSession(friend.id);

const media = (...parts) => path.join(dir, "public", ...parts);
const put = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const portrait = `${randomUUID()}.png`;
const message = randomUUID();
put(media("uploads", portrait), randomBytes(3000));
put(media("uploads", portrait.replace(".png", ".w256.webp")), randomBytes(500));
put(media("generated", "1700000000000-scene.png"), randomBytes(4000));
put(media("generated-audio", table.id, `${message}.mp3`), randomBytes(2000));
put(media("generated-audio", "previews", "voice.mp3"), randomBytes(100));

const asAdmin = () => (globalThis.__odmTestToken = mintSession(owner.id).token);
const post = async (body) => {
  const response = await route.POST(new Request("http://x/api/admin/world", { method: "POST", body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};
async function settled() {
  for (;;) {
    const job = (await (await route.GET()).json()).job;
    if (job?.done) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function entries(archive) {
  const found = [];
  for await (const entry of readTarGz(archive)) {
    const chunks = [];
    for await (const chunk of entry.stream) chunks.push(chunk);
    found.push({ name: entry.name, bytes: Buffer.concat(chunks) });
  }
  return found;
}

async function rewrite(source, target, change) {
  await writeTarGz(target, change(await entries(source)));
}

let exported;

await test("only the world's admin, and only in an app's own world, may move it", async () => {
  globalThis.__odmTestToken = mintSession(friend.id).token;
  assert.equal((await route.GET()).status, 403);
  asAdmin();
  process.env.ODM_DEVICE_WORLD = "0";
  assert.equal((await route.GET()).status, 404, "a server keeps its backups instead");
  process.env.ODM_DEVICE_WORLD = "1";
  assert.equal((await route.GET()).status, 200);
});

await test("an export holds the story and the media, and leaves every secret out", async () => {
  asAdmin();
  const started = await post({ action: "export" });
  assert.equal(started.status, 202);
  const job = await settled();
  assert.equal(job.error, "");
  exported = path.join(world.worldTransferDir(), job.export.name);
  assert.ok(fs.existsSync(exported));
  assert.deepEqual(job.export.counts, { campaigns: 1, users: 2, messages: 1, files: 4 });

  const found = await entries(exported);
  assert.equal(found[0].name, "manifest.json", "the manifest comes first");
  const manifest = JSON.parse(found[0].bytes.toString("utf8"));
  assert.equal(manifest.format, "odm-world");
  assert.deepEqual(
    found.slice(1).map((entry) => entry.name).sort(),
    [
      "media/generated-audio/" + table.id + "/" + message + ".mp3",
      "media/generated/1700000000000-scene.png",
      `media/uploads/${portrait}`,
      `media/uploads/${portrait.replace(".png", ".w256.webp")}`,
      "world.sqlite",
    ].sort(),
    "the voice preview cache stays behind",
  );
  const sqlite = found.find((entry) => entry.name === "world.sqlite").bytes;
  assert.equal(sqlite.subarray(0, 15).toString("latin1"), "SQLite format 3", "readable on any device");
  const copy = path.join(dir, "inspect.sqlite");
  fs.writeFileSync(copy, sqlite);
  const plain = openDatabase(copy);
  const count = (sql) => Object.values(plain.prepare(sql).get())[0];
  assert.equal(count(`SELECT COUNT(*) FROM sessions`), 0, "no sign-ins travel");
  const config = JSON.parse(plain.prepare(`SELECT value_json FROM app_settings WHERE key = 'global_config'`).get().value_json);
  assert.equal(config.text.customApiKey, "");
  assert.equal(config.text.customModel, "gpt", "settings that are not secrets travel");
  assert.equal(config.discord.clientSecret, "");
  assert.equal(JSON.parse(plain.prepare(`SELECT settings_json FROM users WHERE id = ?`).get(friend.id).settings_json).openaiApiKey, "");
  assert.equal(
    plain.prepare(`SELECT content FROM campaign_messages`).get().content,
    "The secret door creaks open.",
    "the story is never scrubbed",
  );
  plain.close();
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n > 0, "the live world keeps its sign-ins");
});

await test("a tampered or foreign archive is refused before anything is touched", async () => {
  asAdmin();
  const transfer = world.worldTransferDir();
  const tampered = path.join(transfer, "import-tampered.tar.gz");
  await rewrite(exported, tampered, (all) =>
    all.map((entry) => (entry.name.startsWith("media/uploads/") ? { name: entry.name, bytes: randomBytes(entry.bytes.length) } : entry)),
  );
  assert.equal((await post({ action: "check", name: "import-tampered.tar.gz" })).status, 202);
  assert.match((await settled()).error, /damaged/);

  const climbing = path.join(transfer, "import-climb.tar.gz");
  await rewrite(exported, climbing, (all) => {
    const manifest = JSON.parse(all[0].bytes.toString("utf8"));
    manifest.files.push({ name: "media/uploads/../../escape.sh", size: 1, sha256: "0".repeat(64) });
    return [{ name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }, ...all.slice(1)];
  });
  await post({ action: "check", name: "import-climb.tar.gz" });
  assert.match((await settled()).error, /should not/);
  assert.equal(fs.existsSync(path.join(dir, "escape.sh")), false);

  const newer = path.join(transfer, "import-newer.tar.gz");
  await rewrite(exported, newer, (all) => {
    const manifest = JSON.parse(all[0].bytes.toString("utf8"));
    manifest.serverVersion = "99.0.0";
    return [{ name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }, ...all.slice(1)];
  });
  await post({ action: "check", name: "import-newer.tar.gz" });
  assert.match((await settled()).error, /newer/);

  assert.equal((await post({ action: "check", name: "../odm.sqlite" })).status, 400, "only a staged import name");
  assert.equal((await post({ action: "commit", name: "import-newer.tar.gz", ownerPassword: "x".repeat(32) })).status, 409, "nothing commits unchecked");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM campaigns`).get().n, 1, "the live world is untouched");
});

await test("an import checks first, then swaps the world in and signs its owner in with the app's password", async () => {
  asAdmin();
  // The world moves on after the export: a new campaign, a lost portrait.
  createCampaign(owner.id, { title: "After the export", ...settings });
  fs.rmSync(media("uploads", portrait));
  put(media("uploads", "made-later.png"), randomBytes(100));

  fs.copyFileSync(exported, path.join(world.worldTransferDir(), "import-back.tar.gz"));
  await post({ action: "check", name: "import-back.tar.gz" });
  const job = await settled();
  assert.equal(job.error, "");
  assert.equal(job.preview.owner, "owner");
  assert.deepEqual(job.preview.counts, { campaigns: 1, users: 2, messages: 1, files: 4 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM campaigns`).get().n, 2, "a check replaces nothing");

  assert.equal((await post({ action: "commit", name: "import-back.tar.gz", ownerPassword: "short" })).status, 400);
  const secret = randomBytes(24).toString("base64url");
  const committed = await post({ action: "commit", name: "import-back.tar.gz", ownerPassword: secret });
  assert.equal(committed.status, 200);
  assert.deepEqual(committed.body, { owner: "owner", restart: true });
  assert.ok(maintenanceState(), "play stops until the app restarts the server");

  // What the restarted server opens.
  leaveMaintenance();
  const fresh = getDatabase();
  const live = fs.readFileSync(process.env.SQLITE_DB_PATH).subarray(0, 15).toString("latin1");
  if (fresh.encrypted) assert.notEqual(live, "SQLite format 3", "re-keyed for this device");
  assert.deepEqual(
    fresh.prepare(`SELECT title FROM campaigns`).all().map((row) => row.title),
    ["The Hollow Crown"],
  );
  const ownerRow = fresh.prepare(`SELECT password_hash FROM users WHERE username = 'owner'`).get();
  assert.equal(await verifyPassword(secret, ownerRow.password_hash), true, "the app's password signs the owner in");
  assert.equal(
    await verifyPassword("friend-password", fresh.prepare(`SELECT password_hash FROM users WHERE username = 'friend'`).get().password_hash),
    true,
    "friends keep their own passwords",
  );
  assert.equal(fs.existsSync(media("uploads", portrait)), true, "the archive's portrait is back");
  assert.equal(fs.existsSync(media("uploads", "made-later.png")), false);
  const previous = path.join(world.worldTransferDir(), "previous");
  assert.equal(fs.existsSync(path.join(previous, "media", "uploads", "made-later.png")), true, "the replaced world is kept aside");
  assert.equal(fs.existsSync(path.join(previous, "world.sqlite")), true);
  assert.equal(fs.existsSync(path.join(world.worldTransferDir(), "import-back.tar.gz")), false, "the staged file is gone");
});

await test("discard drops what is staged", async () => {
  asAdmin();
  await post({ action: "export" });
  const job = await settled();
  assert.ok(fs.existsSync(path.join(world.worldTransferDir(), job.export.name)));
  assert.equal((await post({ action: "discard" })).status, 200);
  assert.equal(fs.existsSync(path.join(world.worldTransferDir(), job.export.name)), false);
});

removeTempDir(dir);
console.log(`\n${passed} world archive checks passed.`);
