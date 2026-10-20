import { realpathSync } from "node:fs";
import path from "node:path";
import { ADDON_ID } from "@/lib/addons/manifest";

// Where addons live on disk. Everything sits under one folder so the desktop
// app keeps it across upgrades (its payload swap preserves data/) and an
// operator can see, back up or delete it in one place:
//
//   <ADDONS_DIR>/packages/<id>/   the unpacked package, replaced whole on update
//   <ADDONS_DIR>/data/<id>/       the addon's own writable folder, kept on update
//   <ADDONS_DIR>/work/<task>/     a run's input and output, removed after it
//   <ADDONS_DIR>/incoming/        uploads and downloads on their way in
//
// Every path is built from a schema-checked id or a server-made uuid, never
// from anything a caller typed.

export function addonsRoot(): string {
  return process.env.ADDONS_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "addons");
}

export function packagesDir(): string {
  return path.join(addonsRoot(), "packages");
}

export function packageDir(id: string): string | null {
  return ADDON_ID.test(id) ? path.join(packagesDir(), id) : null;
}

export function addonDataDir(id: string): string | null {
  return ADDON_ID.test(id) ? path.join(addonsRoot(), "data", id) : null;
}

export function workDir(): string {
  return path.join(addonsRoot(), "work");
}

export function incomingDir(): string {
  return path.join(addonsRoot(), "incoming");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isServerId(value: string): boolean {
  return UUID.test(value);
}

// A relative path resolved inside `root`, or null when it would leave it by
// name or (once the file exists) by a link. The manifest schema already
// refuses "..", absolute paths and backslashes; this is the second lock, on
// the real disk.
export function resolveInside(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(resolved);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      return null;
    }
  } catch {
    // Not there (yet): the name check above is the whole answer.
  }
  return resolved;
}
