import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configValue, getGlobalConfig } from "@/lib/app-config";
import { sniffImage } from "@/lib/image-format";
import { scheduleImageVariants } from "@/lib/image-variants";
import {
  Z_IMAGE_SLOTS,
  pickZImageFiles,
  readComfyFiles,
  zImageMissing,
  type ZImageFiles,
  type ZImageSlot,
} from "@/lib/setup/discovery-logic";
import type { AspectPreset, GeneratedImage, ImageMode } from "@/lib/types";
import { recordMediaFile } from "@/lib/media-access";

// First-party ComfyUI backend: the app submits a plain text-to-image workflow
// over ComfyUI's HTTP API and saves the result exactly like the FLUX worker
// does. Any running ComfyUI instance works: the admin picks a checkpoint, or
// Z-Image Turbo, whose three files are found in that ComfyUI's own lists.

const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";
const STATUS_TIMEOUT_MS = 4_000;
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 750;
const STEPS = 25;
const CFG = 6.0;
const NEGATIVE_PROMPT =
  "text, watermark, signature, low quality, jpeg artifacts, deformed hands, extra fingers";
// Krea2-class checkpoints (and other UNET-file models like Flux.2 Klein) are
// not full checkpoints: the diffusion weights, text encoder and VAE load
// through three separate nodes, the negative prompt goes through
// ConditioningZeroOut (cfg 1 distilled sampling), and the model needs far
// fewer steps than an SD-class checkpoint. The user picks the unet file; the
// encoder/VAE names come from each loader's own dropdown, so no filenames
// are hardcoded here.
const KREA_STEPS = 8;
const KREA_CFG = 1.0;
const KREA_CLIP_MATCH = /qwen/i;
const KREA_VAE_MATCH = /qwen_image_vae|flux2-vae/i;
// The model dropdown merges plain checkpoints with unet-file models, and a
// generic loader can't tell them apart by name alone; a picker entry only
// counts as a unet file when the server's own UNETLoader dropdown has it.
function isUnetFile(checkpoint: string, unets: readonly string[]): boolean {
  return unets.includes(checkpoint);
}
// Checkpoint-friendly ceiling: SDXL models train at 1024 and degrade past
// ~1.5K on the long side, unlike the FLUX backends' 2048 slow mode.
const LONG_SIDE = { fast: 1024, slow: 1344 } as const;
// Ceilings on what the server reads back. A 1344px PNG is a few MB; the
// JSON answers (status, checkpoint list, history) are kilobytes.
export const MAX_COMFY_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_COMFY_JSON_BYTES = 4 * 1024 * 1024;

export function resolveComfyUrl(raw: string | undefined): string {
  return (
    (raw || "").trim().replace(/\/+$/, "") ||
    configValue(getGlobalConfig().images.comfyUrl, "COMFYUI_URL", DEFAULT_COMFY_URL).replace(
      /\/+$/,
      "",
    )
  );
}

function timeoutSignal(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(id) };
}

// SECURITY: the ComfyUI URL can be a campaign's own setting, so whatever
// answers there is not trusted. Its answers are never followed elsewhere,
// never read past a ceiling, and never published unless they are a picture:
// otherwise a server that speaks just enough of the protocol could redirect
// the final download to an internal address and have the response saved
// under /generated for anyone to read.
class ComfyRefusal extends Error {}

// ComfyUI's API never redirects, so a redirect means whatever is at this
// URL is steering the server's request somewhere else; it is refused rather
// than followed.
async function comfyFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ComfyRefusal("ComfyUI answered with a redirect, which ComfyUI never sends. Check the URL.");
  }
  return response;
}

// The body, refused once it passes `max` bytes, whether declared up front
// or discovered while streaming.
async function readCapped(response: Response, max: number): Promise<Buffer> {
  const tooLarge = () => new ComfyRefusal(`ComfyUI sent more than ${Math.round(max / 1024 / 1024)}MB, which is not a ComfyUI answer.`);
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(response: Response): Promise<T> {
  return JSON.parse((await readCapped(response, MAX_COMFY_JSON_BYTES)).toString("utf8")) as T;
}

export type ComfyStatus = {
  ok: boolean;
  error?: string;
  checkpoints: string[];
  // Model picker entries for UNET-file models (Krea2, Flux.2 Klein): the
  // diffusion weights load separately from the encoder and VAE, so they are
  // listed here instead of the CheckpointLoaderSimple dropdown.
  unets?: string[];
  // First-choice encoder/VAE for the selected unet, from the server's own
  // dropdowns; empty when the server has none.
  clipName?: string;
  vaeName?: string;
  // The Z-Image Turbo files this ComfyUI has, "" for each one it lacks.
  zImage: ZImageFiles;
};

const NO_Z_IMAGE: ZImageFiles = { unet: "", clip: "", vae: "" };

// A loader's file list, or none when ComfyUI does not know the node or its
// answer is not JSON. A redirect or a flood still refuses the whole check.
async function readFileList(response: Response, node: string, input: string): Promise<string[]> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return [];
  }
  try {
    return readComfyFiles(await readJson<unknown>(response), node, input);
  } catch (error) {
    if (error instanceof ComfyRefusal) {
      throw error;
    }
    return [];
  }
}

// One call powers the Images panel: reachability, the model lists the
// checkpoint, unet, clip and VAE loaders each declare, and the Z-Image
// Turbo files from the three loaders that workflow uses.
export async function comfyStatus(rawUrl: string | undefined): Promise<ComfyStatus> {
  const url = resolveComfyUrl(rawUrl);
  const timeout = timeoutSignal(STATUS_TIMEOUT_MS);
  const slots = Object.keys(Z_IMAGE_SLOTS) as ZImageSlot[];

  try {
    // One object_info call per loader node, de-duplicated: the Z-Image Turbo
    // slots load through the same UNET/CLIP/VAE loaders the Krea discovery
    // reads, so both features share the answers.
    const nodeNames = [
      ...new Set([
        "CheckpointLoaderSimple",
        "UNETLoader",
        "CLIPLoader",
        "VAELoader",
        ...slots.map((slot) => Z_IMAGE_SLOTS[slot].node),
      ]),
    ];
    const [stats, ...infoResponses] = await Promise.all([
      comfyFetch(`${url}/system_stats`, { cache: "no-store", signal: timeout.signal }),
      ...nodeNames.map((node) => comfyFetch(`${url}/object_info/${node}`, { cache: "no-store", signal: timeout.signal })),
    ]);
    if (!stats.ok) {
      await Promise.all(infoResponses.map((response) => response.body?.cancel().catch(() => {})));
      return { ok: false, error: `ComfyUI answered ${stats.status}.`, checkpoints: [], zImage: NO_Z_IMAGE };
    }
    const parsedLists = new Map<string, string[]>();
    const list = (node: string, input: string): string[] => {
      const index = nodeNames.indexOf(node);
      if (index < 0) {
        return [];
      }
      const key = `${node}:${input}`;
      let files = parsedLists.get(key);
      if (!files) {
        files = readFileList(infoResponses[index], node, input);
        parsedLists.set(key, files);
      }
      return files;
    };

    const checkpoints = list("CheckpointLoaderSimple", "ckpt_name");
    const unets = list("UNETLoader", "unet_name");
    const clips = list("CLIPLoader", "clip_name");
    const vaes = list("VAELoader", "vae_name");
    const zImage = pickZImageFiles({
      unet: list(Z_IMAGE_SLOTS.unet.node, Z_IMAGE_SLOTS.unet.input),
      clip: list(Z_IMAGE_SLOTS.clip.node, Z_IMAGE_SLOTS.clip.input),
      vae: list(Z_IMAGE_SLOTS.vae.node, Z_IMAGE_SLOTS.vae.input),
    });

    // The pick-one-list the panel shows: unet-file models first (what this
    // server is set up to run), then plain checkpoints. The Krea/Flux
    // encoder and VAE defaults come from these same dropdowns.
    const status: ComfyStatus = { ok: true, checkpoints: [...unets, ...checkpoints], unets, zImage };
    const clip = clips.find((name) => KREA_CLIP_MATCH.test(name));
    const vae = vaes.find((name) => KREA_VAE_MATCH.test(name));
    if (clip) status.clipName = clip;
    if (vae) status.vaeName = vae;
    return status;
  } catch (error) {
    if (error instanceof ComfyRefusal) {
      return { ok: false, error: error.message, checkpoints: [], zImage: NO_Z_IMAGE };
    }
    return {
      ok: false,
      error: `Could not reach ComfyUI at ${url}. Start ComfyUI and check the URL.`,
      checkpoints: [],
      zImage: NO_Z_IMAGE,
    };
  } finally {
    timeout.clear();
  }
}

function comfyDimensions(mode: ImageMode, aspect: AspectPreset) {
  const longSide = LONG_SIDE[mode];
  const shortSide = Math.round((longSide * 0.75) / 8) * 8;

  if (aspect === "portrait") {
    return { width: shortSide, height: longSide };
  }
  if (aspect === "landscape") {
    return { width: longSide, height: shortSide };
  }
  return { width: longSide, height: longSide };
}

export function buildCheckpointWorkflow(options: {
  checkpoint: string;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  // Extra negatives from the table's boundary (safety-logic.ts).
  negative?: string;
  // Krea2-class graph inputs: unet-file models load their diffusion weights,
  // encoder and VAE through three nodes instead of one checkpoint loader.
  clipName?: string;
  vaeName?: string;
  unets: readonly string[];
}) {
  if (isUnetFile(options.checkpoint, options.unets) && options.clipName && options.vaeName) {
    // Distilled unet-file graph: cfg 1 with a zeroed negative (the text
    // encoder still sees the positive prompt; zeroing just removes the
    // classifier-free branch, which these models are trained without).
    return {
      "1": {
        class_type: "UNETLoader",
        inputs: { unet_name: options.checkpoint, weight_dtype: "default" },
      },
      "2": {
        class_type: "CLIPLoader",
        inputs: { clip_name: options.clipName, type: "krea2", device: "default" },
      },
      "3": {
        class_type: "VAELoader",
        inputs: { vae_name: options.vaeName },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: { text: options.prompt, clip: ["2", 0] },
      },
      "5": {
        class_type: "ConditioningZeroOut",
        inputs: { conditioning: ["4", 0] },
      },
      "6": {
        class_type: "EmptyLatentImage",
        inputs: { width: options.width, height: options.height, batch_size: 1 },
      },
      "7": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0],
          positive: ["4", 0],
          negative: ["5", 0],
          latent_image: ["6", 0],
          seed: options.seed,
          steps: KREA_STEPS,
          cfg: KREA_CFG,
          sampler_name: "euler",
          scheduler: "simple",
          denoise: 1,
        },
      },
      "8": {
        class_type: "VAEDecode",
        inputs: { samples: ["7", 0], vae: ["3", 0] },
      },
      "9": {
        class_type: "SaveImage",
        inputs: { images: ["8", 0], filename_prefix: "open-dungeon" },
      },
    };
  }
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: options.checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: options.prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: options.negative ? `${NEGATIVE_PROMPT}, ${options.negative}` : NEGATIVE_PROMPT, clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: options.width, height: options.height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
        seed: options.seed,
        steps: STEPS,
        cfg: CFG,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "open-dungeon" },
    },
  };
}

// The Z-Image Turbo graph from the supplied ComfyUI API workflow. Only the
// positive text, latent dimensions, and seed vary between generations, and
// the three file names, which come from this ComfyUI's own lists (comfyStatus).
//
// It runs at CFG 1 with a zeroed negative, so a table boundary's picture
// negatives have nowhere to go. They are not folded into the prompt either:
// "Leave out: blood, wounds" in a positive prompt paints blood and wounds.
export function buildZTurboWorkflow(options: {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  files: ZImageFiles;
}) {
  return {
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "z-image-turbo", images: ["57:8", 0] },
      _meta: { title: "Save Image" },
    },
    "57:30": {
      class_type: "CLIPLoader",
      inputs: { clip_name: options.files.clip, type: "lumina2", device: "default" },
      _meta: { title: "Load CLIP" },
    },
    "57:29": {
      class_type: "VAELoader",
      inputs: { vae_name: options.files.vae },
      _meta: { title: "Load VAE" },
    },
    "57:33": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["57:27", 0] },
      _meta: { title: "Conditioning Zero Out" },
    },
    "57:8": {
      class_type: "VAEDecode",
      inputs: { samples: ["57:3", 0], vae: ["57:29", 0] },
      _meta: { title: "VAE Decode" },
    },
    "57:28": {
      class_type: "UNETLoader",
      inputs: { unet_name: options.files.unet, weight_dtype: "default" },
      _meta: { title: "Load Diffusion Model" },
    },
    "57:27": {
      class_type: "CLIPTextEncode",
      inputs: { text: options.prompt, clip: ["57:30", 0] },
      _meta: { title: "CLIP Text Encode (Prompt)" },
    },
    "57:13": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: options.width, height: options.height, batch_size: 1 },
      _meta: { title: "EmptySD3LatentImage" },
    },
    "57:11": {
      class_type: "ModelSamplingAuraFlow",
      inputs: { shift: 3, sampling: "flow", model: ["57:28", 0] },
      _meta: { title: "ModelSamplingAuraFlow" },
    },
    "57:3": {
      class_type: "KSampler",
      inputs: {
        seed: options.seed,
        steps: 8,
        cfg: 1,
        sampler_name: "res_multistep",
        scheduler: "beta",
        denoise: 1,
        model: ["57:11", 0],
        positive: ["57:27", 0],
        negative: ["57:33", 0],
        latent_image: ["57:13", 0],
      },
      _meta: { title: "KSampler" },
    },
  };
}

type HistoryEntry = {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }>;
};

function promptSlug(prompt: string) {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "image"
  );
}

export async function generateComfyImage(options: {
  url?: string;
  checkpoint?: string;
  prompt: string;
  mode: ImageMode;
  aspect: AspectPreset;
  seed?: number;
  hasReferences?: boolean;
  negative?: string;
  // Krea2-class encoder/VAE overrides, discovered from the server when blank.
  clipName?: string;
  vaeName?: string;
}): Promise<GeneratedImage> {
  const url = resolveComfyUrl(options.url);
  const startedAt = Date.now();
  const deadline = startedAt + GENERATE_TIMEOUT_MS;

  const preset = getGlobalConfig().images.comfyWorkflowPreset;
  // The status also carries the unet-file list and the Krea encoder/VAE
  // defaults, so a checkpoint generation reads it even with a checkpoint set.
  const status = await comfyStatus(url);
  if (!status.ok) {
    throw new Error(status.error || `Could not reach ComfyUI at ${url}.`);
  }
  let checkpoint = (options.checkpoint || "").trim();
  if (preset !== "z_turbo" && !checkpoint) {
    checkpoint = status.checkpoints[0] || "";
    if (!checkpoint) {
      throw new Error(
        "ComfyUI has no models installed. Put a checkpoint or unet file in ComfyUI's models folders and refresh.",
      );
    }
  }
  let zImage = NO_Z_IMAGE;
  if (preset === "z_turbo") {
    // The files this ComfyUI has, whatever precision it downloaded; a
    // missing one is named here rather than in ComfyUI's validation error.
    const missing = zImageMissing(status.zImage);
    if (missing.length) {
      throw new Error(`ComfyUI is missing ${missing.join(", ")} for Z-Image Turbo. Add it, or pick a checkpoint in Admin > Images.`);
    }
    zImage = status.zImage;
  }
  // The clip/vae defaults come from the same discovery pass, so a Krea-class
  // graph is only built when the server actually has the encoder and VAE.
  const clipName = options.clipName?.trim() || status.clipName || "";
  const vaeName = options.vaeName?.trim() || status.vaeName || "";

  const seed = options.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const { width, height } = comfyDimensions(options.mode, options.aspect);
  const workflow = preset === "z_turbo"
    ? buildZTurboWorkflow({ prompt: options.prompt, width, height, seed, files: zImage })
    : buildCheckpointWorkflow({
        checkpoint,
        prompt: options.prompt,
        width,
        height,
        seed,
        negative: options.negative,
        clipName,
        vaeName,
        unets: status.unets ?? [],
      });

  const submitTimeout = timeoutSignal(STATUS_TIMEOUT_MS * 2);
  let promptId = "";
  try {
    const submitted = await comfyFetch(`${url}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
      signal: submitTimeout.signal,
    });
    if (!submitted.ok) {
      const detail = (await readCapped(submitted, MAX_COMFY_JSON_BYTES)).toString("utf8").slice(0, 500);
      throw new Error(`ComfyUI rejected the workflow (${submitted.status}): ${detail}`);
    }
    const payload = await readJson<{ prompt_id?: string }>(submitted);
    promptId = payload.prompt_id || "";
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith("ComfyUI")) {
      throw new Error(`Could not reach ComfyUI at ${url}. Start ComfyUI and check the URL.`);
    }
    throw error;
  } finally {
    submitTimeout.clear();
  }

  if (!promptId) {
    throw new Error("ComfyUI did not return a prompt id.");
  }

  // Poll history until the job finishes; ComfyUI queues serially, so this can
  // legitimately wait behind other generations.
  let entry: HistoryEntry | undefined;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("ComfyUI generation timed out. Check the ComfyUI queue and try again.");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const historyTimeout = timeoutSignal(STATUS_TIMEOUT_MS);
    try {
      const history = await comfyFetch(`${url}/history/${promptId}`, {
        cache: "no-store",
        signal: historyTimeout.signal,
      });
      if (!history.ok) {
        await history.body?.cancel().catch(() => {});
        continue;
      }
      const payload = await readJson<Record<string, HistoryEntry>>(history);
      entry = payload[promptId];
    } catch (error) {
      // A slow or briefly unreachable ComfyUI is polled again; one that
      // redirects or floods is not going to start behaving.
      if (error instanceof ComfyRefusal) {
        throw error;
      }
      continue;
    } finally {
      historyTimeout.clear();
    }

    if (!entry) {
      continue;
    }
    if (entry.status?.status_str === "error") {
      throw new Error(
        "ComfyUI failed to run the workflow. Check the ComfyUI console: it is usually a missing model file or out-of-memory.",
      );
    }
    const images = Object.values(entry.outputs || {}).flatMap((output) => output.images || []);
    if (images.length) {
      break;
    }
    if (entry.status?.completed) {
      throw new Error("ComfyUI finished without producing an image.");
    }
  }

  const image = Object.values(entry!.outputs || {})
    .flatMap((output) => output.images || [])
    .find((candidate) => candidate.filename);
  if (!image?.filename) {
    throw new Error("ComfyUI finished without producing an image.");
  }

  const viewTimeout = timeoutSignal(STATUS_TIMEOUT_MS * 4);
  let bytes: Buffer;
  try {
    const view = await comfyFetch(
      `${url}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=${encodeURIComponent(image.type || "output")}`,
      { cache: "no-store", signal: viewTimeout.signal },
    );
    if (!view.ok) {
      await view.body?.cancel().catch(() => {});
      throw new Error(`ComfyUI would not return the finished image (${view.status}).`);
    }
    bytes = await readCapped(view, MAX_COMFY_IMAGE_BYTES);
  } finally {
    viewTimeout.clear();
  }
  // Only a picture is published, and under the name of what it really is.
  const kind = sniffImage(bytes);
  if (!kind) {
    throw new Error("ComfyUI returned something that is not a PNG, JPEG or WebP image.");
  }

  const generatedDir = path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "generated");
  mkdirSync(generatedDir, { recursive: true });
  const filename = `${Date.now()}-${seed}-comfyui-${promptSlug(options.prompt)}.${kind.ext}`;
  const saved = path.join(/*turbopackIgnore: true*/ generatedDir, filename);
  writeFileSync(saved, bytes);
  // The smaller WebP copies the table draws, written after the fact; the
  // original is what the campaign stores and what a client without them gets.
  scheduleImageVariants(saved);

  recordMediaFile(`/generated/${filename}`);
  return {
    id: crypto.randomUUID(),
    url: `/generated/${filename}`,
    prompt: options.prompt,
    mode: options.mode,
    backend: "comfyui",
    aspect: options.aspect,
    width,
    height,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    seed,
    warnings: options.hasReferences
      ? ["Character reference images are not used by the ComfyUI backend."]
      : undefined,
  };
}
