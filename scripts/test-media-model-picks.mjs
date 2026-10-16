// No model is named in code (PR 298): pictures, narration and dictation run
// only with a model picked from what their server lists. Every readiness
// check has to know that, or tables are promised pictures and narration
// that all fail: the enqueue gates (imagesAvailable, imageProducerReady),
// /api/capabilities, a campaign's own imagesReady, the stranded-campaign
// rescue and the Speech status. And a campaign made before the admin picked
// a ComfyUI checkpoint has to paint with the one picked later. Real routes
// and a throwaway database; the backends are stand-ins on loopback ports.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-media-picks-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
// A developer's own shell must not decide these answers.
for (const name of [
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_API_KEY",
  "OPENAI_IMAGE_BASE_URL",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_MODEL",
  "DEFAULT_IMAGE_BACKEND",
  "COMFYUI_URL",
  "TTS_PROVIDER",
  "TTS_BASE_URL",
  "TTS_MODEL",
  "TTS_API_KEY",
  "STT_MODEL",
  "STT_OPENAI_MODEL",
  "ODM_DEVICE_WORLD",
]) {
  delete process.env[name];
}
// Nothing else the capability snapshot asks is there, and it says so at once.
process.env.DEFAULT_TEXT_PROVIDER = "none";
process.env.KOKORO_URL = "http://127.0.0.1:9";
process.env.STT_URL = "off";
process.env.FLUX_WORKER_URL = "http://127.0.0.1:9";
process.chdir(dir);

register("./lib/register-routes.mjs", import.meta.url);

const { createUser } = await import("../src/lib/db/users.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { createCampaign, getCampaignById, updateStorySettings } = await import("../src/lib/db/campaigns.ts");
const { saveGlobalConfig } = await import("../src/lib/db/app-settings.ts");
const { maskStorySettings } = await import("../src/lib/db/settings.ts");
const settingsRoute = await import("../src/app/api/admin/settings/route.ts");
const { openAiImagesConfigured, openAiImagesNeedModel } = await import("../src/lib/openai-images.ts");
const { imageProducerReady, generateStoryImage } = await import("../src/lib/image-generate.ts");
const { capabilitiesSnapshot, imagesAvailable } = await import("../src/lib/capabilities.ts");
const { rescueStrandedCampaigns } = await import("../src/lib/image-backend-rescue.ts");
const { sttStatus } = await import("../src/lib/stt-backend.ts");
const { forgetSoleModelsForTests } = await import("../src/lib/model-registry/discovery.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// A ComfyUI that answers its liveness check, and a speech server whose model
// list the test sets.
let speechModels = ["only-voice"];
let storyModels = ["my-story-model"];
const prompts = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/system_stats") return send(200, { system: {}, devices: [] });
    if (request.url === "/prompt") {
      prompts.push(JSON.parse(body));
      // Enough to see what was asked for; the picture itself is not needed.
      return send(500, { error: "stand-in" });
    }
    if (request.url === "/speech/v1/models") return send(200, { data: speechModels.map((id) => ({ id })) });
    if (request.url === "/story/v1/models") return send(200, { data: storyModels.map((id) => ({ id })) });
    send(404, {});
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const admin = createUser("admin", "x", { isAdmin: true });
globalThis.__odmTestToken = mintSession(admin.id).token;
const table = (title) => createCampaign(admin.id, { title, description: "", theme: "", maxPlayers: 4, startingLevel: 1, difficulty: "normal" });
const patchAdmin = (body) =>
  settingsRoute.PATCH(new Request("http://t/api/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

try {
  await test("a campaign made before a checkpoint was picked paints with the one the admin picks later", async () => {
    saveGlobalConfig({ images: { defaultBackend: "comfyui", comfyUrl: base, comfyCheckpoint: "", comfyWorkflowPreset: "checkpoint" } });
    const early = table("Made early");
    assert.equal(getCampaignById(early.id).settings.comfyCheckpoint, "", "nothing is picked yet");
    assert.equal(imageProducerReady(getCampaignById(early.id).settings), false, "no checkpoint: nothing to paint with");
    const own = table("Own checkpoint");
    updateStorySettings(own.id, { comfyCheckpoint: "own.safetensors" });

    const response = await patchAdmin({ images: { comfyCheckpoint: "mine.safetensors" } });
    assert.equal(response.status, 200);
    const settings = getCampaignById(early.id).settings;
    assert.equal(settings.comfyCheckpoint, "mine.safetensors", "the admin's pick reaches a campaign that had none");
    assert.equal(imageProducerReady(settings), true);
    assert.equal(getCampaignById(own.id).settings.comfyCheckpoint, "own.safetensors", "a campaign's own checkpoint stays its own");

    prompts.length = 0;
    await assert.rejects(generateStoryImage(settings, { prompt: "a quiet harbor", mode: "fast", aspect: "square" }));
    assert.match(JSON.stringify(prompts.at(-1)), /mine\.safetensors/, "the picture was asked of the admin's checkpoint");
  });

  await test("ComfyUI with no checkpoint and no catalog model is not ready anywhere, however well it answers", async () => {
    saveGlobalConfig({ images: { defaultBackend: "comfyui", comfyUrl: base, comfyCheckpoint: "", comfyWorkflowPreset: "checkpoint" } });
    const blank = getCampaignById(table("No pick").id).settings;
    assert.equal(blank.comfyCheckpoint, "");
    const images = (await capabilitiesSnapshot()).images;
    assert.equal(images.configured, false, "pictures are not promised");
    assert.equal(images.needsModel, true, "the admin is told a model is missing");
    assert.equal(await imagesAvailable(), false);
    assert.equal(await imagesAvailable(blank), false);
    assert.equal(await imagesAvailable({ ...blank, comfyUrl: base }), false, "a campaign's own ComfyUI address does not make up for it");
    assert.equal(imageProducerReady(blank), false);
    assert.equal(maskStorySettings(blank).imagesNeedModel, true);
    // A campaign with a checkpoint of its own paints on the server's ComfyUI.
    assert.equal(await imagesAvailable({ ...blank, comfyCheckpoint: "own.safetensors" }), true);
    assert.equal(await imagesAvailable({ ...blank, comfyUrl: base, comfyCheckpoint: "own.safetensors" }), true);

    // A catalog model paints every campaign's pictures without a checkpoint.
    saveGlobalConfig({ images: { comfyWorkflowPreset: "z_turbo" } });
    assert.equal((await capabilitiesSnapshot()).images.configured, true);
    assert.equal(imageProducerReady(blank), true);
    assert.equal(maskStorySettings(blank).imagesNeedModel, false);
    saveGlobalConfig({ images: { comfyWorkflowPreset: "checkpoint", comfyCheckpoint: "mine.safetensors" } });
    assert.equal((await capabilitiesSnapshot()).images.configured, true);
    assert.equal((await capabilitiesSnapshot()).images.needsModel, false);
    assert.equal(await imagesAvailable(), true);
  });

  await test("OpenAI pictures need a model as well as a key; OPENAI_IMAGE_MODEL counts", async () => {
    saveGlobalConfig({ images: { defaultBackend: "openai", openaiApiKey: "sk-images", openaiModel: "" } });
    const campaign = getCampaignById(table("OpenAI pictures").id).settings;
    assert.equal(campaign.imageBackend, "openai");
    assert.equal(openAiImagesConfigured(), false);
    assert.equal(openAiImagesNeedModel(), true);
    const images = (await capabilitiesSnapshot()).images;
    assert.equal(images.configured, false);
    assert.equal(images.reachable, false);
    assert.equal(images.needsModel, true);
    assert.equal(imageProducerReady(campaign), false);
    assert.equal(await imagesAvailable(), false);
    const masked = maskStorySettings(campaign);
    assert.equal(masked.imagesReady, false);
    assert.equal(masked.imagesNeedModel, true, "the panel says a model is missing, not a key");

    process.env.OPENAI_IMAGE_MODEL = "env-painter";
    assert.equal(openAiImagesConfigured(), true);
    assert.equal(imageProducerReady(campaign), true);
    assert.equal((await capabilitiesSnapshot()).images.configured, true);
    delete process.env.OPENAI_IMAGE_MODEL;
    saveGlobalConfig({ images: { openaiModel: "my-painter" } });
    assert.equal(openAiImagesConfigured(), true);
    assert.equal(openAiImagesNeedModel(), false);
    assert.equal(maskStorySettings(campaign).imagesReady, true);
    // No key at all is not "needs a model".
    saveGlobalConfig({ images: { openaiApiKey: "" } });
    assert.equal(openAiImagesNeedModel(), false);
    assert.equal(maskStorySettings(campaign).imagesNeedModel, false);
  });

  await test("the rescue moves no campaign onto a backend with no model, nor counts one without as able to paint", async () => {
    // A table stranded on a ComfyUI that is not there.
    const stranded = table("The Old Road");
    updateStorySettings(stranded.id, { imageBackend: "comfyui", comfyUrl: "http://127.0.0.1:9", comfyCheckpoint: "a.safetensors" });
    saveGlobalConfig({ images: { defaultBackend: "openai", openaiApiKey: "sk-images", openaiModel: "" } });
    let moves = await rescueStrandedCampaigns();
    assert.ok(!moves.some((move) => move.id === stranded.id), "moved onto OpenAI pictures with no model");
    saveGlobalConfig({ images: { openaiModel: "my-painter" } });
    moves = await rescueStrandedCampaigns();
    assert.ok(moves.some((move) => move.id === stranded.id), "a backend that can paint takes it");

    // A ComfyUI that answers but has nothing picked is no target either.
    const keyless = table("No key");
    updateStorySettings(keyless.id, { imageBackend: "openai" });
    saveGlobalConfig({ images: { defaultBackend: "comfyui", comfyUrl: base, comfyCheckpoint: "", comfyWorkflowPreset: "checkpoint", openaiApiKey: "" } });
    moves = await rescueStrandedCampaigns();
    assert.ok(!moves.some((move) => move.id === keyless.id), "moved onto a ComfyUI with no checkpoint");
  });

  await test("OpenAI-kind narration is ready only with a model: picked, TTS_MODEL, or a local server's only one", async () => {
    saveGlobalConfig({ speech: { ttsProvider: "openai", ttsBaseUrl: "https://api.openai.com/v1", ttsModel: "", ttsApiKey: "sk-voice" } });
    let tts = (await capabilitiesSnapshot()).tts;
    assert.equal(tts.configured, false, "OpenAI with a key and no model reads nothing aloud");
    assert.equal(tts.needsModel, true);
    process.env.TTS_MODEL = "env-voice";
    tts = (await capabilitiesSnapshot()).tts;
    assert.equal(tts.configured, true);
    assert.equal(tts.needsModel, false);
    delete process.env.TTS_MODEL;

    // A server of the host's own runs its only listed model for a blank.
    forgetSoleModelsForTests();
    speechModels = ["only-voice"];
    saveGlobalConfig({ speech: { ttsBaseUrl: `${base}/speech`, ttsApiKey: "" } });
    tts = (await capabilitiesSnapshot()).tts;
    assert.equal(tts.configured, true, "the server's only model runs a blank field");
    assert.equal(tts.needsModel, false);
    forgetSoleModelsForTests();
    speechModels = ["voice-a", "voice-b"];
    tts = (await capabilitiesSnapshot()).tts;
    assert.equal(tts.configured, false, "several models and none picked");
    assert.equal(tts.needsModel, true);
    saveGlobalConfig({ speech: { ttsModel: "voice-a" } });
    assert.equal((await capabilitiesSnapshot()).tts.configured, true);
    saveGlobalConfig({ speech: { ttsProvider: "off", ttsModel: "" } });
  });

  await test("a storyteller with an address and no model is ready when its server lists exactly one", async () => {
    // The shipped Docker file names no model any more: a llama-server that
    // serves one runs it, so the creator must not call it missing.
    forgetSoleModelsForTests();
    saveGlobalConfig({ text: { provider: "custom", customBaseUrl: `${base}/story/v1`, customModel: "" } });
    let story = (await capabilitiesSnapshot()).story;
    assert.deepEqual(story, { configured: true, reachable: true, model: "my-story-model" });
    forgetSoleModelsForTests();
    storyModels = ["model-a", "model-b"];
    story = (await capabilitiesSnapshot()).story;
    assert.equal(story.configured, false, "several models and none picked: somebody has to choose");
    assert.equal(story.model, "");
    saveGlobalConfig({ text: { customModel: "model-b" } });
    assert.deepEqual((await capabilitiesSnapshot()).story, { configured: true, reachable: true, model: "model-b" });
    saveGlobalConfig({ text: { provider: "none", customBaseUrl: "", customModel: "" } });
  });

  await test("Admin > Speech hears that an OpenAI key would take dictation but has no model picked", async () => {
    saveGlobalConfig({ images: { openaiApiKey: "sk-images" }, speech: { sttOpenaiModel: "" } });
    let status = await sttStatus();
    assert.equal(status.active, "none");
    assert.equal(status.openai.needsModel, true);
    saveGlobalConfig({ speech: { sttOpenaiModel: "my-ears" } });
    status = await sttStatus();
    assert.equal(status.active, "openai");
    assert.equal(status.openai.needsModel, false);
    // Without a key there is nothing to pick a model for.
    saveGlobalConfig({ images: { openaiApiKey: "" }, speech: { sttOpenaiModel: "" } });
    assert.equal((await sttStatus()).openai.needsModel, false);
  });
} finally {
  server.close();
  process.chdir(os.tmpdir());
  removeTempDir(dir);
}
console.log(`media model picks: ${passed} checks passed`);
