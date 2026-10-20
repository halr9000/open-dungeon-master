import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

// A large file fetched straight to disk: https on every hop (redirects are
// followed by hand, as the catalog fetch does), never more than the size it
// was declared at, and its SHA-256 taken on the way through, so a setup
// download (a model, a portable Blender) is checked before it is used and
// never held in memory whole.

const MAX_REDIRECTS = 5;
const QUIET_MS = 60_000;

export type DownloadResult = { ok: true; sha256: string; bytes: number } | { ok: false; error: string };

export async function downloadToFile(
  url: string,
  target: string,
  options: {
    bytes: number;
    sha256: string;
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
    headers?: Record<string, string>;
  },
): Promise<DownloadResult> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { ok: false, error: "That is not a valid address." };
  }
  if (current.protocol !== "https:") return { ok: false, error: "Downloads must be https." };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let quiet: ReturnType<typeof setTimeout> | null = null;
  const armQuiet = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(abort, QUIET_MS);
  };
  await mkdir(path.dirname(target), { recursive: true });
  try {
    armQuiet();
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      response = await fetch(current, { signal: controller.signal, redirect: "manual", headers: options.headers });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) break;
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) return { ok: false, error: "The address redirected too many times." };
      const next = new URL(location, current);
      if (next.protocol !== "https:") return { ok: false, error: "The download redirected somewhere that is not https." };
      current = next;
    }
    if (!response.ok || !response.body) return { ok: false, error: `The host answered ${response.status}.` };
    const hash = createHash("sha256");
    const out = createWriteStream(target);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armQuiet();
        received += value.byteLength;
        if (received > options.bytes) {
          await reader.cancel();
          return { ok: false, error: `The file is larger than the ${options.bytes} bytes it was declared at.` };
        }
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
        options.onProgress?.(received, options.bytes);
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
    const sha256 = hash.digest("hex");
    if (received !== options.bytes) return { ok: false, error: `The file was ${received} bytes; it was declared at ${options.bytes}.` };
    if (sha256 !== options.sha256) return { ok: false, error: "The file's checksum does not match the one declared for it." };
    return { ok: true, sha256, bytes: received };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: options.signal?.aborted ? "Cancelled." : "The download stalled for a minute and was stopped." };
    }
    return { ok: false, error: `Could not download it: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (quiet) clearTimeout(quiet);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function removeQuietly(file: string): Promise<void> {
  await rm(file, { force: true, recursive: true }).catch(() => undefined);
}
