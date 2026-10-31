import { configValue, getGlobalConfig } from "@/lib/app-config";
import { endpointKind } from "@/lib/dm/sampling-logic";
import { soleListedModel } from "@/lib/model-registry/discovery";
import { openAiSpeechConfig } from "@/lib/openai-images";
import { serverEnv } from "@/lib/server-env";
import { TTS_VOICES } from "@/lib/tts-voices";

// Where narration is rendered (issue 89). One setting names the kind of
// speech server, the way the text model's does, and everything else follows
// from it:
//
//   kokoro  a Kokoro-FastAPI service, the shipped default at 127.0.0.1:8880.
//   openai  any server that speaks OpenAI's /v1/audio/speech: OpenAI itself,
//           or a local one (Kokoro-FastAPI, Speaches, openedai-speech, ...)
//           with its own address, model and key.
//   openrouter  OpenRouter's speech endpoint (api/v1/audio/speech), OpenAI's
//           wire format: the key is the one its text model already uses, and
//           the model is always the admin's pick from its own list.
//   off     no narration on this server.
//
// Both kinds are the same request on the wire; the kind only picks the
// defaults, so a server set up before this existed keeps working untouched.
// An "openai" server's model has no default: it is the admin's pick from
// what the server lists. With none picked, a server of the host's own that
// lists exactly one model runs that one (narrationModel below); otherwise
// nothing is sent.
// The decision logic is pure and exported so scripts/test-tts-backend.mjs can
// drive it without a network.

export type TtsProvider = "kokoro" | "openai" | "openrouter" | "off";

export type TtsBackend = {
  provider: TtsProvider;
  // The /v1 root: speech is POSTed to `${v1}/audio/speech`.
  v1: string;
  model: string;
  apiKey: string;
  // What the server is asked to answer with: mp3, pcm (wrapped as WAV), or
  // auto — mp3 first, and pcm for models that answer nothing else.
  responseFormat: "auto" | "mp3" | "pcm";
  // The voice used when a campaign names one this server does not have.
  defaultVoice: string;
};

export const KOKORO_DEFAULT_URL = "http://127.0.0.1:8880";
export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1";
export const OPENROUTER_DEFAULT_URL = "https://openrouter.ai/api/v1";

// OpenAI publishes no voice list endpoint; these are the documented voices.
export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];

// A bare host, a /v1 base, or a trailing slash all land on the same root,
// the same forgiveness the text model's address gets.
export function v1Root(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

export function isOpenAiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function isOpenRouterHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

// The text model's OpenRouter key, when the text backend itself is OpenRouter
// (endpointKind reads the whole host, and a blank URL is never "openrouter").
// One key covers OpenRouter's text and speech, so a table already paying
// OpenRouter for its DM need not paste the key twice.
export function openRouterTextKey(): string {
  const text = getGlobalConfig().text;
  const candidates: Array<[string, string]> = [
    [text.customBaseUrl, text.customApiKey],
    [serverEnv("OPENAI_COMPAT_BASE_URL"), serverEnv("OPENAI_COMPAT_API_KEY")],
  ];
  for (const [baseUrl, apiKey] of candidates) {
    if (endpointKind(baseUrl) === "openrouter" && apiKey.trim()) {
      return apiKey.trim();
    }
  }
  return "";
}

export type TtsBackendInput = {
  provider: string;
  // Admin value, then env, for each kind of server.
  kokoroUrl: string;
  openaiUrl: string;
  model: string;
  apiKey: string;
  voice: string;
  // What the server is asked to answer with: blank = mp3; pcm-only models say "pcm".
  responseFormat: string;
  // The text model's OpenRouter key, lent only to openrouter.ai itself.
  sharedOpenRouterKey: string;
  // The server's shared OpenAI key (images, dictation), lent only to
  // api.openai.com itself.
  sharedOpenAiKey: string;
};

export function resolveTtsBackend(input: TtsBackendInput): TtsBackend {
  let provider: TtsProvider =
    input.provider === "openai" || input.provider === "openrouter" || input.provider === "off" ? input.provider : "kokoro";
  // An OpenAI-compatible profile pointed at openrouter.ai IS the OpenRouter
  // profile — different endpoint paths, key lending and voice rules — so it
  // resolves as one and no saved setting has to be migrated.
  if (provider === "openai" && isOpenRouterHost(input.openaiUrl.trim())) {
    provider = "openrouter";
  }
  // What the speech bytes come back as: auto (mp3 asked first, pcm when the
  // model refuses it) unless the admin pinned one.
  const asked = input.responseFormat.trim();
  const responseFormat = asked === "pcm" || asked === "mp3" ? asked : "auto";
  if (provider === "openrouter") {
    const base = input.openaiUrl.trim() || OPENROUTER_DEFAULT_URL;
    return {
      provider,
      v1: v1Root(base),
      // OpenRouter lists many speech models, so no single default can stand
      // for them: the model is always the admin's pick from its own list.
      model: input.model.trim(),
      apiKey: input.apiKey.trim() || (isOpenRouterHost(base) ? input.sharedOpenRouterKey.trim() : ""),
      responseFormat,
      defaultVoice: input.voice.trim(),
    };
  }
  if (provider === "openai") {
    const base = input.openaiUrl.trim() || OPENAI_DEFAULT_URL;
    const official = isOpenAiHost(base);
    return {
      provider,
      v1: v1Root(base),
      model: input.model.trim(),
      apiKey: input.apiKey.trim() || (official ? input.sharedOpenAiKey.trim() : ""),
      responseFormat,
      defaultVoice: input.voice.trim() || (official ? "alloy" : ""),
    };
  }
  return {
    provider,
    v1: v1Root(input.kokoroUrl.trim() || KOKORO_DEFAULT_URL),
    model: input.model.trim() || "kokoro",
    apiKey: input.apiKey.trim(),
    responseFormat,
    defaultVoice: input.voice.trim() || "af_heart",
  };
}

// The server's saved narration backend. `override` carries the admin form's
// unsaved values so "Test" tries what is typed, not what was last saved.
export function ttsBackend(override: Partial<Pick<TtsBackendInput, "provider" | "kokoroUrl" | "openaiUrl" | "model" | "voice" | "responseFormat">> & { apiKey?: string } = {}): TtsBackend {
  const speech = getGlobalConfig().speech;
  const provider = override.provider ?? configValue(speech.ttsProvider, "TTS_PROVIDER");
  return resolveTtsBackend({
    provider,
    kokoroUrl: override.kokoroUrl?.trim() || configValue(speech.kokoroUrl, "KOKORO_URL"),
    openaiUrl: override.openaiUrl?.trim() || configValue(speech.ttsBaseUrl, "TTS_BASE_URL"),
    model: override.model?.trim() || configValue(speech.ttsModel, "TTS_MODEL"),
    apiKey: override.apiKey?.trim() || configValue(speech.ttsApiKey, "TTS_API_KEY"),
    voice: override.voice?.trim() || configValue(speech.ttsVoice, "TTS_VOICE"),
    responseFormat: override.responseFormat?.trim() || configValue(speech.ttsResponseFormat, "TTS_RESPONSE_FORMAT"),
    sharedOpenAiKey: openAiSpeechConfig().apiKey,
    sharedOpenRouterKey: openRouterTextKey(),
  });
}

export type TtsVoice = { id: string; label: string };

// A voice list as servers answer it: Kokoro-FastAPI sends { voices: [ids] },
// others send objects, or OpenAI's { data: [...] } envelope.
export function parseVoiceList(payload: unknown): string[] {
  const root = payload as { voices?: unknown; data?: unknown } | unknown[] | null;
  const list = Array.isArray(root) ? root : Array.isArray(root?.voices) ? root.voices : Array.isArray(root?.data) ? root.data : [];
  const ids: string[] = [];
  for (const entry of list) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? ((entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).voice_id ?? (entry as Record<string, unknown>).name)
          : null;
    if (typeof id === "string" && id.trim() && id.length <= 120 && !ids.includes(id.trim())) {
      ids.push(id.trim());
    }
  }
  return ids.slice(0, 400);
}

// The voices the model's own row lists, as OpenRouter's models list
// answers it (a model id's free variant shares the row's voices).
export function openRouterVoiceList(payload: unknown, model: string): string[] {
  const root = payload as { data?: unknown } | null;
  const rows = Array.isArray(root?.data) ? root.data : [];
  const asked = model.trim().toLowerCase().replace(/:.*$/, "");
  if (!asked) {
    return [];
  }
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = (row as Record<string, unknown>).id;
    if (typeof id !== "string" || id.toLowerCase().replace(/:.*$/, "") !== asked) continue;
    const voices = (row as Record<string, unknown>).supported_voices;
    return Array.isArray(voices) ? voices.filter((voice): voice is string => typeof voice === "string" && voice.trim().length > 0 && voice.length <= 120) : [];
  }
  return [];
}

// The picker's list: the curated voices this server really has first, under
// their friendly names, then everything else it reports by id.
export function labelVoices(ids: string[]): TtsVoice[] {
  const curated: TtsVoice[] = TTS_VOICES.filter((voice) => ids.includes(voice.id)).map((voice) => ({ id: voice.id, label: voice.label }));
  const known = new Set(curated.map((voice) => voice.id));
  return [...curated, ...ids.filter((id) => !known.has(id)).map((id) => ({ id, label: id }))];
}

// What a server offers when it will not say: Kokoro's shipped voices, or
// OpenAI's documented ones. An unknown compatible server offers nothing and
// the picker falls back to typing a voice.
export function fallbackVoices(backend: Pick<TtsBackend, "provider" | "v1">): string[] {
  if (backend.provider === "kokoro") {
    return TTS_VOICES.map((voice) => voice.id);
  }
  // OpenRouter's voices belong to each model, so nothing is offered and the
  // picker falls back to typing the id the model's page documents.
  if (backend.provider === "openrouter") {
    return [];
  }
  return isOpenAiHost(backend.v1) ? OPENAI_TTS_VOICES : [];
}

// The voice actually asked for. Campaigns, personalities and NPCs made on a
// Kokoro server carry Kokoro voice ids; on a server that has no such voice
// they would fail every passage, so a Kokoro id the server does not list
// becomes the server's default voice. Anything else is sent as written: a
// custom voice string is the server's to understand.
export function effectiveVoice(voice: string, backend: Pick<TtsBackend, "provider" | "defaultVoice">, serverVoices: string[]): string {
  const asked = voice.trim() || backend.defaultVoice;
  if ((backend.provider !== "openai" && backend.provider !== "openrouter") || !backend.defaultVoice) {
    return asked;
  }
  const kokoroId = TTS_VOICES.some((entry) => entry.id === asked);
  return kokoroId && !serverVoices.includes(asked) ? backend.defaultVoice : asked;
}

// Why a render failed, in words for the table (issue 88). Never the key, and
// never more of an upstream body than a sentence.
export function describeSpeechFailure(error: unknown, backend: Pick<TtsBackend, "provider" | "v1">): string {
  const where = backend.provider === "kokoro" ? "The Kokoro speech server" : "The speech server";
  if (error instanceof SpeechHttpError) {
    if (error.status === 401 || error.status === 403) {
      return `${where} refused the API key (HTTP ${error.status}).`;
    }
    if (error.status === 404) {
      return `${where} has no speech endpoint at ${backend.v1}/audio/speech (HTTP 404).`;
    }
    const detail = error.detail ? `: ${error.detail}` : "";
    return `${where} answered HTTP ${error.status}${detail}`.replace(/\.?$/, ".");
  }
  if (isSpeechTimeout(error)) {
    return `${where} took too long to answer.`;
  }
  if (error instanceof SpeechEmptyError) {
    return `${where} answered without any audio.`;
  }
  if (error instanceof SpeechModelMissingError) {
    return error.message;
  }
  return `${where} could not be reached at ${hostOf(backend.v1)}.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Plain fields, not parameter properties: the test scripts load this file
// through Node's type stripping, which has no such syntax.
export class SpeechHttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Speech request failed: HTTP ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "SpeechHttpError";
    this.status = status;
    this.detail = detail;
  }
}

export class SpeechEmptyError extends Error {
  constructor() {
    super("Speech request returned no audio.");
    this.name = "SpeechEmptyError";
  }
}

// An OpenAI-compatible server with no model picked: refused before any
// request, in words that say where to pick one.
export class SpeechModelMissingError extends Error {
  constructor() {
    super("No narration model is picked for this server. Choose one from its list in Admin > Speech.");
    this.name = "SpeechModelMissingError";
  }
}

// The one sentence of an upstream error body worth repeating.
export function upstreamDetail(body: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    const found =
      (typeof parsed.error === "object" && parsed.error ? parsed.error.message : parsed.error) ?? parsed.detail ?? parsed.message;
    if (typeof found === "string") {
      text = found;
    } else if (found !== undefined) {
      text = JSON.stringify(found);
    }
  } catch {
    // Not JSON: an HTML error page says nothing a table can use.
    if (/<\s*(html|!doctype)/i.test(body)) {
      return "";
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

// How long one speech request may take before it is given up on. A stalled
// provider used to hold a table's narration lane for three minutes per
// passage, so the voice fell further behind the text with every turn. The
// wait now grows with the passage, from a short floor to a modest ceiling:
// OpenAI's gpt-4o-mini-tts reads 950 characters in about 9 s, and Kokoro on a
// CPU is slower still, so the floor leaves room for both.
export const SPEECH_TIMEOUT_FLOOR_MS = 30_000;
export const SPEECH_TIMEOUT_CEILING_MS = 60_000;
const SPEECH_TIMEOUT_MS_PER_CHAR = 25;

export function speechTimeoutMs(characters: number): number {
  const scaled = SPEECH_TIMEOUT_FLOOR_MS + Math.max(0, characters) * SPEECH_TIMEOUT_MS_PER_CHAR;
  return Math.min(SPEECH_TIMEOUT_CEILING_MS, scaled);
}

export function isSpeechTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export type SpeechRequestOptions = { timeoutMs?: number };

// One attempt, at one response format. A pcm answer is raw 24 kHz mono
// 16-bit samples; browsers play containers, not bare samples, so it is
// wrapped in a 44-byte WAV header.
export function pcmToWav(pcm: Buffer): Buffer {
  const rate = 24000;
  const channels = 1;
  const bits = 16;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function requestSpeechOnce(
  backend: TtsBackend,
  input: string,
  voice: string,
  speed: number,
  timeoutMs: number,
  format: "mp3" | "pcm",
): Promise<Buffer> {
  const response = await fetch(`${backend.v1}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: backend.model, voice, input, response_format: format, ...(speed !== 1 ? { speed } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new SpeechHttpError(response.status, upstreamDetail(await response.text().catch(() => "")));
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) {
    throw new SpeechEmptyError();
  }
  return format === "pcm" ? pcmToWav(audio) : audio;
}

// A refusal of the mp3 we asked for, in the server's own words — the shape
// OpenRouter's pcm-only models answer with ("only supports response_format
// \"pcm\""). Anything else is not the format's fault.
function refusesFormat(error: unknown): boolean {
  return error instanceof SpeechHttpError && error.status === 400 && /response.?format|audio.?format|pcm/i.test(error.message);
}

// The formats to try, in order. A pinned format is used as asked; auto is
// mp3 first, then pcm. That pcm-only models stay mp3-only questions is
// remembered for the model for a few minutes, so one clip costs the extra
// round trip, not every one.
type FormatMemory = Map<string, { at: number }>;
declare global {
  var __odmTtsFormat: FormatMemory | undefined;
}
const FORMAT_TTL_MS = 10 * 60_000;

export function forgetFormatMemory() {
  globalThis.__odmTtsFormat = undefined;
}

function formatPlan(backend: TtsBackend): ("mp3" | "pcm")[] {
  if (backend.responseFormat !== "auto") {
    return [backend.responseFormat];
  }
  const memory = (globalThis.__odmTtsFormat ??= new Map());
  const learned = memory.get(`${backend.v1}|${backend.model}`);
  if (learned && Date.now() - learned.at < FORMAT_TTL_MS) {
    return ["pcm"];
  }
  return ["mp3", "pcm"];
}

function rememberFormat(backend: TtsBackend, format: "mp3" | "pcm") {
  if (format === "pcm") {
    (globalThis.__odmTtsFormat ??= new Map()).set(`${backend.v1}|${backend.model}`, { at: Date.now() });
  }
}

// A request that timed out is asked once more: a provider that stalls on one
// request usually answers the next in seconds. A refused format is asked for
// in the next format the plan holds. Any other failure is final.
async function requestSpeech(
  backend: TtsBackend,
  input: string,
  voice: string,
  speed: number,
  options: SpeechRequestOptions = {},
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? speechTimeoutMs(input.length);
  const formats = formatPlan(backend);
  let last: unknown;
  for (const format of formats) {
    try {
      // A provider that stalls on one request usually answers the next in
      // seconds, so a timeout is retried before a format is given up on.
      try {
        return await requestSpeechOnce(backend, input, voice, speed, timeoutMs, format);
      } catch (error) {
        if (!isSpeechTimeout(error)) {
          throw error;
        }
        console.warn(`[tts] speech request timed out after ${timeoutMs} ms; asking once more`);
        return await requestSpeechOnce(backend, input, voice, speed, timeoutMs, format);
      }
    } catch (error) {
      last = error;
      const more = format !== formats[formats.length - 1];
      if (more && refusesFormat(error)) {
        // The refusal named the format the plan was on; the plan's next
        // format is the one this model answers, and that is remembered.
        rememberFormat(backend, "pcm");
        continue;
      }
      throw error;
    }
  }
  throw last ?? new SpeechEmptyError();
}

// The model a passage is asked for: the one picked (or TTS_MODEL), else, on
// an OpenAI-compatible server that is not OpenAI itself, the only model it
// lists, the way dictation's Whisper service runs its one (src/lib/stt.ts).
// OpenAI lists dozens, so nothing is taken from its list. "" when there is
// none: nothing is sent, and the readiness checks say narration is not
// ready (src/lib/capabilities.ts).
export async function narrationModel(backend: TtsBackend): Promise<string> {
  // OpenRouter lists many speech models, so nothing is taken from its list
  // either: a pick is required, the way OpenAI's dozens are.
  if (backend.model || backend.provider === "openrouter" || backend.provider !== "openai" || isOpenAiHost(backend.v1)) {
    return backend.model;
  }
  return soleListedModel({ provider: "speech", baseUrl: backend.v1, apiKey: backend.apiKey });
}

// The backend with its model settled, for a caller that sends several clips
// or names the model (the usage ledger, the render cache, the admin's test).
export async function withNarrationModel(backend: TtsBackend): Promise<TtsBackend> {
  const model = await narrationModel(backend);
  return model === backend.model ? backend : { ...backend, model };
}

// One clip of speech from the configured server.
export async function synthesizeSpeech(
  input: string,
  voice: string,
  speed = 1,
  configured: TtsBackend = ttsBackend(),
  options: SpeechRequestOptions = {},
): Promise<Buffer> {
  if (configured.provider === "off") {
    throw new Error("Narration is switched off on this server.");
  }
  const backend = await withNarrationModel(configured);
  if (!backend.model) {
    throw new SpeechModelMissingError();
  }
  const voices = backend.provider === "kokoro" ? [] : await serverVoiceIds(backend);
  // A local server with no default named falls back to the first voice it
  // lists, as the admin form says it will.
  const defaultVoice = backend.defaultVoice || voices[0] || "";
  return requestSpeech(backend, input, effectiveVoice(voice, { ...backend, defaultVoice }, voices), speed, options);
}

type VoiceCacheEntry = { at: number; ids: string[]; listed: boolean };

declare global {
  var __odmTtsVoices: Map<string, VoiceCacheEntry> | undefined;
}

const VOICE_CACHE_MS = 60_000;

// The voices the server lists, with whether it listed them itself. Kept a
// minute per address: every passage asks on an OpenAI-kind server, and the
// picker asks whenever a settings panel opens.
export async function serverVoices(backend: TtsBackend = ttsBackend(), fresh = false): Promise<{ ids: string[]; listed: boolean }> {
  if (backend.provider === "off") {
    return { ids: [], listed: false };
  }
  const cache = (globalThis.__odmTtsVoices ??= new Map());
  const key = `${backend.provider}|${backend.v1}|${backend.model}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < VOICE_CACHE_MS) {
    return { ids: hit.ids, listed: hit.listed };
  }
  let ids: string[] = [];
  let listed = false;
  // OpenRouter has no voices endpoint, but its models list names each speech
  // model's voices (supported_voices), so the model's own row is the list.
  if (backend.provider === "openrouter") {
    try {
      const response = await fetch(`${backend.v1}/models?output_modalities=speech`, {
        cache: "no-store",
        headers: backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {},
        signal: AbortSignal.timeout(4_000),
      });
      if (response.ok) {
        ids = openRouterVoiceList(await response.json().catch(() => null), backend.model);
        listed = ids.length > 0;
      }
    } catch {
      // Unreachable or unmapped: the fallback below.
    }
  }
  // OpenAI itself has no such endpoint; asking only spends a round trip.
  if (!listed && backend.provider !== "openrouter" && !isOpenAiHost(backend.v1)) {
    try {
      const response = await fetch(`${backend.v1}/audio/voices`, {
        cache: "no-store",
        headers: backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {},
        signal: AbortSignal.timeout(4_000),
      });
      if (response.ok) {
        ids = parseVoiceList(await response.json().catch(() => null));
        listed = ids.length > 0;
      }
    } catch {
      // Unreachable or not a server that lists voices: the fallback below.
    }
  }
  if (!listed) {
    ids = fallbackVoices(backend);
  }
  cache.set(key, { at: Date.now(), ids, listed });
  return { ids, listed };
}

async function serverVoiceIds(backend: TtsBackend): Promise<string[]> {
  return (await serverVoices(backend)).ids;
}
