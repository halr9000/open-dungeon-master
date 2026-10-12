import fs from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { PassThrough, type Readable } from "node:stream";
import zlib from "node:zlib";

// A gzipped tar file, written and read in plain Node (src/lib/ops/world-archive.ts).
// The server's backups shell out to tar; a phone has no tar to shell out to,
// so a device world packs its own. Only what the world archive needs:
// regular files, ustar names (a 155-byte prefix and a 100-byte name), sizes
// in octal. Readers anywhere (tar, 7-Zip, Windows' own tar) open the result.

const BLOCK = 512;

function splitName(name: string): { prefix: string; base: string } {
  if (Buffer.byteLength(name) <= 100) {
    return { prefix: "", base: name };
  }
  for (let cut = name.indexOf("/"); cut > 0; cut = name.indexOf("/", cut + 1)) {
    const prefix = name.slice(0, cut);
    const base = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) {
      return { prefix, base };
    }
  }
  throw new Error(`Name too long for the archive: ${name}`);
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const { prefix, base } = splitName(name);
  block.write(base, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(Math.floor(mtime / 1000), 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write("0", 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7), 148, "ascii");
  block[155] = 0x20;
  return block;
}

export type TarEntry = { name: string } & ({ file: string } | { bytes: Buffer });

// Writes the entries, in order, to `target` as .tar.gz. Each file is read as
// it is written, so memory stays flat however large the world.
export async function writeTarGz(target: string, entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): Promise<void> {
  const tar = new PassThrough();
  const done = pipeline(tar, zlib.createGzip({ level: 4 }), fs.createWriteStream(target));
  const push = (chunk: Buffer) =>
    tar.write(chunk) ? Promise.resolve() : new Promise<void>((resolve) => tar.once("drain", () => resolve()));
  try {
    for await (const entry of entries) {
      if ("bytes" in entry) {
        await push(header(entry.name, entry.bytes.length, Date.now()));
        await push(entry.bytes);
        if (entry.bytes.length % BLOCK) await push(Buffer.alloc(BLOCK - (entry.bytes.length % BLOCK)));
        continue;
      }
      const info = await fs.promises.stat(entry.file);
      await push(header(entry.name, info.size, info.mtimeMs));
      let written = 0;
      for await (const chunk of fs.createReadStream(entry.file)) {
        written += chunk.length;
        await push(chunk as Buffer);
      }
      if (written !== info.size) throw new Error(`${entry.name} changed while it was packed.`);
      if (written % BLOCK) await push(Buffer.alloc(BLOCK - (written % BLOCK)));
    }
    await push(Buffer.alloc(BLOCK * 2));
    tar.end();
  } catch (error) {
    tar.destroy(error as Error);
    await done.catch(() => undefined);
    throw error;
  }
  await done;
}

export type TarFile = {
  name: string;
  size: number;
  // The entry's bytes; must be read to the end (or drained) before the next.
  stream: Readable;
};

function readOctal(block: Buffer, start: number, width: number): number {
  const text = block.subarray(start, start + width).toString("ascii").replace(/\0[\s\S]*$/, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("The archive is damaged (a bad size field).");
  return text ? parseInt(text, 8) : 0;
}

function readString(block: Buffer, start: number, width: number): string {
  const raw = block.subarray(start, start + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? width : end).toString("utf8");
}

// Reads a .tar.gz entry by entry. Anything but a regular file is refused:
// the world archive holds no links, folders or devices, so one that does
// was not written by us.
export async function* readTarGz(source: string): AsyncGenerator<TarFile> {
  const input = fs.createReadStream(source).pipe(zlib.createGunzip());
  const reader = input[Symbol.asyncIterator]();
  let buffered: Buffer = Buffer.alloc(0);
  let ended = false;

  async function fill(bytes: number): Promise<boolean> {
    while (buffered.length < bytes && !ended) {
      const next = await reader.next();
      if (next.done) ended = true;
      else buffered = buffered.length ? Buffer.concat([buffered, next.value as Buffer]) : (next.value as Buffer);
    }
    return buffered.length >= bytes;
  }

  try {
    for (;;) {
      if (!(await fill(BLOCK))) throw new Error("The archive ends early.");
      const block = buffered.subarray(0, BLOCK);
      buffered = buffered.subarray(BLOCK);
      if (block.every((byte) => byte === 0)) return;
      let sum = 0;
      for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index];
      if (sum !== readOctal(block, 148, 8)) throw new Error("The archive is damaged (a header checksum does not match).");
      const type = String.fromCharCode(block[156] || 0x30);
      if (type !== "0") throw new Error("The archive holds something other than plain files.");
      const prefix = readString(block, 345, 155);
      const base = readString(block, 0, 100);
      const name = prefix ? `${prefix}/${base}` : base;
      const size = readOctal(block, 124, 12);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      const stream = new PassThrough();
      let left = size;
      const pump = (async () => {
        while (left > 0) {
          if (!(await fill(1))) throw new Error("The archive ends early.");
          const take = Math.min(left, buffered.length);
          const chunk = buffered.subarray(0, take);
          buffered = buffered.subarray(take);
          left -= take;
          if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
        }
        stream.end();
        let skip = padded - size;
        while (skip > 0) {
          if (!(await fill(1))) throw new Error("The archive ends early.");
          const take = Math.min(skip, buffered.length);
          buffered = buffered.subarray(take);
          skip -= take;
        }
      })();
      pump.catch((error) => stream.destroy(error));
      yield { name, size, stream };
      // Whatever the caller left unread is drained before the next header.
      stream.resume();
      await pump;
    }
  } finally {
    input.destroy();
  }
}

// The sha256 of a file, read as a stream.
export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
