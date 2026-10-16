import fs from "node:fs";
import path from "node:path";

// How a restore puts an archive's copy of the managed state (data/, the media
// folders, models/, .env.server) in place of the live one. Shared by the admin
// panel's restore (src/lib/ops/backup.ts) and scripts/odm-restore.mjs, so it
// imports nothing but Node.
//
// Both used to delete each live path and copy the archive's over it. A full
// disk or a crash between the two left the world half gone, and on Docker,
// where data/ and the media folders are volumes mounted at those very paths,
// the delete itself failed (a mount point cannot be removed), so the panel's
// restore could never work there.
//
// Now nothing live is touched until the whole archive has been copied beside
// it on the same disk: into a hidden folder inside each managed folder (inside
// the volume, on Docker) or next to a managed file. Then each live entry is
// renamed into a hidden "previous" folder and each incoming one renamed into
// place, every step recorded so a failure puts them all back. The managed
// folders themselves are never removed or renamed, and a folder mounted
// directly inside one (Docker's models/speech) is swapped on its own disk.
//
// The world that was there stays in the previous folders until the next
// restore; backups leave both hidden folders out.

export const INCOMING = ".odm-restore-incoming";
export const PREVIOUS = ".odm-restore-previous";

// The restore's own folders and files, which no backup carries and no swap moves.
export function isSwapLeftover(name: string): boolean {
  return name.endsWith(INCOMING) || name.endsWith(PREVIOUS);
}

export type SwapUnit = {
  // Relative to the root, with "/" separators.
  rel: string;
  kind: "dir" | "file";
  // Folders directly inside this one that are mounted from another disk;
  // each is a unit of its own and stays where it is.
  mounts: string[];
};

const joinRel = (...parts: string[]) => parts.filter(Boolean).join("/");
const onDisk = (root: string, rel: string) => path.join(/*turbopackIgnore: true*/ root, ...rel.split("/"));

function deviceOf(target: string): number | null {
  try {
    return fs.statSync(target).dev;
  } catch {
    return null;
  }
}

// Every folder under a live managed folder that sits on another disk than its
// parent: a mount point.
function mountsUnder(root: string, rel: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, dev: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(onDisk(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isSwapLeftover(entry.name)) continue;
      const child = joinRel(dir, entry.name);
      const childDev = deviceOf(onDisk(root, child));
      if (childDev === null) continue;
      if (childDev !== dev) found.push(child);
      walk(child, childDev);
    }
  };
  const dev = deviceOf(onDisk(root, rel));
  if (dev !== null) walk(rel, dev);
  return found;
}

// Which paths the archive replaces, and how. Throws before anything is
// written when a disk is mounted deeper inside a managed folder than one level,
// which this swap does not handle.
export function planSwap(root: string, stage: string, paths: readonly string[]): SwapUnit[] {
  const units: SwapUnit[] = [];
  for (const rel of paths) {
    let info: fs.Stats;
    try {
      info = fs.lstatSync(onDisk(stage, rel));
    } catch {
      // Not in the archive: the live copy stays as it is.
      continue;
    }
    if (!info.isDirectory()) {
      units.push({ rel, kind: "file", mounts: [] });
      continue;
    }
    const mounts = mountsUnder(root, rel);
    for (const mount of mounts) {
      const parent = mount.slice(0, mount.lastIndexOf("/"));
      if (parent !== rel && !mounts.includes(parent)) {
        throw new Error(`${mount} is mounted from another disk deeper inside ${rel}; restore that folder by hand.`);
      }
    }
    const direct = (folder: string) => mounts.filter((mount) => mount.slice(0, mount.lastIndexOf("/")) === folder);
    units.push({ rel, kind: "dir", mounts: direct(rel) });
    for (const mount of mounts) units.push({ rel: mount, kind: "dir", mounts: direct(mount) });
  }
  return units;
}

async function removeLeftovers(root: string, units: readonly SwapUnit[], names: readonly string[]): Promise<void> {
  for (const unit of units) {
    const live = onDisk(root, unit.rel);
    for (const name of names) {
      const target = unit.kind === "file" ? `${live}${name}` : path.join(live, name);
      await fs.promises.rm(target, { recursive: true, force: true });
    }
  }
}

// Copies the archive's state beside the live one. Nothing live changes; on
// failure the copies are removed and the error rethrown. The previous restore's
// set-aside world goes first, to make room.
export async function stageSwap(root: string, stage: string, units: readonly SwapUnit[]): Promise<void> {
  await removeLeftovers(root, units, [INCOMING, PREVIOUS]);
  try {
    for (const unit of units) {
      const live = onDisk(root, unit.rel);
      const source = onDisk(stage, unit.rel);
      if (unit.kind === "file") {
        await fs.promises.mkdir(path.dirname(live), { recursive: true });
        await fs.promises.copyFile(source, `${live}${INCOMING}`);
        continue;
      }
      const incoming = path.join(live, INCOMING);
      await fs.promises.mkdir(incoming, { recursive: true });
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(source);
      } catch {
        // A mounted folder the archive has nothing for: it is emptied.
      }
      for (const name of names) {
        if (unit.mounts.includes(joinRel(unit.rel, name))) continue;
        await fs.promises.cp(path.join(source, name), path.join(incoming, name), { recursive: true });
      }
    }
  } catch (error) {
    await removeLeftovers(root, units, [INCOMING]).catch(() => {});
    throw error;
  }
}

// Puts the staged copies in place by renames on one disk. Every step is
// recorded; if one fails, the done ones are undone in reverse, so the live
// world is back as it was, and the error is rethrown.
export async function commitSwap(root: string, units: readonly SwapUnit[]): Promise<{ kept: string[] }> {
  const done: Array<[from: string, to: string]> = [];
  const step = async (from: string, to: string) => {
    await fs.promises.rename(from, to);
    done.push([from, to]);
  };
  const kept: string[] = [];
  try {
    for (const unit of units) {
      const live = onDisk(root, unit.rel);
      if (unit.kind === "file") {
        if (fs.existsSync(live)) {
          await step(live, `${live}${PREVIOUS}`);
          kept.push(`${unit.rel}${PREVIOUS}`);
        }
        await step(`${live}${INCOMING}`, live);
        continue;
      }
      const previous = path.join(live, PREVIOUS);
      const incoming = path.join(live, INCOMING);
      const stays = new Set(unit.mounts.map((mount) => mount.slice(mount.lastIndexOf("/") + 1)));
      const outgoing = (await fs.promises.readdir(live)).filter((name) => !isSwapLeftover(name) && !stays.has(name));
      if (outgoing.length) {
        await fs.promises.mkdir(previous, { recursive: true });
        kept.push(joinRel(unit.rel, PREVIOUS));
      }
      for (const name of outgoing) await step(path.join(live, name), path.join(previous, name));
      for (const name of await fs.promises.readdir(incoming)) await step(path.join(incoming, name), path.join(live, name));
    }
  } catch (error) {
    for (const [from, to] of done.reverse()) {
      await fs.promises.rename(to, from).catch((undo) => console.error("[restore] could not undo a step", from, undo));
    }
    await removeLeftovers(root, units, [INCOMING]).catch(() => {});
    // A previous folder is only dropped when the undo emptied it: anything
    // still in one is live state a failed undo left there.
    for (const unit of units) {
      if (unit.kind === "dir") await fs.promises.rmdir(path.join(onDisk(root, unit.rel), PREVIOUS)).catch(() => {});
    }
    throw error;
  }
  await removeLeftovers(root, units, [INCOMING]);
  return { kept };
}
