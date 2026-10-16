// The server's side of picking a speech engine for dictation: gathers what
// the pure rule in stt-logic.ts needs (is a Whisper service there and its
// model picked, is the built-in model installed, is there an OpenAI key and
// its model) and answers with one backend. The voice-chat transcript
// (src/lib/stt.ts) keeps its own rule: it runs only when an operator names
// STT_URL, with the same model.

import { probeReachable, sttProbeUrl } from "@/lib/capabilities";
import { sttInputs } from "@/lib/stt";
import { openAiSttNeedsModel, pickSttBackend, whisperNeedsModel, type SttBackend } from "@/lib/stt-logic";

const probe = (url: string) => probeReachable(sttProbeUrl(url));

export async function currentSttBackend(): Promise<SttBackend> {
  return pickSttBackend(await sttInputs(probe));
}

// What the admin panel's Speech section is told about dictation.
export type SttStatus = {
  active: SttBackend;
  // A Whisper service answers (or is named), but no model is picked for it
  // and it does not list exactly one, so dictation skips it.
  whisper: { needsModel: boolean };
  // An OpenAI key would take dictation, as nothing free listens, but no
  // transcription model is picked for it.
  openai: { needsModel: boolean };
};

export async function sttStatus(): Promise<SttStatus> {
  const inputs = await sttInputs(probe);
  return {
    active: pickSttBackend(inputs),
    whisper: { needsModel: whisperNeedsModel(inputs) },
    openai: { needsModel: openAiSttNeedsModel(inputs) },
  };
}
