import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closeDatabaseForRestore } from "@/lib/db/core";
import { closeAllStreams } from "@/lib/live-streams";
import { enterMaintenance } from "@/lib/maintenance";
import { serverEnv } from "@/lib/server-env";

// Every step that takes time runs off the request thread: the snapshot in a
// child process, the copies through the file system's thread pool, tar as a
// child. Before, VACUUM INTO, every recursive copy and tar ran synchronously
// inside the request, and a backup of a world with its models stopped every
// table on the server until it finished.
const run = promisify(execFile);

// Server-side twin of scripts/odm-backup.mjs and scripts/odm-restore.mjs.
// The CLI refuses to run while the app is listening, because it checkpoints
// the live WAL in place; the in-app backup takes a `VACUUM INTO` snapshot
// instead, which SQLite guarantees consistent even with writers active. The
// archives are interchangeable: same manifest format, same include list, and
// the CLI restore verifies the same integrity proof before touching files.

export type BackupEntry = {
  name: string;
  sizeBytes: number;
  createdAt: string;
  sha256: string;
};

export type RestoreProof = {
  campaigns: number;
  users: number;
  messages: number;
};

const ARCHIVE_RE = /^odm-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.tar\.gz$/;

// A failure the route should answer with a specific status (a missing or
// corrupt archive is a 4xx, not a server fault).
export class BackupError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// The persistent state tree, identical to the CLI's include list.
const INCLUDES = [
  "data",
  "public/uploads",
  "public/generated",
  "public/generated-audio",
  "models",
  ".env.server",
];

// Downloaded model weights: often the largest folder by far, and fetched
// again on first use, so a backup leaves them out unless asked.
const REDOWNLOADABLE = new Set(["models"]);

// One backup or restore at a time, and what it is doing now, for the admin
// panel to show while it runs.
export type BackupJob = { kind: "backup" | "restore" | "verify"; phase: string; startedAt: string };

declare global {
  var __odmBackupJob: BackupJob | undefined;
}

export function currentBackupJob(): BackupJob | null {
  return globalThis.__odmBackupJob ?? null;
}

async function exclusive<T>(kind: BackupJob["kind"], work: (phase: (name: string) => void) => Promise<T>): Promise<T> {
  const running = globalThis.__odmBackupJob;
  if (running) {
    throw new BackupError(`A ${running.kind} is already running (${running.phase}). Try again when it has finished.`, 409);
  }
  const job: BackupJob = { kind, phase: "starting", startedAt: new Date().toISOString() };
  globalThis.__odmBackupJob = job;
  try {
    return await work((name) => {
      job.phase = name;
    });
  } finally {
    globalThis.__odmBackupJob = undefined;
  }
}

async function treeBytes(target: string): Promise<number> {
  let info: fs.Stats;
  try {
    info = await fs.promises.lstat(target);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) {
    return info.isFile() ? info.size : 0;
  }
  let total = 0;
  for (const entry of await fs.promises.readdir(target)) {
    total += await treeBytes(path.join(target, entry));
  }
  return total;
}

async function freeBytes(dir: string): Promise<number> {
  try {
    const stats = await fs.promises.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Room for the staged copy and the archive, with a margin, checked before
// anything is written: a backup that filled the disk would take the
// database's own writes down with it.
const HEADROOM_BYTES = 256 * 1024 * 1024;

async function requireRoom(needed: number, ...dirs: string[]) {
  for (const dir of dirs) {
    const free = await freeBytes(dir);
    if (free < needed + HEADROOM_BYTES) {
      const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
      throw new BackupError(
        `Not enough free disk for this backup: it needs about ${gib(needed + HEADROOM_BYTES)} GB at ${dir}, which has ${gib(free)} GB free.`,
        507,
      );
    }
  }
}

// The database work (the consistent snapshot, and a restore's integrity
// proof) runs in a separate Node process with the same SQLite module, so a
// large world's VACUUM INTO or integrity_check does not hold the server's
// event loop. The key travels in the environment, never the command line.
const DATABASE_SCRIPT = `
const [mode, modulePath, source, target] = process.argv.slice(1);
const Database = require(modulePath);
const db = new Database(source, { readonly: true });
try {
  const key = process.env.ODM_BACKUP_DB_KEY || "";
  if (key) {
    db.pragma("cipher='chacha20'");
    db.pragma("key='" + key.replaceAll("'", "''") + "'");
  }
  if (mode === "vacuum") {
    db.exec("VACUUM INTO '" + target.replaceAll("'", "''") + "'");
  } else {
    const integrity = db.pragma("integrity_check", { simple: true });
    const count = (table) => db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
    process.stdout.write(JSON.stringify(integrity === "ok"
      ? { integrity, campaigns: count("campaigns"), users: count("users"), messages: count("campaign_messages") }
      : { integrity }));
  }
} finally {
  db.close();
}
`;

// Where the server's own copy of the module lives: looked up from the app
// root (a standalone build and the Docker image keep node_modules there)
// and then from this file (a checkout run from anywhere, and the tests).
function sqliteModulePath(): string {
  const bases = [path.join(/*turbopackIgnore: true*/ root(), "package.json")];
  try {
    bases.push(fileURLToPath(import.meta.url));
  } catch {
    // No file address for this module in this build; the root is enough.
  }
  for (const base of bases) {
    try {
      return createRequire(base).resolve("better-sqlite3-multiple-ciphers");
    } catch {
      // Try the next place.
    }
  }
  return "";
}

// Runs one database job in the child process; null when the child could not
// be used (the module did not resolve, or the process failed to start), so
// the caller does the work in this process as before rather than failing.
async function inChild(mode: "vacuum" | "prove", source: string, target: string, key: string): Promise<string | null> {
  const modulePath = sqliteModulePath();
  if (!modulePath) {
    return null;
  }
  try {
    const { stdout } = await run(process.execPath, ["-e", DATABASE_SCRIPT, mode, modulePath, source, target], {
      env: { ...process.env, ODM_BACKUP_DB_KEY: key, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    console.warn(`[backup] the ${mode} process failed; doing it in this process instead`, error);
    return null;
  }
}

async function snapshotDatabase(db: string, snapshot: string, key: string) {
  if ((await inChild("vacuum", db, snapshot, key)) !== null) {
    return;
  }
  await fs.promises.rm(snapshot, { force: true });
  const Database = (await import("better-sqlite3-multiple-ciphers")).default;
  const handle = new Database(db, { readonly: true });
  try {
    if (key) {
      handle.pragma("cipher='chacha20'");
      handle.pragma(`key='${key.replaceAll("'", "''")}'`);
    }
    handle.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  } finally {
    handle.close();
  }
}

function root() {
  return process.cwd();
}

// The paths a restore may replace: the ones the manifest names, and only
// when this app manages them. A live restore deletes each one before copying
// the archive's over it, so a manifest that could name anything else ("..",
// "src", another folder on the disk) could delete it.
function managedPaths(manifest: { includes?: unknown }): string[] {
  const named = Array.isArray(manifest.includes) ? manifest.includes : [];
  for (const rel of named) {
    if (typeof rel !== "string" || !INCLUDES.includes(rel)) {
      throw new BackupError(`backup manifest names a path this app does not manage: ${String(rel)}`);
    }
  }
  return [...new Set([...(named as string[]), "odm-backup.json"])];
}

export function backupDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ serverEnv("ODM_BACKUP_DIR") || path.join(os.homedir(), "odm-backups"));
}

function dbPath(): string {
  return path.resolve(/*turbopackIgnore: true*/ serverEnv("SQLITE_DB_PATH") || path.join(/*turbopackIgnore: true*/ root(), "data", "local-roleplay.sqlite"));
}

// Archives are the size of the whole state tree and can pass 2 GiB, where
// readFileSync throws ERR_FS_FILE_TOO_LARGE; hash over a stream instead.
async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function envValue(file: string, key: string): string {
  if (!fs.existsSync(file)) return "";
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return fs.readFileSync(file, "utf8").match(new RegExp(`^${escaped}=(.*)$`, "m"))?.[1]?.trim() || "";
}

function encryptionKey(): string {
  const fromEnv = serverEnv("DB_ENCRYPTION_KEY").trim();
  if (fromEnv) return fromEnv;
  const dockerKey = path.join(/*turbopackIgnore: true*/ root(), "data", ".db-key");
  return fs.existsSync(dockerKey) ? fs.readFileSync(dockerKey, "utf8").trim() : "";
}

// Only ever touch archives we named: a strict name plus a containment check,
// so no request can walk out of the backup directory.
export function resolveArchive(name: string): string | null {
  if (!ARCHIVE_RE.test(name)) return null;
  const archive = path.resolve(backupDir(), name);
  if (path.dirname(archive) !== backupDir()) return null;
  return fs.existsSync(archive) ? archive : null;
}

export function listBackups(): BackupEntry[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => ARCHIVE_RE.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      let sha256 = "";
      try {
        sha256 = fs.readFileSync(`${path.join(dir, name)}.sha256`, "utf8").trim();
      } catch {
        // Archives made by the CLI carry no sidecar; the UI shows its hash only after a verify.
      }
      return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), sha256 };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createBackup(options: { includeModels?: boolean } = {}): Promise<BackupEntry> {
  return exclusive("backup", (phase) => buildBackup(options, phase));
}

async function buildBackup(options: { includeModels?: boolean }, phase: (name: string) => void): Promise<BackupEntry> {
  const appRoot = root();
  const db = dbPath();
  const relativeDb = path.relative(appRoot, db);
  if (!relativeDb || relativeDb.startsWith("..") || path.isAbsolute(relativeDb)) {
    throw new Error("SQLITE_DB_PATH must live under the app root for a portable backup.");
  }
  if (!fs.existsSync(db)) {
    throw new Error(`database not found: ${db}`);
  }
  const includes = INCLUDES.filter(
    (rel) =>
      (options.includeModels || !REDOWNLOADABLE.has(rel)) &&
      fs.existsSync(path.join(/*turbopackIgnore: true*/ appRoot, rel)),
  );

  phase("measuring");
  let needed = 0;
  for (const rel of includes) {
    needed += await treeBytes(path.join(/*turbopackIgnore: true*/ appRoot, rel));
  }
  const dir = backupDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await requireRoom(needed, os.tmpdir(), dir);

  // A consistent copy while the server keeps playing: VACUUM INTO writes a
  // snapshot from a read transaction, WAL included, without pausing writers.
  const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), "odm-backup-"));
  try {
    phase("snapshotting the database");
    const snapshot = path.join(stage, "snapshot.sqlite");
    await snapshotDatabase(db, snapshot, encryptionKey());

    phase("copying files");
    const liveDb = path.resolve(db);
    for (const rel of includes) {
      const src = path.join(/*turbopackIgnore: true*/ appRoot, rel);
      const dst = path.join(/*turbopackIgnore: true*/ stage, rel);
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      // WAL/SHM sidecars belong to the live database, not to the VACUUM INTO
      // snapshot that replaces it; shipping them makes the archive corrupt.
      // The live database itself is skipped too: the snapshot takes its
      // place, and copying it first doubled the largest file for nothing.
      await fs.promises.cp(src, dst, {
        recursive: true,
        filter: (from) => !/-(?:wal|shm)$/.test(from) && path.resolve(from) !== liveDb,
      });
    }
    const stagedDb = path.join(stage, relativeDb);
    await fs.promises.mkdir(path.dirname(stagedDb), { recursive: true });
    await fs.promises.rm(stagedDb, { force: true });
    await fs.promises.rename(snapshot, stagedDb);

    const createdAt = new Date();
    const manifest = {
      format: 1,
      createdAt: createdAt.toISOString(),
      database: relativeDb.replaceAll(path.sep, "/"),
      includes,
      source: "app",
    };
    await fs.promises.writeFile(path.join(stage, "odm-backup.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    try {
      await fs.promises.chmod(dir, 0o700);
    } catch {
      // chmod is best-effort on Windows.
    }

    phase("compressing");
    const stamp = createdAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `odm-backup-${stamp}.tar.gz`;
    const archive = path.join(dir, name);
    await run("tar", ["-czf", archive, "-C", stage, "."], { maxBuffer: 16 * 1024 * 1024 });

    phase("hashing");
    const sha256 = await hashFile(archive);
    await fs.promises.writeFile(`${archive}.sha256`, `${sha256}\n`, { mode: 0o600 });

    return { name, sizeBytes: (await fs.promises.stat(archive)).size, createdAt: createdAt.toISOString(), sha256 };
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
}

export function deleteBackup(name: string): boolean {
  const archive = resolveArchive(name);
  if (!archive) return false;
  fs.rmSync(archive, { force: true });
  fs.rmSync(`${archive}.sha256`, { force: true });
  return true;
}

// The CLI restore's proof, run before any live file is touched: reject
// traversal paths, open the encrypted database with the archived key, run
// PRAGMA integrity_check and count the campaign tables.
export async function verifyBackup(name: string): Promise<{ proof: RestoreProof; sha256: string }> {
  return exclusive("verify", () => proveArchive(name));
}

async function proveArchive(name: string): Promise<{ proof: RestoreProof; sha256: string }> {
  const archive = resolveArchive(name);
  if (!archive) {
    throw new BackupError("No such backup archive.", 404);
  }

  const { stdout: listing } = await run("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  for (const raw of listing.split(/\r?\n/)) {
    const entry = raw.trim().replace(/^\.\//, "");
    if (!entry) continue;
    if (path.posix.isAbsolute(entry) || entry.split("/").includes("..")) {
      throw new Error(`archive contains an unsafe path: ${raw}`);
    }
  }

  const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), "odm-restore-"));
  try {
    await run("tar", ["-xzf", archive, "-C", stage], { maxBuffer: 16 * 1024 * 1024 });
    const manifestPath = path.join(stage, "odm-backup.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error("archive is missing odm-backup.json");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      format?: number;
      database?: string;
      includes?: unknown;
    };
    if (manifest.format !== 1 || typeof manifest.database !== "string") {
      throw new Error("unsupported backup manifest");
    }
    managedPaths(manifest);
    const dbInStage = path.resolve(stage, manifest.database);
    const relative = path.relative(stage, dbInStage);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("backup manifest points outside the restored tree");
    }
    if (!fs.existsSync(dbInStage)) {
      throw new Error("restored database is missing from the archive");
    }
    // Archives made before sidecars were excluded could carry a WAL that does
    // not belong to the snapshot; SQLite would call that corruption.
    fs.rmSync(`${dbInStage}-wal`, { force: true });
    fs.rmSync(`${dbInStage}-shm`, { force: true });

    // Prefer the key the archive carries (it matches the archive's data);
    // fall back to this server's key for archives made without one.
    const key =
      envValue(path.join(/*turbopackIgnore: true*/ stage, ".env.server"), "DB_ENCRYPTION_KEY") ||
      (fs.existsSync(path.join(/*turbopackIgnore: true*/ stage, "data", ".db-key"))
        ? fs.readFileSync(path.join(/*turbopackIgnore: true*/ stage, "data", ".db-key"), "utf8").trim()
        : "") ||
      encryptionKey();

    const fromChild = await inChild("prove", dbInStage, "", key);
    let proof: RestoreProof;
    if (fromChild !== null) {
      const result = JSON.parse(fromChild) as Partial<RestoreProof> & { integrity?: string };
      if (result.integrity !== "ok") {
        throw new Error(`restored database integrity check failed: ${result.integrity}`);
      }
      proof = { campaigns: Number(result.campaigns), users: Number(result.users), messages: Number(result.messages) };
    } else {
      const Database = (await import("better-sqlite3-multiple-ciphers")).default;
      const db = new Database(dbInStage, { readonly: true });
      try {
        if (key) {
          db.pragma("cipher='chacha20'");
          db.pragma(`key='${key.replaceAll("'", "''")}'`);
        }
        const integrity = db.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") {
          throw new Error(`restored database integrity check failed: ${integrity}`);
        }
        const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        proof = { campaigns: count("campaigns"), users: count("users"), messages: count("campaign_messages") };
      } finally {
        db.close();
      }
    }
    const sha256 = await hashFile(archive);
    return { proof, sha256 };
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
}

// Replace the live state with a verified archive. The proof runs first and
// touches nothing; only then does the server stop taking play (maintenance:
// every API request is refused, every stream closed, the database closed),
// so nothing is written to the old file after the new one is in place and
// lost at the restart. The server stays in maintenance until it restarts.
export async function restoreBackup(name: string): Promise<{ proof: RestoreProof }> {
  return exclusive("restore", async (phase) => {
    phase("verifying");
    const { proof } = await proveArchive(name);
    const archive = resolveArchive(name);
    if (!archive) {
      throw new BackupError("No such backup archive.", 404);
    }

    const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), "odm-restore-"));
    try {
      phase("extracting");
      await run("tar", ["-xzf", archive, "-C", stage], { maxBuffer: 16 * 1024 * 1024 });
      const manifest = JSON.parse(await fs.promises.readFile(path.join(stage, "odm-backup.json"), "utf8")) as {
        includes?: string[];
      };
      const paths = managedPaths(manifest);

      phase("replacing the world");
      enterMaintenance(`restoring ${name}`);
      closeAllStreams();
      closeDatabaseForRestore();
      for (const rel of paths) {
        const src = path.join(stage, rel);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(/*turbopackIgnore: true*/ root(), rel);
        await fs.promises.rm(dst, { recursive: true, force: true });
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.cp(src, dst, { recursive: true });
      }
      // The sidecars belong to the database file that was just replaced; a
      // restart opens a fresh pair.
      const db = dbPath();
      await fs.promises.rm(`${db}-wal`, { force: true });
      await fs.promises.rm(`${db}-shm`, { force: true });
      return { proof };
    } finally {
      await fs.promises.rm(stage, { recursive: true, force: true });
    }
  });
}
