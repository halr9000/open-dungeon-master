import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

// Unpacking a .zip of an addon's folder that an admin picked (addon.json at
// its root, or inside one top folder, which is what zipping a folder makes).
// Addons from the list or a GitHub link never come as a zip: they are
// fetched file by file (src/lib/addons/repo-fetch.ts). A setup download's
// zip is unpacked from disk by src/lib/addons/unzip.ts.
//
// The archive is untrusted until its manifest has been read, and a registry
// entry's sha256 has only told us it is the archive somebody reviewed, so
// every entry is held to the rules a hostile zip breaks: no absolute paths,
// no "..", no links, a ceiling on the number of files and on the bytes each
// one and all of them really inflate to (a declared size can lie, so the
// count is taken while inflating).

export const MAX_ARCHIVE_FILES = 5_000;
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

export type UnpackResult = { ok: true; files: number; bytes: number } | { ok: false; error: string };

const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// An entry name as a safe relative path, or null.
export function safeEntryPath(name: string): string | null {
  if (!name || name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/").filter((part) => part !== "");
  if (!parts.length) return null;
  for (const part of parts) {
    if (part === "." || part === "..") return null;
  }
  return parts.join("/");
}

// The folder holding addon.json: the archive's root, the one top folder a
// zipped folder or a GitHub download has, or a subfolder named by `subdir`
// (an addon kept inside a bigger repository), under either. "" is the root;
// null when there is no addon.json where it should be.
function addonRoot(names: string[], subdir = ""): string | null {
  const inner = subdir ? `${subdir.replace(/^\/+|\/+$/g, "")}/` : "";
  if (names.includes(`${inner}addon.json`)) return inner;
  const tops = new Set(names.map((name) => name.split("/")[0]));
  const nested = names.find((name) => name.endsWith(`/${inner}addon.json`) && name.split("/").length === inner.split("/").length + 1);
  if (!nested || tops.size !== 1) return null;
  return nested.slice(0, nested.length - "addon.json".length);
}

async function inflate(file: JSZip.JSZipObject, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    const stream = file.nodeStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        // Stop inflating the moment it passes the ceiling.
        (stream as unknown as { pause(): void }).pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function loadZip(bytes: Uint8Array): Promise<JSZip | null> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    return null;
  }
}

// Reads addon.json out of an archive without unpacking the rest, so an
// install can refuse a wrong id or version before anything touches the disk.
export async function readArchiveManifest(bytes: Uint8Array, subdir = ""): Promise<{ ok: true; raw: unknown } | { ok: false; error: string }> {
  const zip = await loadZip(bytes);
  if (!zip) return { ok: false, error: "That file is not a zip archive." };
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const root = addonRoot(names, subdir);
  const entry = root === null ? null : zip.file(`${root}addon.json`);
  if (!entry) {
    return { ok: false, error: subdir ? `There is no addon.json in ${subdir}.` : "The archive has no addon.json at its root." };
  }
  const buffer = await inflate(entry, 256 * 1024);
  if (!buffer) return { ok: false, error: "addon.json is larger than 256 KB." };
  try {
    return { ok: true, raw: JSON.parse(buffer.toString("utf8")) };
  } catch {
    return { ok: false, error: "addon.json is not valid JSON." };
  }
}

// Writes every file under `root` into `target`, held to the rules above.
async function extract(zip: JSZip, root: string, target: string): Promise<UnpackResult> {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith(root));
  if (entries.length > MAX_ARCHIVE_FILES) {
    return { ok: false, error: `The archive holds more than ${MAX_ARCHIVE_FILES} files.` };
  }
  let total = 0;
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    const mode = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
    if ((mode & FILE_TYPE_MASK) === SYMLINK_MODE) {
      return { ok: false, error: `${entry.name} is a link. Archives here hold plain files only.` };
    }
    const relative = safeEntryPath(entry.name.slice(root.length));
    if (!relative) {
      return { ok: false, error: `${entry.name} is not a safe path inside the archive.` };
    }
    const data = await inflate(entry, Math.min(MAX_FILE_BYTES, MAX_UNPACKED_BYTES - total));
    if (!data) {
      return { ok: false, error: "The archive unpacks to more than this server takes in one go." };
    }
    total += data.length;
    const destination = path.join(target, ...relative.split("/"));
    if (!destination.startsWith(target + path.sep)) {
      return { ok: false, error: `${entry.name} is not a safe path inside the archive.` };
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
    // The executable bits travel; nothing else about the archive's modes does.
    if (mode & 0o111) {
      await chmod(destination, 0o755).catch(() => undefined);
    }
  }
  return { ok: true, files: entries.length, bytes: total };
}

// Unpacks an addon into `target` (which must not exist yet or be empty):
// the folder holding addon.json and everything under it. Anything else in
// the archive (the rest of a repository around a subfolder) is left out.
export async function unpackArchive(bytes: Uint8Array, target: string, subdir = ""): Promise<UnpackResult> {
  const zip = await loadZip(bytes);
  if (!zip) return { ok: false, error: "That file is not a zip archive." };
  const names = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
  const root = addonRoot(names, subdir);
  if (root === null) {
    return { ok: false, error: subdir ? `There is no addon.json in ${subdir}.` : "The archive has no addon.json at its root." };
  }
  return extract(zip, root, target);
}

// What an addon folder holds, as one SHA-256 that does not depend on how it
// was zipped: every file under the folder holding addon.json, by its path
// inside that folder and the SHA-256 of its contents, sorted by path. The
// same commit gives the same hash from GitHub's zip, a local `git archive`
// or any other packing, so the catalog can pin an addon by the files that
// were audited (docs/addons/guidelines.md) and the server can check them
// before anything is unpacked.
export async function archiveContentHash(
  bytes: Uint8Array,
  subdir = "",
): Promise<{ ok: true; sha256: string; files: number; bytes: number } | { ok: false; error: string }> {
  const zip = await loadZip(bytes);
  if (!zip) return { ok: false, error: "That file is not a zip archive." };
  const names = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
  const root = addonRoot(names, subdir);
  if (root === null) {
    return { ok: false, error: subdir ? `There is no addon.json in ${subdir}.` : "The archive has no addon.json at its root." };
  }
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && entry.name.startsWith(root))
    .map((entry) => ({ entry, relative: entry.name.slice(root.length) }))
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  if (entries.length > MAX_ARCHIVE_FILES) return { ok: false, error: `The addon holds more than ${MAX_ARCHIVE_FILES} files.` };
  const outer = createHash("sha256");
  let total = 0;
  for (const { entry, relative } of entries) {
    const data = await inflate(entry, Math.min(MAX_FILE_BYTES, MAX_UNPACKED_BYTES - total));
    if (!data) return { ok: false, error: "The addon unpacks to more than this server takes in one go." };
    total += data.length;
    outer.update(`${relative}\n${sha256Hex(data)}\n`);
  }
  return { ok: true, sha256: outer.digest("hex"), files: entries.length, bytes: total };
}

