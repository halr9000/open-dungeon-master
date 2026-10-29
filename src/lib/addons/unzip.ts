import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { safeEntryPath } from "@/lib/addons/archive";

// Unpacking a zip that is already on disk, entry by entry, straight to
// files: a setup download such as a portable Blender or a model pack, which
// can be gigabytes. Nothing is held in memory but the zip's directory, so
// there is no size ceiling beyond the disk. The download's size and SHA-256
// were checked before this runs (src/lib/addons/download.ts); the paths are
// still held to the rules a hostile archive breaks: no absolute paths, no
// "..", no links. ZIP64 archives (over 4 GB, or over 65,535 entries) read
// too.

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 1_000_000;

type Entry = { name: string; method: number; compressed: number; size: number; offset: number; mode: number; flags: number };

async function readAt(file: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// The central directory: where it is and how many entries it lists.
async function findDirectory(file: Awaited<ReturnType<typeof open>>, fileSize: number) {
  const tailLength = Math.min(fileSize, 65_557);
  const tail = await readAt(file, fileSize - tailLength, tailLength);
  let at = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) {
      at = index;
      break;
    }
  }
  if (at < 0) throw new Error("That download is not a zip archive.");
  let entries = tail.readUInt16LE(at + 10);
  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locatorAt = at - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== ZIP64_LOCATOR) throw new Error("The zip's ZIP64 directory is missing.");
    const recordOffset = Number(tail.readBigUInt64LE(locatorAt + 8));
    const record = await readAt(file, recordOffset, 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error("The zip's ZIP64 directory does not read.");
    entries = Number(record.readBigUInt64LE(32));
    size = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
  }
  if (entries > MAX_ENTRIES) throw new Error(`The zip lists more than ${MAX_ENTRIES} entries.`);
  return { entries, size, offset };
}

function readEntries(directory: Buffer, count: number): Entry[] {
  const entries: Entry[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (directory.readUInt32LE(at) !== CENTRAL) throw new Error("The zip's directory does not read.");
    const madeBy = directory.readUInt16LE(at + 4);
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    let compressed = directory.readUInt32LE(at + 20);
    let size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const external = directory.readUInt32LE(at + 38);
    let offset = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    // ZIP64 sizes and offsets live in an extra field, in this order, for
    // each value the fixed field gave up on.
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    while (extraAt + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extraAt);
      const length = directory.readUInt16LE(extraAt + 2);
      if (id === 0x0001) {
        let field = extraAt + 4;
        if (size === 0xffffffff) {
          size = Number(directory.readBigUInt64LE(field));
          field += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = Number(directory.readBigUInt64LE(field));
          field += 8;
        }
        if (offset === 0xffffffff) offset = Number(directory.readBigUInt64LE(field));
      }
      extraAt += 4 + length;
    }
    const unix = madeBy >> 8 === 3 ? external >>> 16 : 0;
    entries.push({ name, method, compressed, size, offset, mode: unix, flags });
    at = extraEnd + commentLength;
  }
  return entries;
}

// Counts what passes through, so an entry cannot inflate past the size the
// zip declared for it.
function limit(max: number, name: string): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > max) callback(new Error(`${name} inflates past the size the zip declares.`));
      else callback(null, chunk);
    },
  });
}

export type UnzipResult = { ok: true; files: number; bytes: number } | { ok: false; error: string };

export async function unzipFile(zipPath: string, target: string, signal?: AbortSignal): Promise<UnzipResult> {
  const file = await open(zipPath, "r");
  try {
    const { size: fileSize } = await stat(zipPath);
    const { entries: count, size, offset } = await findDirectory(file, fileSize);
    const entries = readEntries(await readAt(file, offset, size), count);
    await mkdir(target, { recursive: true });
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (signal?.aborted) return { ok: false, error: "Cancelled." };
      const normalized = entry.name.replace(/\\/g, "/");
      if (normalized.endsWith("/")) {
        const folder = safeEntryPath(normalized);
        if (!folder) return { ok: false, error: `${entry.name} is not a safe path inside the zip.` };
        await mkdir(path.join(target, ...folder.split("/")), { recursive: true });
        continue;
      }
      if (entry.flags & 0x1) return { ok: false, error: `${entry.name} is encrypted.` };
      if ((entry.mode & 0o170000) === 0o120000) return { ok: false, error: `${entry.name} is a link. Setup archives hold plain files only.` };
      if (entry.method !== 0 && entry.method !== 8) return { ok: false, error: `${entry.name} uses a compression this server does not read.` };
      const relative = safeEntryPath(normalized);
      const destination = relative ? path.join(target, ...relative.split("/")) : "";
      if (!relative || !destination.startsWith(target + path.sep)) return { ok: false, error: `${entry.name} is not a safe path inside the zip.` };
      const local = await readAt(file, entry.offset, 30);
      if (local.readUInt32LE(0) !== LOCAL) return { ok: false, error: `${entry.name} does not read.` };
      const dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await mkdir(path.dirname(destination), { recursive: true });
      const source = entry.compressed > 0 ? createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressed - 1, signal }) : null;
      const out = createWriteStream(destination);
      if (!source) {
        out.end();
        await new Promise<void>((resolve) => out.on("close", () => resolve()));
      } else if (entry.method === 8) {
        await pipeline(source, createInflateRaw(), limit(entry.size, entry.name), out);
      } else {
        await pipeline(source, limit(entry.size, entry.name), out);
      }
      if (entry.mode & 0o111) await chmod(destination, 0o755).catch(() => undefined);
      files += 1;
      bytes += entry.size;
    }
    return { ok: true, files, bytes };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await file.close();
  }
}
