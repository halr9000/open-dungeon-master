// The boot resync of every character sheet (audit P5) runs once per build
// and data change, not on every restart: a production boot records what it
// resynced against, a restart of the same build skips the pass, a new build
// or changed homebrew runs it again, and development boots keep resyncing
// every time. Each boot here is a real new process over the same database.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-boot-resync-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
register("./lib/register-alias.mjs", import.meta.url);

const { getDatabase, sheetResyncFingerprint } = await import("../src/lib/db/core.ts");
const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign } = await import("../src/lib/db/campaigns.ts");
const { createSheet } = await import("../src/lib/db/sheets.ts");
const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const dm = createUser("dm", "x");
const campaign = createCampaign(dm.id, {
  title: "T",
  description: "",
  theme: "",
  maxPlayers: 4,
  startingLevel: 3,
  difficulty: "normal",
});
const sheet = createSheet(
  campaign.id,
  dm.id,
  3,
  createSheetSchema.parse({
    name: "Brannoc",
    race: "human",
    class: "fighter",
    abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 },
    maxHp: 28,
    ac: 16,
    hitDice: { die: "d10", total: 3, spent: 0 },
    proficiencies: { saves: ["str", "con"], skills: [], languages: ["common"], tools: [], armor: [], weapons: [] },
    equipment: [],
    gold: 0,
  }),
);
const db = getDatabase();
const featuresOf = () =>
  (db.prepare("SELECT features_json FROM character_sheets WHERE id = ?").get(sheet.id)).features_json;
const healthy = featuresOf();
assert.ok(JSON.parse(healthy).length > 0, "a fighter has features");
const damage = () => db.prepare("UPDATE character_sheets SET features_json = '[]' WHERE id = ?").run(sheet.id);

// A boot in a fresh process: what it logged.
function boot(env) {
  return execFileSync(process.execPath, [path.join(import.meta.dirname, "lib", "boot-db.mjs")], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const production = (build) => ({ NODE_ENV: "production", ODM_BUILD_TIME: build, ODM_BUILD_COMMIT: "abc" });

test("the first production boot of a build resyncs and records it", () => {
  damage();
  assert.match(boot(production("build-1")), /resynced 1 character sheets/);
  assert.equal(featuresOf(), healthy, "the damaged row was regranted");
});

test("a restart of the same build over the same data skips the pass", () => {
  damage();
  assert.doesNotMatch(boot(production("build-1")), /resynced/);
  assert.equal(featuresOf(), "[]", "nothing was read or rewritten");
});

test("a new build runs it again", () => {
  assert.match(boot(production("build-2")), /resynced 1 character sheets .*\(1 changed\)/);
  assert.equal(featuresOf(), healthy);
});

test("changed homebrew runs it again", () => {
  damage();
  db.prepare(
    `INSERT INTO homebrew_entries (id, user_id, kind, slug, name, data_json, created_at, updated_at)
     VALUES ('hb1', ?, 'feat', 'iron-will', 'Iron Will', '{}', ?, ?)`,
  ).run(dm.id, new Date().toISOString(), new Date().toISOString());
  assert.match(boot(production("build-2")), /resynced/);
  assert.equal(featuresOf(), healthy);
});

test("development boots resync every time, as before", () => {
  damage();
  assert.match(boot({ NODE_ENV: "development", ODM_BUILD_TIME: "" }), /resynced/);
  assert.equal(featuresOf(), healthy);
});

test("the fingerprint is null outside a stamped production build", () => {
  assert.equal(sheetResyncFingerprint(db, { NODE_ENV: "test", ODM_BUILD_TIME: "x" }), null);
  assert.equal(sheetResyncFingerprint(db, { NODE_ENV: "production" }), null);
  const a = sheetResyncFingerprint(db, { NODE_ENV: "production", ODM_BUILD_TIME: "x" });
  assert.equal(a, sheetResyncFingerprint(db, { NODE_ENV: "production", ODM_BUILD_TIME: "x" }));
  assert.notEqual(a, sheetResyncFingerprint(db, { NODE_ENV: "production", ODM_BUILD_TIME: "y" }));
});

db.close();
removeTempDir(dir);
console.log(`\n${passed} boot-resync tests passed.`);
