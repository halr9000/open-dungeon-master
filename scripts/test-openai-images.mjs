// Which key the OpenAI images backend spends, and which keys it refuses to.
//
// A bring-your-own-key table pastes one OpenAI key into its story's Text
// Model panel; images are a second API on that same account, so the picture
// path borrows it rather than asking for it twice. The borrow is gated on the
// host, and that gate is the whole safety property: a key minted for
// llama.cpp, LM Studio or OpenRouter must never be posted to api.openai.com.
//
// Local image generation is not touched by any of this — ComfyUI stays ready
// with no key at all, once it has a checkpoint — so that is asserted too.
// Neither backend is ready without a model: none is named in code.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-openai-images-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
// A developer's own shell must not decide the result of these assertions.
for (const name of [
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_API_KEY",
  "OPENAI_IMAGE_BASE_URL",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_BASE_URL",
]) {
  delete process.env[name];
}

register("./lib/register-alias.mjs", import.meta.url);

const { generateOpenAiImage, openAiImagesConfigured } = await import("../src/lib/openai-images.ts");
const { pickImageSize, readSupportedSizes } = await import("../src/lib/openai-image-size-logic.ts");
const { imageProducerReady } = await import("../src/lib/image-generate.ts");
const { saveGlobalConfig } = await import("../src/lib/db/app-settings.ts");
const { imagesAvailable } = await import("../src/lib/capabilities.ts");
const { maskStorySettings } = await import("../src/lib/db/settings.ts");
const { DEFAULT_STORY_SETTINGS } = await import("../src/lib/defaults.ts");
const { imageVariantsSettled } = await import("../src/lib/image-variants.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
}

const story = (imageBackend, customBaseUrl, customApiKey) => ({
  imageBackend,
  customBaseUrl,
  customApiKey,
});

test("with nothing configured the OpenAI backend has no producer", () => {
  assert.equal(openAiImagesConfigured(), false);
  assert.equal(imageProducerReady(story("openai", "", "")), false);
});

test("a key without a model is no producer either: no model is named in code", () => {
  assert.equal(imageProducerReady(story("openai", "https://api.openai.com/v1", "sk-test")), false);
  // The checks below are about whose key is spent, so a model is picked.
  saveGlobalConfig({ images: { openaiModel: "my-painter" } });
  assert.equal(imageProducerReady(story("openai", "https://api.openai.com/v1", "sk-test")), true);
});

test("ComfyUI is ready without any key once a checkpoint is picked", () => {
  assert.equal(imageProducerReady({ ...story("comfyui", "", ""), comfyCheckpoint: "any.safetensors" }), true);
  assert.equal(imageProducerReady({ ...story("comfyui", "", ""), comfyCheckpoint: "" }), false, "no checkpoint and no catalog model");
  // The FLUX workers still have no producer here; their own process drives them.
  assert.equal(imageProducerReady(story("mflux-hs", "", "")), false);
  assert.equal(imageProducerReady(story("sdnq-hs", "", "")), false);
});

test("a story whose text model IS OpenAI lends its key to the pictures", () => {
  assert.equal(
    imageProducerReady(story("openai", "https://api.openai.com/v1", "sk-test")),
    true,
  );
});

test("a key for anything that is not OpenAI is never borrowed", () => {
  for (const url of [
    "http://127.0.0.1:8001/v1",
    "https://openrouter.ai/api/v1",
    "https://api.openai.com.evil.example/v1",
    "https://example.com/openai.com/v1",
    "",
  ]) {
    assert.equal(
      imageProducerReady(story("openai", url, "sk-test")),
      false,
      `${url || "(blank)"} lent its key to OpenAI`,
    );
  }
});

test("a subdomain of openai.com still counts as OpenAI", () => {
  assert.equal(
    imageProducerReady(story("openai", "https://eu.api.openai.com/v1", "sk-test")),
    true,
  );
});

test("a blank key on an OpenAI backend lends nothing", () => {
  assert.equal(imageProducerReady(story("openai", "https://api.openai.com/v1", "   ")), false);
});

test("the server-wide text backend lends its key too, on the same gate", () => {
  saveGlobalConfig({ text: { customBaseUrl: "http://127.0.0.1:8001/v1", customApiKey: "sk-local" } });
  assert.equal(openAiImagesConfigured(), false, "a local server's key reached OpenAI");

  saveGlobalConfig({ text: { customBaseUrl: "https://api.openai.com/v1", customApiKey: "sk-admin" } });
  assert.equal(openAiImagesConfigured(), true);
});

test("an explicit image key beats the borrowed one", () => {
  // Both are set now; the deliberate choice must win over the inferred one.
  saveGlobalConfig({ images: { openaiApiKey: "sk-images" } });
  assert.equal(openAiImagesConfigured(), true);
  saveGlobalConfig({ images: { openaiApiKey: "" } });
  saveGlobalConfig({ text: { customBaseUrl: "", customApiKey: "" } });
  assert.equal(openAiImagesConfigured(), false);
});

// The producer-side gate the map and portrait routes ask before promising a
// picture. It normally describes the SERVER's default backend; a campaign on
// its own OpenAI key has to be able to answer for itself, or a
// bring-your-own-key host refuses renders it can pay for.
async function asyncTest(name, fn) {
  await fn();
  passed += 1;
}

await asyncTest("a campaign on its own OpenAI key satisfies the render gate", async () => {
  assert.equal(
    await imagesAvailable({
      imageBackend: "openai",
      customBaseUrl: "https://api.openai.com/v1",
      customApiKey: "sk-test",
    }),
    true,
  );
});

// These two compare against the no-argument answer rather than a literal,
// because the fallback is the SERVER's backend and a dev machine may well
// have ComfyUI running. What is being asserted is that no shortcut is taken.
await asyncTest("a key that is not OpenAI's takes no shortcut", async () => {
  const serverWide = await imagesAvailable();
  assert.equal(
    await imagesAvailable({
      imageBackend: "openai",
      customBaseUrl: "https://openrouter.ai/api/v1",
      customApiKey: "sk-or-test",
    }),
    serverWide,
  );
  assert.equal(
    await imagesAvailable({ imageBackend: "openai", customBaseUrl: "", customApiKey: "" }),
    serverWide,
  );
});

await asyncTest("a self-hosted backend still answers to the probe, not the key", async () => {
  // ComfyUI must never shortcut: "ready" for it means something is listening,
  // which only the capability probe knows. A checkpoint is picked for the
  // campaign and the server alike, so only the probe is left to answer.
  saveGlobalConfig({ images: { comfyCheckpoint: "any.safetensors" } });
  assert.equal(
    await imagesAvailable({
      imageBackend: "comfyui",
      customBaseUrl: "https://api.openai.com/v1",
      customApiKey: "sk-test",
      comfyCheckpoint: "any.safetensors",
    }),
    await imagesAvailable(),
  );
  saveGlobalConfig({ images: { comfyCheckpoint: "" } });
});

test("the masked settings tell the panel whether THIS campaign can render", () => {
  const byok = maskStorySettings({
    ...DEFAULT_STORY_SETTINGS,
    imageBackend: "openai",
    customBaseUrl: "https://api.openai.com/v1",
    customApiKey: "sk-test",
  });
  assert.equal(byok.imagesReady, true);
  assert.equal(byok.hasCustomApiKey, true);
  // Masking still never hands back a key.
  assert.equal("customApiKey" in byok, false);

  const keyless = maskStorySettings({
    ...DEFAULT_STORY_SETTINGS,
    imageBackend: "openai",
    customBaseUrl: "http://127.0.0.1:8001/v1",
    customApiKey: "sk-local",
  });
  assert.equal(keyless.imagesReady, false);

  // A self-hosted backend is reported ready; its liveness is the probe's job.
  assert.equal(maskStorySettings({ ...DEFAULT_STORY_SETTINGS }).imagesReady, true);
});

// ---- the request: the admin's model, or none at all ----

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(init.body) });
  return Response.json({ data: [{ b64_json: PIXEL.toString("base64") }] });
};
process.chdir(dir);
const draw = (aspect = "square") => generateOpenAiImage({ prompt: "a quiet harbor", mode: "fast", aspect });

await asyncTest("with no model picked a picture is refused, naming the admin page, and nothing is sent", async () => {
  saveGlobalConfig({ images: { openaiBaseUrl: "http://images.test/v1", openaiApiKey: "sk-images", openaiModel: "" } });
  await assert.rejects(draw, /no model picked.*Admin > Image generation/);
  assert.equal(requests.length, 0, "the images server was asked anyway");
});

await asyncTest("a picked model is sent as saved, and every model is asked for the same sizes", async () => {
  saveGlobalConfig({ images: { openaiModel: "my-painter-7" } });
  const portrait = await draw("portrait");
  assert.equal(requests.at(-1).url, "http://images.test/v1/images/generations");
  assert.equal(requests.at(-1).body.model, "my-painter-7");
  assert.equal(requests.at(-1).body.size, "1024x1536");
  assert.deepEqual([portrait.width, portrait.height], [1024, 1536]);
  await draw("landscape");
  assert.equal(requests.at(-1).body.size, "1536x1024");
  assert.equal(requests.at(-1).body.output_format, "webp");
});

// ---- sizes: learnt from the refusal, never from the model's name ----

// OpenAI's answer to a size the model does not take, as recorded on 2026-10-13 (gpt-image-1, 640x480).
const RECORDED_SIZE_REFUSAL = "Invalid size '640x480'. Supported sizes are 1024x1024, 1024x1536, 1536x1024, and auto.";
const size = (text) => {
  const [width, height] = text.split("x").map(Number);
  return { size: text, width, height };
};

test("the refusal's list is read, and a size picked for the shape by orientation, then ratio, then area", () => {
  assert.deepEqual(readSupportedSizes(RECORDED_SIZE_REFUSAL), [size("1024x1024"), size("1024x1536"), size("1536x1024")], "auto is not a size");
  assert.equal(readSupportedSizes("Invalid value for quality."), null);
  const tall = [size("1024x1024"), size("1024x1792"), size("1792x1024"), size("512x768")];
  assert.equal(pickImageSize("portrait", tall)?.size, "512x768", "2:3 itself beats a larger 4:7");
  assert.equal(pickImageSize("portrait", [size("1024x1792"), size("896x1792")])?.size, "1024x1792", "the nearer ratio");
  assert.equal(pickImageSize("landscape", [size("1792x1024"), size("1536x1024"), size("768x512")])?.size, "1536x1024", "equal ratio: the larger area");
  assert.equal(pickImageSize("square", tall)?.size, "1024x1024");
  const squareOnly = [size("512x512"), size("1024x1024")];
  assert.equal(pickImageSize("portrait", squareOnly)?.size, "1024x1024", "no portrait size: the largest square");
  assert.equal(pickImageSize("landscape", squareOnly)?.size, "1024x1024");
  assert.equal(pickImageSize("square", [size("1024x1792")]), null, "no square at all: nothing to pick");
  assert.equal(pickImageSize("portrait", [size("1792x1024")]), null, "no portrait and no square");
});

const takes = ["1024x1024", "1024x1792", "1792x1024"];
const sizeRequests = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  sizeRequests.push(body.size);
  if (!takes.includes(body.size)) {
    return Response.json(
      { error: { message: `Invalid size '${body.size}'. Supported sizes are ${takes.join(", ")}, and auto.`, type: "image_generation_user_error", param: "size", code: "invalid_value" } },
      { status: 400 },
    );
  }
  return Response.json({ data: [{ b64_json: PIXEL.toString("base64") }] });
};

await asyncTest("a refused size is learnt from the answer, retried once, and asked for straight away next time", async () => {
  saveGlobalConfig({ images: { openaiModel: "my-painter-8" } });
  const first = await draw("portrait");
  assert.deepEqual(sizeRequests, ["1024x1536", "1024x1792"]);
  assert.deepEqual([first.width, first.height], [1024, 1792], "the picture is described at the size it was made");
  sizeRequests.length = 0;
  await draw("portrait");
  await draw("landscape");
  assert.deepEqual(sizeRequests, ["1024x1792", "1792x1024"], "one refusal per model, not per picture");
});

// ---- quality: a tier the model does not take is dropped once ----

// A dall-e model behind a compatible proxy, as OpenAI answered dall-e-3: it
// takes "standard" and "hd", and portrait only at 1024x1792.
const qualityRequests = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  qualityRequests.push(body);
  if ("quality" in body && !["standard", "hd"].includes(body.quality)) {
    return Response.json(
      { error: { message: `Invalid value: '${body.quality}'. Supported values are: 'standard' and 'hd'.`, type: "invalid_request_error", param: "quality", code: "invalid_value" } },
      { status: 400 },
    );
  }
  if (body.size !== "1024x1024" && body.size !== "1024x1792") {
    return Response.json({ error: { message: `Invalid size '${body.size}'. Supported sizes are 1024x1024, 1024x1792, 1792x1024.`, param: "size" } }, { status: 400 });
  }
  return Response.json({ data: [{ b64_json: PIXEL.toString("base64") }] });
};

await asyncTest("a refused quality tier is dropped and the picture asked for once more, the size learnt after it", async () => {
  saveGlobalConfig({ images: { openaiModel: "my-old-painter" } });
  const picture = await draw("portrait");
  assert.deepEqual(
    qualityRequests.map((body) => [body.quality ?? null, body.size]),
    [["medium", "1024x1536"], [null, "1024x1536"], [null, "1024x1792"]],
  );
  assert.deepEqual([picture.width, picture.height], [1024, 1792]);
  // A refusal of the field that comes back again is the answer, not a loop.
  qualityRequests.length = 0;
  globalThis.fetch = async (url, init) => {
    qualityRequests.push(JSON.parse(init.body));
    return Response.json({ error: { message: "quality is not supported here", param: "quality" } }, { status: 400 });
  };
  await assert.rejects(draw, /quality is not supported here/);
  assert.equal(qualityRequests.length, 2, "asked once with the field and once without");
});

// ---- a refusal that names nothing: one square try, remembered ----

// Google behind OpenRouter, as recorded 2026-10-16 for an image model that
// takes only a square: any other size is refused with a generic
// INVALID_ARGUMENT that names no field and lists no sizes.
const GENERIC_REFUSAL = { error: { message: "Request contains an invalid argument.", code: 400, metadata: { provider_name: "Google" } } };
const genericSizes = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  genericSizes.push(body.size);
  if (body.size !== "1024x1024") {
    return Response.json(GENERIC_REFUSAL, { status: 400 });
  }
  return Response.json({ data: [{ b64_json: PIXEL.toString("base64") }] });
};

await asyncTest("a refusal that names nothing is tried once at the square size, which is then asked for straight away", async () => {
  saveGlobalConfig({ images: { openaiModel: "square-only-painter" } });
  const map = await draw("landscape");
  assert.deepEqual(genericSizes, ["1536x1024", "1024x1024"]);
  assert.deepEqual([map.width, map.height], [1024, 1024], "the picture is described at the size it was made");
  genericSizes.length = 0;
  await draw("landscape");
  await draw("portrait");
  assert.deepEqual(genericSizes, ["1024x1024", "1024x1024"], "one refusal per model, not per picture");
});

await asyncTest("a square refused too reports the first refusal with the provider that made it, and nothing is learnt", async () => {
  saveGlobalConfig({ images: { openaiModel: "refusing-painter" } });
  genericSizes.length = 0;
  globalThis.fetch = async (url, init) => {
    genericSizes.push(JSON.parse(init.body).size);
    return Response.json(GENERIC_REFUSAL, { status: 400 });
  };
  const named = /OpenAI image generation failed \(Google refused the request\): Request contains an invalid argument\./;
  await assert.rejects(() => draw("landscape"), named);
  await assert.rejects(() => draw("landscape"), named);
  assert.deepEqual(genericSizes, ["1536x1024", "1024x1024", "1536x1024", "1024x1024"], "a square that failed was remembered");
  genericSizes.length = 0;
  await assert.rejects(() => draw("square"), named);
  assert.deepEqual(genericSizes, ["1024x1024"], "a square is not asked for twice");
});

await asyncTest("a refusal that names its field is not taken for a size", async () => {
  saveGlobalConfig({ images: { openaiModel: "prompt-strict-painter" } });
  genericSizes.length = 0;
  globalThis.fetch = async (url, init) => {
    genericSizes.push(JSON.parse(init.body).size);
    return Response.json({ error: { message: "Invalid prompt.", param: "prompt" } }, { status: 400 });
  };
  await assert.rejects(() => draw("landscape"), /^Error: OpenAI image generation failed: Invalid prompt\.$/);
  assert.deepEqual(genericSizes, ["1536x1024"]);
});

globalThis.fetch = realFetch;
await imageVariantsSettled();
process.chdir(os.tmpdir());
removeTempDir(dir);
console.log(`test-openai-images: ${passed} passed`);
