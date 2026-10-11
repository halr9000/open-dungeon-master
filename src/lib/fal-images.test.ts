// The fal.ai image backend: request mapping and answer parsing with a mocked
// fetch — the key must go out in fal's "Key" header, the aspect preset must
// land in image_size, and the CDN URL in the answer must be fetched into
// bytes server-side (the client never sees it). vitest drives it; the file
// also runs standalone with node --experimental-strip-types.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

// A scratch database so getGlobalConfig has somewhere to read and save.
const dir = mkdtempSync(path.join(os.tmpdir(), "odm-fal-images-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
for (const key of ["FAL_KEY", "FAL_IMAGE_MODEL"]) {
  delete process.env[key];
}

const { falImageModel, falImagesConfigured, falImageSize, falImageRequest, falResultUrl, generateFalImage } = await import(
  "@/lib/fal-images"
);
const { saveGlobalConfig } = await import("@/lib/db/app-settings");

describe("fal image request mapping", () => {
  it("maps the ODM aspect presets onto fal's image_size at the slow scale", () => {
    expect(falImageSize("portrait", "slow")).toEqual({ width: 1024, height: 1536 });
    expect(falImageSize("landscape", "slow")).toEqual({ width: 1536, height: 1024 });
    expect(falImageSize("square", "slow")).toEqual({ width: 1440, height: 1440 });
  });

  it("the fast dial is smaller, and every preset is a multiple of 8", () => {
    expect(falImageSize("portrait", "fast")).toEqual({ width: 768, height: 1152 });
    for (const aspect of ["square", "portrait", "landscape"] as const) {
      for (const mode of ["fast", "slow"] as const) {
        const { width, height } = falImageSize(aspect, mode);
        expect(width % 8).toBe(0);
        expect(height % 8).toBe(0);
      }
    }
  });

  it("the request body carries prompt, size, one image, and a seed only when given", () => {
    expect(falImageRequest({ prompt: "A knight's shield", mode: "fast", aspect: "square" })).toEqual({
      prompt: "A knight's shield",
      image_size: { width: 1024, height: 1024 },
      num_images: 1,
    });
    expect(falImageRequest({ prompt: "p", mode: "slow", aspect: "portrait", seed: 7 }).seed).toBe(7);
  });
});

describe("fal answer parsing", () => {
  it("the first image URL is found in the standard answer", () => {
    expect(falResultUrl({ images: [{ url: "https://cdn.example/a.webp", content_type: "image/webp" }] })).toBe(
      "https://cdn.example/a.webp",
    );
  });

  it("a wrapped answer is searched, and only an http(s) address counts", () => {
    expect(falResultUrl({ output: { images: [{ url: "https://cdn.example/b.png" }] } })).toBe("https://cdn.example/b.png");
    expect(falResultUrl({ images: [{ filename: "nope" }] })).toBe("");
    expect(falResultUrl({ images: [] })).toBe("");
    expect(falResultUrl(null)).toBe("");
    expect(falResultUrl({ images: [{ url: "data:image/png;base64,AAAA" }] })).toBe("");
  });
});

describe("fal generation against a mocked fetch", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000" + "1f15c48900000000a49444154789c6300010000050001" + "0d0a2db4", "hex");

  beforeEach(() => {
    saveGlobalConfig({ images: { falImageKey: "fal-key-1", falImageModel: "fal-ai/test-model" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    saveGlobalConfig({ images: { falImageKey: "", falImageModel: "" } });
  });

  it("a missing key is a clear configuration failure before any request", async () => {
    saveGlobalConfig({ images: { falImageKey: "" } });
    expect(falImagesConfigured()).toBe(false);
    await expect(generateFalImage({ prompt: "x", mode: "fast", aspect: "square" })).rejects.toThrow(/no API key/);
  });

  it("the key goes out in fal's Key header, at the model's address, with the mapped body", async () => {
    const calls: Array<{ url: string; auth: string; body: unknown }> = [];
    const record = (input: RequestInfo | URL, init?: RequestInit) =>
      calls.push({
        url: String(input),
        auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
    // The API call, then the CDN download, in that order.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        record(input, init);
        return String(input).startsWith("https://fal.run/")
          ? new Response(JSON.stringify({ images: [{ url: "https://cdn.example/pic.png" }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
      }),
    );

    const image = await generateFalImage({ prompt: "A test shield", mode: "fast", aspect: "portrait", seed: 11 });
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://fal.run/fal-ai/test-model");
    expect(calls[0].auth).toBe("Key fal-key-1");
    expect(calls[0].body).toEqual({ prompt: "A test shield", image_size: { width: 768, height: 1152 }, num_images: 1, seed: 11 });
    // The CDN download is a bare GET: no key anywhere on it.
    expect(calls[1].url).toBe("https://cdn.example/pic.png");
    expect(calls[1].auth).toBe("");
    expect(image.backend).toBe("fal");
    expect(image.seed).toBe(11);
    expect(image.width).toBe(768);
    expect(image.height).toBe(1152);
    expect(image.url).toMatch(/^\/generated\//);
  });

  it("an upstream error is repeated as one sentence, never the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "Preset not found for model" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(generateFalImage({ prompt: "x", mode: "fast", aspect: "square" })).rejects.toThrow(
      /fal image generation failed: Preset not found for model/,
    );
  });

  it("a finished answer with no image URL, or a CDN answer that is not a picture, is an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ images: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
    await expect(generateFalImage({ prompt: "x", mode: "fast", aspect: "square" })).rejects.toThrow(/without returning an image URL/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("https://fal.run/")
          ? new Response(JSON.stringify({ images: [{ url: "https://cdn.example/pic.png" }] }), { status: 200 })
          : new Response("<html>no</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      ),
    );
    await expect(generateFalImage({ prompt: "x", mode: "fast", aspect: "square" })).rejects.toThrow(
      /not a PNG, JPEG or WebP picture/,
    );
  });

  it("the model name falls back through admin value, env, then the flux default", async () => {
    saveGlobalConfig({ images: { falImageModel: "" } });
    expect(falImageModel()).toBe("fal-ai/flux/general");
    process.env.FAL_IMAGE_MODEL = "fal-ai/env-model";
    expect(falImageModel()).toBe("fal-ai/env-model");
    saveGlobalConfig({ images: { falImageModel: "fal-ai/db-model" } });
    expect(falImageModel()).toBe("fal-ai/db-model");
    delete process.env.FAL_IMAGE_MODEL;
    saveGlobalConfig({ images: { falImageModel: "" } });
  });
});

rmSync(dir, { recursive: true, force: true });
