import { isSpeechModelId } from "@/lib/model-registry/catalog-logic";
import type { ModelChoices } from "@/lib/model-registry/registry";

// What a model picker's blank entry says, one pattern for Admin and the
// guided setup, by what a blank runs:
//   - a name known now: the name, with where it comes from ("large-v3 (from
//     STT_MODEL)", "large-v3 (the server's only model)");
//   - a model chosen elsewhere: "Not chosen (the story model)";
//   - nothing of the kind: "None (no narration)".
// No model is ever named here: a blank that runs one names what the server
// or the environment says.

export function fromEnv(value: string, variable: string): string {
  return `${value} (from ${variable})`;
}

export function noneLabel(off: string): string {
  return `None (no ${off})`;
}

export function notChosen(runs: string): string {
  return `Not chosen (${runs})`;
}

// A blank that runs the server's only model (the storyteller, #273's rule
// in src/lib/model-registry/discovery.ts; a Whisper service,
// src/lib/stt.ts; a narration server that is not OpenAI,
// src/lib/tts-backend.ts): named, so the admin sees what is sent, and left
// blank, so it follows the server when its model changes. Until the server
// answers, nobody knows whether it has just one.
export function soleModelBlank(otherwise: string): (choices: ModelChoices | null) => string {
  return (choices) => {
    if (choices?.reachable !== true) return notChosen("the server's only model, once it answers");
    const listed = choices.models.filter((model) => model.listed);
    return listed.length === 1 ? `${listed[0].label} (the server's only model)` : otherwise;
  };
}

// A Whisper service with no model is skipped for the next engine, so
// dictation itself may still run.
export const BLANK = {
  story: soleModelBlank(noneLabel("storyteller")),
  utility: notChosen("the story model"),
  picture: noneLabel("pictures"),
  checkpoint: noneLabel("pictures"),
  narration: noneLabel("narration"),
  // A narration server of the host's own runs its only model for a blank,
  // as a Whisper service does (src/lib/tts-backend.ts narrationModel).
  narrationServer: soleModelBlank(noneLabel("narration")),
  whisper: soleModelBlank(noneLabel("Whisper dictation")),
  transcription: noneLabel("paid dictation"),
  // The agent program's own choice, which only the program knows.
  programDefault: notChosen("the program's own default"),
};

// What a speech picker shows first, the rest one click away (a display
// filter, never what is sent).
export const SPEECH_MODELS = {
  narration: { keep: (id: string) => isSpeechModelId(id, "narration"), kind: "narration models" },
  dictation: { keep: (id: string) => isSpeechModelId(id, "dictation"), kind: "transcription models" },
};
