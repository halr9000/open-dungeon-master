// Which engine writes down what a player or the DM says. Pure, so the
// capabilities probe, the /api/stt route and the tests all read the same
// order:
//
//   1. A Whisper service: an address set in the admin panel or STT_URL, or
//      the default odm-stt address answering. The best words and free.
//   2. The built-in engine, once an admin has installed its model: Whisper
//      inside this server on the CPU, for app-hosted worlds and servers
//      without the sidecar. Free and offline, a little slower.
//   3. OpenAI's transcription API, when this server holds an OpenAI key.
//      Billed to the key's owner, so it only answers when nothing free can.
//
// The Whisper service and OpenAI each run only with a model: their servers
// name their own models, and a name written into ODM would outlive the
// model. The Whisper service's is the one picked in Admin > Speech, else
// the only one it lists (src/lib/stt.ts); OpenAI's is the one picked.
// Without one, that engine is skipped.
//
// None of them: the server has no ears, and the button hides (or hands the
// job to the device, when an app offers its own recognizer).

export type SttBackend = "whisper" | "builtin" | "openai" | "none";

// STT_URL=off (or the admin field set to "off") says this server has no
// Whisper service, so nothing probes the default address: for a machine
// with something else on :8870, or an owner who wants the built-in engine.
export function whisperSwitchedOff(value: string): boolean {
  return value.trim().toLowerCase() === "off";
}

export type SttInputs = {
  explicitWhisperUrl: string;
  whisperReachable: boolean;
  whisperModel: string;
  builtinInstalled: boolean;
  openAiKey: string;
  openAiModel: string;
};

function whisperFound(input: Pick<SttInputs, "explicitWhisperUrl" | "whisperReachable">): boolean {
  return Boolean(input.explicitWhisperUrl.trim()) || input.whisperReachable;
}

export function pickSttBackend(input: SttInputs): SttBackend {
  if (whisperFound(input) && input.whisperModel.trim()) {
    return "whisper";
  }
  if (input.builtinInstalled) {
    return "builtin";
  }
  if (input.openAiKey.trim() && input.openAiModel.trim()) {
    return "openai";
  }
  return "none";
}

// A Whisper service is there but has no model picked, so it is skipped:
// the admin panel says so instead of leaving the admin to wonder.
export function whisperNeedsModel(input: Pick<SttInputs, "explicitWhisperUrl" | "whisperReachable" | "whisperModel">): boolean {
  return whisperFound(input) && !input.whisperModel.trim();
}

// OpenAI would be the one to listen (a key, and nothing free does), but no
// transcription model is picked, so the server has no ears at all. Upgrading
// from a version that named one turns dictation off this way, so the admin
// panel says so rather than only "nothing yet".
export function openAiSttNeedsModel(input: SttInputs): boolean {
  return pickSttBackend(input) === "none" && Boolean(input.openAiKey.trim()) && !input.openAiModel.trim();
}

// The built-in engine reads 16 kHz WAV; the others take the recorder's Opus.
export function sttWantsWav(backend: SttBackend): boolean {
  return backend === "builtin";
}
