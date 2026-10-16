// The dictation models are admin settings (Admin > Speech): the Whisper
// service's and OpenAI's transcription model. Only an admin may set them or
// list a speech server's models, and a configuration saved before they
// existed still reads, with every model it holds unchanged. A model listing
// sends a saved key to the host it was saved for, a blank picture address
// included. The real route handlers run (register-routes.mjs) against a real
// encrypted throwaway database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-speech-models-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.chdir(dir);

register("./lib/register-routes.mjs", import.meta.url);

const { createUser } = await import("../src/lib/db/users.ts");
const { mintSession } = await import("../src/lib/auth.ts");
const { getGlobalConfig } = await import("../src/lib/db/app-settings.ts");
const { globalConfigSchema } = await import("../src/lib/schemas/global-config.ts");
const settingsRoute = await import(new URL("../src/app/api/admin/settings/route.ts", import.meta.url).href);
const modelsRoute = await import(new URL("../src/app/api/admin/models/route.ts", import.meta.url).href);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

const admin = createUser("admin", "x", { isAdmin: true });
const player = createUser("player", "x");
const as = (user) => {
  globalThis.__odmTestToken = mintSession(user.id).token;
};
const call = (handler, method, body) =>
  handler(new Request("http://test/", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));

await test("a player cannot set the dictation models or list a speech server", async () => {
  as(player);
  const refused = await call(settingsRoute.PATCH, "PATCH", { speech: { sttModel: "large-v3", sttOpenaiModel: "my-ears" } });
  assert.equal(refused.status, 403);
  assert.equal(getGlobalConfig().speech.sttModel, "");
  assert.equal(getGlobalConfig().speech.sttOpenaiModel, "");
  const listing = await call(modelsRoute.POST, "POST", { action: "list", role: "dictation", provider: "speech", baseUrl: "http://127.0.0.1:9/v1" });
  assert.equal(listing.status, 403);
});

await test("an admin sets them, bounded, and reads them back", async () => {
  as(admin);
  const saved = await call(settingsRoute.PATCH, "PATCH", { speech: { sttModel: " large-v3 ", sttOpenaiModel: "my-ears" } });
  assert.equal(saved.status, 200);
  const { config } = await (await call(settingsRoute.GET, "GET")).json();
  assert.equal(config.speech.sttModel, "large-v3");
  assert.equal(config.speech.sttOpenaiModel, "my-ears");
  const tooLong = await call(settingsRoute.PATCH, "PATCH", { speech: { sttModel: "x".repeat(201) } });
  assert.equal(tooLong.status, 400);
  assert.equal(getGlobalConfig().speech.sttModel, "large-v3");
});

await test("a configuration saved before the dictation models existed still reads, its models unchanged", () => {
  const before = globalConfigSchema.parse({
    images: { defaultBackend: "openai", openaiModel: "an-older-painter", comfyCheckpoint: "kept.safetensors" },
    speech: { ttsProvider: "openai", ttsModel: "an-older-voice", sttUrl: "http://stt.lan:8870" },
  });
  assert.equal(before.speech.sttModel, "");
  assert.equal(before.speech.sttOpenaiModel, "");
  assert.equal(before.speech.ttsModel, "an-older-voice");
  assert.equal(before.images.openaiModel, "an-older-painter");
  assert.equal(before.images.comfyCheckpoint, "kept.safetensors");
  assert.equal(before.speech.sttUrl, "http://stt.lan:8870");
});

await test("a blank picture address lists api.openai.com with the saved key, and a typed address never gets it", async () => {
  as(admin);
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ data: [{ id: "a-painter" }] });
  };
  try {
    const { saveGlobalConfig } = await import("../src/lib/db/app-settings.ts");
    saveGlobalConfig({ images: { openaiBaseUrl: "", openaiApiKey: "sk-saved-images" } });
    await call(modelsRoute.POST, "POST", { action: "list", role: "image", provider: "images", baseUrl: "" });
    assert.deepEqual(asked.at(-1), { url: "https://api.openai.com/v1/models", auth: "Bearer sk-saved-images" });
    saveGlobalConfig({ images: { openaiApiKey: "" }, text: { customBaseUrl: "https://api.openai.com/v1", customApiKey: "sk-storyteller" } });
    await call(modelsRoute.POST, "POST", { action: "list", role: "image", provider: "images", baseUrl: "" });
    assert.equal(asked.at(-1).auth, "Bearer sk-storyteller", "the storyteller's OpenAI key covers pictures, as the backend lends it");
    await call(modelsRoute.POST, "POST", { action: "list", role: "image", provider: "images", baseUrl: "https://images.example.test/v1" });
    assert.deepEqual(asked.at(-1), { url: "https://images.example.test/v1/models", auth: null }, "a key goes only to the host it was saved for");
  } finally {
    globalThis.fetch = realFetch;
  }
});

process.chdir(os.tmpdir());
removeTempDir(dir);
console.log(`speech model settings: ${passed} checks passed`);
