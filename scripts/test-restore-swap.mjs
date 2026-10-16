// A restore puts the archive's state in place without deleting the live
// folders (src/lib/ops/state-swap.ts): everything is copied in beside them
// first, then swapped by renames that are undone if one fails. Docker mounts
// data/ and the media folders as volumes at those very paths, and the old
// delete-then-copy failed on them every time; the mount case runs in a user
// namespace where one is available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitSwap, INCOMING, isSwapLeftover, planSwap, PREVIOUS, stageSwap } from "../src/lib/ops/state-swap.ts";

const self = fileURLToPath(import.meta.url);
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file) => fs.readFileSync(file, "utf8");
const MANAGED = ["data", "public/uploads", "models", ".env.server"];

// A live tree and an archive's extracted tree, both under one temp folder.
function scene(base) {
  const root = path.join(base, "root");
  const stage = path.join(base, "stage");
  write(path.join(root, "data", "local-roleplay.sqlite"), "live world");
  write(path.join(root, "data", "worlds", "mine.json"), "live pack");
  write(path.join(root, "public", "uploads", "old.png"), "live picture");
  write(path.join(root, "models", "speech", "voice.onnx"), "live voice");
  write(path.join(root, ".env.server"), "DB_ENCRYPTION_KEY=live\n");
  write(path.join(stage, "data", "local-roleplay.sqlite"), "archived world");
  write(path.join(stage, "data", "worlds", "theirs.json"), "archived pack");
  write(path.join(stage, "public", "uploads", "new.png"), "archived picture");
  write(path.join(stage, "models", "speech", "other.onnx"), "archived voice");
  write(path.join(stage, ".env.server"), "DB_ENCRYPTION_KEY=archived\n");
  return { root, stage };
}

function assertRestored(root) {
  assert.equal(read(path.join(root, "data", "local-roleplay.sqlite")), "archived world");
  assert.equal(read(path.join(root, "data", "worlds", "theirs.json")), "archived pack");
  assert.ok(!fs.existsSync(path.join(root, "data", "worlds", "mine.json")));
  assert.equal(read(path.join(root, "public", "uploads", "new.png")), "archived picture");
  assert.ok(!fs.existsSync(path.join(root, "public", "uploads", "old.png")));
  assert.equal(read(path.join(root, "models", "speech", "other.onnx")), "archived voice");
  assert.equal(read(path.join(root, ".env.server")), "DB_ENCRYPTION_KEY=archived\n");
  // What was there is kept aside, and nothing of the swap is left over.
  assert.equal(read(path.join(root, "data", PREVIOUS, "local-roleplay.sqlite")), "live world");
  assert.equal(read(path.join(root, "data", PREVIOUS, "worlds", "mine.json")), "live pack");
  assert.equal(read(path.join(root, `.env.server${PREVIOUS}`)), "DB_ENCRYPTION_KEY=live\n");
  for (const rel of ["data", "public/uploads", "models", "models/speech"]) {
    assert.ok(!fs.existsSync(path.join(root, rel, INCOMING)), `${rel} kept its incoming folder`);
  }
}

function assertUntouched(root) {
  assert.equal(read(path.join(root, "data", "local-roleplay.sqlite")), "live world");
  assert.equal(read(path.join(root, "data", "worlds", "mine.json")), "live pack");
  assert.equal(read(path.join(root, "public", "uploads", "old.png")), "live picture");
  assert.equal(read(path.join(root, "models", "speech", "voice.onnx")), "live voice");
  assert.equal(read(path.join(root, ".env.server")), "DB_ENCRYPTION_KEY=live\n");
  assert.ok(!fs.existsSync(path.join(root, "data", INCOMING)));
  assert.ok(!fs.existsSync(path.join(root, "data", PREVIOUS)));
}

async function swap(root, stage) {
  const units = planSwap(root, stage, MANAGED);
  await stageSwap(root, stage, units);
  return commitSwap(root, units);
}

// Run inside `unshare -rm`: data/ and models/speech are tmpfs mounts, each
// its own disk, as Docker's volumes are.
async function insideNamespace(base) {
  const { root, stage } = scene(base);
  for (const rel of ["data", "models/speech"]) {
    const target = path.join(root, rel);
    const saved = fs.mkdtempSync(path.join(base, "saved-"));
    fs.cpSync(target, saved, { recursive: true });
    const mounted = spawnSync("mount", ["-t", "tmpfs", "tmpfs", target]);
    if (mounted.status !== 0) {
      console.log("SKIP no mount in this namespace");
      return;
    }
    fs.cpSync(saved, target, { recursive: true });
  }
  assert.notEqual(fs.statSync(path.join(root, "data")).dev, fs.statSync(root).dev, "data/ is a mount");
  // What the restore used to do: the mount point cannot be removed.
  await assert.rejects(fs.promises.rm(path.join(root, "data"), { recursive: true, force: true }), { code: "EBUSY" });
  const { kept } = await swap(root, stage);
  assertRestored(root);
  assert.equal(read(path.join(root, "models", "speech", PREVIOUS, "voice.onnx")), "live voice");
  assert.ok(kept.includes("models/speech/" + PREVIOUS), kept.join(","));

  // A disk mounted two levels down is refused before anything is written.
  const deep = path.join(root, "public", "uploads", "campaign", "maps");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(spawnSync("mount", ["-t", "tmpfs", "tmpfs", deep]).status, 0);
  write(path.join(stage, "public", "uploads", "campaign", "maps", "x.png"), "map");
  assert.throws(() => planSwap(root, stage, MANAGED), /mounted from another disk deeper inside public\/uploads/);
  console.log("MOUNTS OK");
}

if (process.argv[2] === "--in-namespace") {
  await insideNamespace(process.argv[3]);
  process.exit(0);
}

let passed = 0;
async function test(name, fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "odm-restore-swap-"));
  try {
    await fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  passed += 1;
  console.log(`ok - ${name}`);
}

await test("the archive replaces each managed path and the old state is kept aside", async (base) => {
  const { root, stage } = scene(base);
  const { kept } = await swap(root, stage);
  assertRestored(root);
  assert.deepEqual(kept.sort(), [`.env.server${PREVIOUS}`, `data/${PREVIOUS}`, `models/${PREVIOUS}`, `public/uploads/${PREVIOUS}`]);
});

await test("a path the archive does not carry is left alone", async (base) => {
  const { root, stage } = scene(base);
  fs.rmSync(path.join(stage, "models"), { recursive: true });
  await swap(root, stage);
  assert.equal(read(path.join(root, "models", "speech", "voice.onnx")), "live voice");
  assert.ok(!fs.existsSync(path.join(root, "models", PREVIOUS)));
});

await test("a copy that fails part way leaves the live state as it was", async (base) => {
  const { root, stage } = scene(base);
  const units = planSwap(root, stage, MANAGED);
  const cp = fs.promises.cp;
  let calls = 0;
  fs.promises.cp = async (...args) => {
    calls += 1;
    if (calls === 3) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return cp(...args);
  };
  try {
    await assert.rejects(stageSwap(root, stage, units), { code: "ENOSPC" });
  } finally {
    fs.promises.cp = cp;
  }
  assertUntouched(root);
});

await test("a rename that fails part way is undone, every step", async (base) => {
  const { root, stage } = scene(base);
  const units = planSwap(root, stage, MANAGED);
  await stageSwap(root, stage, units);
  const rename = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async (from, to) => {
    calls += 1;
    // Past data/'s two entries out and two in, into public/uploads.
    if (calls === 6) throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    return rename(from, to);
  };
  try {
    await assert.rejects(commitSwap(root, units), { code: "EBUSY" });
  } finally {
    fs.promises.rename = rename;
  }
  assertUntouched(root);
  assert.ok(!fs.existsSync(path.join(root, "public", "uploads", PREVIOUS)));
});

await test("the next restore replaces the last one's set-aside state, and backups skip it", async (base) => {
  const { root, stage } = scene(base);
  await swap(root, stage);
  write(path.join(root, "data", "later.txt"), "written after the first restore");
  await swap(root, stage);
  assert.ok(fs.existsSync(path.join(root, "data", PREVIOUS, "later.txt")));
  assert.ok(!fs.existsSync(path.join(root, "data", PREVIOUS, PREVIOUS)));
  assert.ok(isSwapLeftover(PREVIOUS) && isSwapLeftover(`.env.server${PREVIOUS}`) && isSwapLeftover(INCOMING));
  assert.ok(!isSwapLeftover("local-roleplay.sqlite"));
});

await test("a restore into an empty folder (the CLI's dry run) leaves nothing aside", async (base) => {
  const { stage } = scene(base);
  const empty = path.join(base, "empty");
  fs.mkdirSync(empty);
  const { kept } = await swap(empty, stage);
  assert.deepEqual(kept, []);
  assert.equal(read(path.join(empty, "data", "local-roleplay.sqlite")), "archived world");
  assert.ok(!fs.existsSync(path.join(empty, "data", PREVIOUS)));
});

await test("Docker's volumes: mounted folders are swapped on their own disks", async (base) => {
  if (process.platform !== "linux") {
    console.log("  skipped: mounts are tested on Linux");
    return;
  }
  const child = spawnSync("unshare", ["-rm", process.execPath, self, "--in-namespace", base], { encoding: "utf8" });
  if (child.error || /SKIP/.test(child.stdout) || /unshare failed|Operation not permitted/.test(child.stderr)) {
    console.log(`  skipped: no user namespace here (${(child.stderr || child.error?.message || "").trim().split("\n")[0]})`);
    return;
  }
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /MOUNTS OK/);
});

console.log(`\n${passed} restore swap tests passed.`);
