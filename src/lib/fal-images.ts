import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configValue, getGlobalConfig } from "@/lib/app-config";
import { sniffImage } from "@/lib/image-format";
import { scheduleImageVariants } from "@/lib/image-variants";
import { serverEnv } from "@/lib/server-env";
import type { AspectPreset, GeneratedImage, ImageMode } from "@/lib/types";

// The fal.ai image backend: fal's own REST API, a different wire format from
// the OpenAI images API. One POST to https://fal.run/<model> with the model's
// JSON input carries the whole request; the sync answer carries CDN URLs, and
// the picture behind images[0].url is fetched server-side into bytes, so the
// key never reaches a client and a table never sees a signed CDN address.
// The queue variant (queue.fal.run) is for long jobs; portraits and maps are
// short enough that sync fal.run answers directly.
//
// Every fal image model takes a prompt and an image_size (a preset string or
// a width/height object — the custom object is what keeps ODM's aspect
// presets exact); the rest of each model's input is its own business.

const DEFAULT_FAL_IMAGE_MODEL = "fal-ai/flux/general";
const FAL_RUN_BASE = "https://fal.run";
const GENERATE_TIMEOUT_MS = 4 * 60 * 1000;
// Far past any picture these models return, and small enough that a CDN
// address cannot fill the server's disk through the URL it hands back.
const MAX_PICTURE_BYTES = 32 * 1024 * 1024;

// The model asked for: the admin value, then the FAL_IMAGE_MODEL env var,
// then the default. Same resolution order as every other config field.
export function falImageModel(): string {
  return configValue(getGlobalConfig().images.falImageModel, "FAL_IMAGE_MODEL", DEFAULT_FAL_IMAGE_MODEL);
}

// The server's fal key, from the admin panel then the env.
export function falImageKey(): string {
  return getGlobalConfig().images.falImageKey.trim() || serverEnv("FAL_KEY");
}

// Whether picking the "fal" backend can actually produce anything. The
// dispatcher checks this before enqueueing, so a backend selected without a
// key degrades to "request recorded" like the FLUX backends do.
export function falImagesConfigured(): boolean {
  return falImageKey() !== "";
}

// ODM's aspect presets onto fal's width/height, at the same scale the other
// backends paint portraits and maps at.
export function falImageSize(aspect: AspectPreset, mode: ImageMode): { width: number; height: number } {
  if (aspect === "portrait") {
    return mode === "slow" ? { width: 1024, height: 1536 } : { width: 768, height: 1152 };
  }
  if (aspect === "landscape") {
    return mode === "slow" ? { width: 1536, height: 1024 } : { width: 1152, height: 768 };
  }
  return mode === "slow" ? { width: 1440, height: 1440 } : { width: 1024, height: 1024 };
}

// The JSON body one fal model call carries. Exported pure so the unit test
// can assert the mapping without a network.
export function falImageRequest(options: { prompt: string; mode: ImageMode; aspect: AspectPreset; seed?: number }): Record<string, unknown> {
  const { width, height } = falImageSize(options.aspect, options.mode);
  return {
    prompt: options.prompt,
    image_size: { width, height },
    num_images: 1,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
}

// The first CDN URL in a sync answer. Some models wrap theirs in extra layers
// (an output object, or a video's own envelope), so anything shaped like a
// media list is searched, and only a real http(s) address is accepted.
export function falResultUrl(payload: unknown): string {
  const stack: unknown[] = [payload];
  while (stack.length) {
    const node = stack.shift();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") {
      continue;
    }
    const record = node as Record<string, unknown>;
    for (const key of ["images", "image", "videos", "video", "audio", "output"]) {
      if (key in record) {
        stack.push(record[key]);
      }
    }
    const url = record.url;
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      return url;
    }
  }
  return "";
}

function promptSlug(prompt: string) {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "image"
  );
}

// The picture behind the CDN address, read under a ceiling instead of
// buffered whole.
async function downloadPicture(url: string): Promise<Buffer> {
  const download = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!download.ok || !download.body) {
    throw new Error(`The fal CDN would not return the finished image (HTTP ${download.status}).`);
  }
  const tooLarge = new Error("The fal CDN pointed at a file too large to be a picture.");
  if (Number(download.headers.get("content-length") ?? 0) > MAX_PICTURE_BYTES) {
    await download.body.cancel();
    throw tooLarge;
  }
  const reader = download.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_PICTURE_BYTES) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// One fal error sentence, from either of the shapes the API answers with
// (a top-level { detail }, or OpenAI-style { error: { message } }).
function falErrorDetail(payload: unknown, status: number): string {
  const record = (payload ?? {}) as { detail?: unknown; error?: unknown };
  const found =
    typeof record.detail === "string"
      ? record.detail
      : record.detail && typeof record.detail === "object"
        ? (record.detail as Array<{ msg?: unknown; loc?: unknown[] }>).map?.((entry) => `${(entry.loc ?? []).join(".")} ${entry.msg ?? ""}`.trim()).join("; ")
        : typeof record.error === "object" && record.error
          ? (record.error as { message?: unknown }).message
          : record.error;
  const text = typeof found === "string" ? found : found !== undefined ? JSON.stringify(found) : "";
  return text ? text.slice(0, 300) : `the API answered ${status}`;
}

// One picture from fal.ai, saved exactly like the other backends save theirs.
export async function generateFalImage(options: {
  prompt: string;
  mode: ImageMode;
  aspect: AspectPreset;
  seed?: number;
  hasReferences?: boolean;
}): Promise<GeneratedImage> {
  const apiKey = falImageKey();
  if (!apiKey) {
    throw new Error("The fal.ai image backend has no API key. Add one in Admin > Image generation (or set FAL_KEY).");
  }
  const model = falImageModel();
  const startedAt = Date.now();
  const seed = options.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const { width, height } = falImageSize(options.aspect, options.mode);

  let payload: unknown;
  try {
    const response = await fetch(`${FAL_RUN_BASE}/${model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // fal's REST header spells it "Key", not "Bearer".
        Authorization: `Key ${apiKey}`,
      },
      body: JSON.stringify(falImageRequest({ ...options, seed })),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`fal image generation failed: ${falErrorDetail(payload, response.status)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The fal image API timed out.");
    }
    if (error instanceof Error && error.message.startsWith("fal image")) {
      throw error;
    }
    throw new Error(`Could not reach the fal image API at ${FAL_RUN_BASE}.`);
  }

  const url = falResultUrl(payload);
  if (!url) {
    throw new Error("The fal image API finished without returning an image URL.");
  }
  const bytes = await downloadPicture(url);
  // Whatever came back is about to be saved where every table can load it,
  // so it has to be a picture: a CDN address that hands back a web page gets
  // an error, not a place in public/generated.
  const kind = sniffImage(bytes);
  if (!kind) {
    throw new Error("The fal image API returned something that is not a PNG, JPEG or WebP picture.");
  }

  const generatedDir = path.join(process.cwd(), "public", "generated");
  mkdirSync(generatedDir, { recursive: true });
  const filename = `${Date.now()}-${seed}-fal-${promptSlug(options.prompt)}.${kind.ext}`;
  const saved = path.join(generatedDir, filename);
  writeFileSync(saved, bytes);
  scheduleImageVariants(saved);

  return {
    id: crypto.randomUUID(),
    url: `/generated/${filename}`,
    prompt: options.prompt,
    mode: options.mode,
    backend: "fal",
    aspect: options.aspect,
    width,
    height,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    seed,
    warnings: options.hasReferences ? ["Character reference images are not used by the fal.ai backend."] : undefined,
  };
}
