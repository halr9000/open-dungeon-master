// The admin panel's backup (audit P11): it runs off the request thread (the
// snapshot in a child process), skips the live database file it would only
// replace, leaves downloaded models out unless asked, refuses a second job
// while one runs, and a live restore stops the server taking play until it
// restarts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "odm-backup-in-app-"));
process.env.SQLITE_DB_PATH = path.join(root, "data", "local-roleplay.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.ODM_BACKUP_DIR = path.join(root, "backups");
process.chdir(root);
register("./lib/register-alias.mjs", import.meta.url);

const { getDatabase } = await import("../src/lib/db/core.ts");
const { createUser } = await import("../src/lib/db/users.ts");
const { createBackup, currentBackupJob, restoreBackup, verifyBackup } = await import("../src/lib/ops/backup.ts");
const { leaveMaintenance, maintenanceState } = await import("../src/lib/maintenance.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

createUser("keeper", "x");
fs.mkdirSync(path.join(root, "public", "uploads"), { recursive: true });
fs.writeFileSync(path.join(root, "public", "uploads", "face.png"), "png bytes");
fs.mkdirSync(path.join(root, "models", "embeddings"), { recursive: true });
fs.writeFileSync(path.join(root, "models", "embeddings", "weights.onnx"), Buffer.alloc(4096));

const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

// Read the way src/lib/ops/backup.ts reads it: Windows tar ends its lines
// with CRLF.
const listing = (name) =>
  execFileSync("tar", ["-tzf", path.join(root, "backups", name)], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);

let first;
await test("a backup holds the snapshot once, the media, and no models unless asked", async () => {
  // A beat on the event loop while the backup runs: it must keep ticking.
  let ticks = 0;
  const beat = setInterval(() => (ticks += 1), 1);
  first = await createBackup();
  clearInterval(beat);
  assert.ok(ticks > 0, "the event loop kept running");
  const files = listing(first.name);
  assert.ok(files.includes("data/local-roleplay.sqlite"), files.join(","));
  assert.equal(files.filter((file) => file.endsWith("local-roleplay.sqlite")).length, 1);
  assert.ok(!files.some((file) => /-(wal|shm)$/.test(file)), files.join(","));
  assert.ok(files.includes("public/uploads/face.png"), files.join(","));
  assert.ok(!files.some((file) => file.startsWith("models")), "models left out");
  assert.equal(warnings.filter((line) => /backup/.test(line)).length, 0, warnings.join("\n"));
});

await test("models go in when asked", async () => {
  // Archive names are stamped to the second.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const withModels = await createBackup({ includeModels: true });
  assert.ok(listing(withModels.name).includes("models/embeddings/weights.onnx"));
});

await test("a second job is refused while one runs", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const running = createBackup();
  assert.equal(currentBackupJob()?.kind, "backup");
  await assert.rejects(verifyBackup(first.name), (error) => error.status === 409);
  await running;
  assert.equal(currentBackupJob(), null);
});

await test("the archive verifies: integrity and counts read in the child", async () => {
  const { proof } = await verifyBackup(first.name);
  assert.deepEqual(proof, { campaigns: 0, users: 1, messages: 0 });
});

await test("a live restore stops the server taking play until it restarts", async () => {
  createUser("after-backup", "x");
  const { proof } = await restoreBackup(first.name);
  assert.equal(proof.users, 1);
  assert.match(maintenanceState()?.reason ?? "", /restoring/);
  assert.throws(() => getDatabase(), /maintenance/);
  // What a restart would open: the restored world, without the later user.
  leaveMaintenance();
  const users = getDatabase().prepare("SELECT username FROM users").all().map((row) => row.username);
  assert.deepEqual(users, ["keeper"]);
});

console.warn = warn;
getDatabase().close();
removeTempDir(root);
console.log(`\n${passed} in-app backup tests passed.`);
