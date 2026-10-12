import assert from "node:assert/strict";
import { mergeAdminConfigDraft } from "../src/app/admin/merge-config-draft.ts";

const saved = {
  text: { provider: "custom", customBaseUrl: "https://saved.example", customModel: "saved-model" },
  images: { defaultBackend: "comfyui", comfyUrl: "http://saved:8188", comfyWorkflowPreset: "z_turbo" },
  harness: { id: "codex", model: "saved-agent-model", images: "native" },
};
const draftDuringRequest = {
  ...saved,
  text: { ...saved.text, customBaseUrl: "https://unsaved.example" },
  images: { ...saved.images, comfyUrl: "http://draft:8188", comfyCheckpoint: "draft.safetensors" },
};

const afterAgentSave = mergeAdminConfigDraft(draftDuringRequest, {
  harness: { model: "new-agent-model" },
  text: { provider: "harness" },
});
assert.equal(afterAgentSave.harness.model, "new-agent-model");
assert.equal(afterAgentSave.text.provider, "harness");
assert.equal(afterAgentSave.text.customBaseUrl, "https://unsaved.example");
assert.equal(afterAgentSave.images.comfyUrl, "http://draft:8188");
assert.equal(afterAgentSave.images.comfyCheckpoint, "draft.safetensors");

const afterAdoption = mergeAdminConfigDraft(draftDuringRequest, {
  harness: { images: "native" },
  images: { defaultBackend: "harness" },
});
assert.equal(afterAdoption.images.defaultBackend, "harness");
assert.equal(afterAdoption.images.comfyUrl, "http://draft:8188");
assert.equal(afterAdoption.images.comfyCheckpoint, "draft.safetensors");
assert.equal(afterAdoption.text.customBaseUrl, "https://unsaved.example");

console.log("test-admin-config-draft: save and adoption preserve unrelated drafts");
