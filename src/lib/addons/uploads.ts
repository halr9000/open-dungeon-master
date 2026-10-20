import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { incomingDir, isServerId } from "@/lib/addons/paths";

// Files on their way to an addon (a rulebook PDF is often 100 MB or more),
// sent in pieces. Every request passes the proxy, which holds a body in
// memory up to its cap and cuts anything longer without an error (next.config
// proxyClientMaxBodySize), so a large file arrives as a series of chunks well
// under it, each appended at the offset it claims, and is only handed on
// once every byte is there.

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_ADDON_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_LIFETIME_MS = 60 * 60_000;

export type PendingUpload = {
  id: string;
  userId: string;
  name: string;
  mime: string;
  size: number;
  received: number;
  createdAt: number;
  // A piece is being written; a second one at the same time is refused.
  writing?: boolean;
};

declare global {
  var __odmAddonUploads: Map<string, PendingUpload> | undefined;
}

function uploads(): Map<string, PendingUpload> {
  return (globalThis.__odmAddonUploads ??= new Map());
}

function partPath(id: string): string {
  return path.join(incomingDir(), `${id}.part`);
}

async function expire(now = Date.now()) {
  for (const upload of [...uploads().values()]) {
    if (now - upload.createdAt > UPLOAD_LIFETIME_MS) {
      uploads().delete(upload.id);
      await rm(partPath(upload.id), { force: true }).catch(() => undefined);
    }
  }
}

// A name safe to put on disk and to show: the last path segment, plain
// characters, the extension kept.
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9 _.()-]+/g, "_").replace(/^\.+/, "").trim().slice(-120);
  return cleaned || "upload";
}

export async function beginUpload(input: { userId: string; name: string; mime: string; size: number }): Promise<PendingUpload> {
  await expire();
  const upload: PendingUpload = {
    id: crypto.randomUUID(),
    userId: input.userId,
    name: cleanFileName(input.name),
    mime: input.mime.slice(0, 120),
    size: input.size,
    received: 0,
    createdAt: Date.now(),
  };
  await mkdir(incomingDir(), { recursive: true });
  uploads().set(upload.id, upload);
  return upload;
}

export function uploadFor(id: string, userId: string): PendingUpload | null {
  if (!isServerId(id)) return null;
  const upload = uploads().get(id);
  return upload && upload.userId === userId ? upload : null;
}

export async function appendChunk(
  upload: PendingUpload,
  offset: number,
  bytes: Uint8Array,
): Promise<{ ok: true; received: number } | { ok: false; status: number; error: string }> {
  if (offset !== upload.received) {
    return { ok: false, status: 409, error: `Expected the piece at ${upload.received}, got ${offset}.` };
  }
  if (bytes.length === 0 || bytes.length > UPLOAD_CHUNK_BYTES) {
    return { ok: false, status: 413, error: `Send pieces of 1 to ${UPLOAD_CHUNK_BYTES} bytes.` };
  }
  if (upload.received + bytes.length > upload.size) {
    return { ok: false, status: 400, error: "That is more than the file's declared size." };
  }
  if (upload.writing) {
    return { ok: false, status: 409, error: "The previous piece is still being written." };
  }
  upload.writing = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(partPath(upload.id), { flags: "a" });
      stream.on("error", reject);
      stream.end(Buffer.from(bytes), () => resolve());
    });
    upload.received += bytes.length;
  } finally {
    upload.writing = false;
  }
  return { ok: true, received: upload.received };
}

// Moves a finished upload into a task's input folder and forgets it.
export async function claimUpload(upload: PendingUpload, intoDir: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (upload.received !== upload.size) {
    return { ok: false, error: "That file has not finished uploading." };
  }
  const source = partPath(upload.id);
  const info = await stat(source).catch(() => null);
  if (!info || info.size !== upload.size) {
    return { ok: false, error: "That upload is incomplete. Send it again." };
  }
  const target = path.join(intoDir, upload.name);
  await rename(source, target);
  uploads().delete(upload.id);
  return { ok: true, path: target };
}
