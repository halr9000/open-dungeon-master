"use client";

import { Check, Loader2, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { registerOutput, releaseOutput } from "@/lib/audio-devices";
import { ui } from "@/lib/ui";
import { Select } from "@/components/ui/Select";
import { BuiltinSpeechCard } from "@/app/admin/BuiltinSpeechCard";
import { HarnessPictureTest } from "@/app/admin/HarnessPictureTest";
import type { Draft } from "@/app/setup/draft";
import { ChoiceCard, ChoiceCards, Lamp, host, type ScanResult } from "@/app/setup/SetupParts";

// Pictures and Voice: optional, so each offers "none" as a real answer, and
// each prefers what the scan found on this computer (free) over anything
// billed to a key.

type Update = (change: (draft: Draft) => Draft) => void;

const MEDIA_GUIDE = "https://github.com/Lebbitheplow/open-dungeon-master/blob/main/docs/media-setup.md";

function KeyField({ label, value, onChange, saved, hint }: { label: string; value: string; onChange: (value: string) => void; saved: boolean; hint: string }) {
  return (
    <label className="reveal block">
      <span className="mb-1 block text-xs font-medium text-stone-400">{label}</span>
      <input
        type="password"
        className={ui.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={saved ? "•••••••• (saved, leave blank to keep it)" : "sk-..."}
        autoComplete="off"
      />
      <span className="mt-1 block text-[11px] text-stone-500">{hint}</span>
    </label>
  );
}

export function PicturesStep({
  draft,
  update,
  scan,
  scanning,
  storyIsOpenAi,
  agentPaints,
  agentVerified,
  agentLabel,
  onAgentVerified,
  openaiKeySaved,
}: {
  draft: Draft;
  update: Update;
  scan: ScanResult | null;
  scanning: boolean;
  storyIsOpenAi: boolean;
  // The storyteller chosen on the last step has an image tool of its own.
  agentPaints: boolean;
  // A test picture has come back from it on this server.
  agentVerified: boolean;
  agentLabel: string;
  onAgentVerified: () => void;
  openaiKeySaved: boolean;
}) {
  const comfy = scan?.comfyui ?? null;
  const pick = (pictures: Draft["pictures"]) =>
    update((current) => ({
      ...current,
      pictures,
      comfy: pictures === "comfyui" && !current.comfy.url && comfy ? { url: comfy.url, checkpoint: current.comfy.checkpoint || comfy.checkpoints[0] || "" } : current.comfy,
    }));
  const setComfy = (patch: Partial<Draft["comfy"]>) => update((current) => ({ ...current, comfy: { ...current.comfy, ...patch } }));
  const setOpenai = (patch: Partial<Draft["picturesOpenai"]>) =>
    update((current) => ({ ...current, picturesOpenai: { ...current.picturesOpenai, ...patch } }));

  return (
    <div className="space-y-4">
      <ChoiceCards label="Pictures">
        <ChoiceCard
          picked={draft.pictures === "comfyui"}
          onPick={() => pick("comfyui")}
          glyph="sense-truesight"
          title="ComfyUI on this computer"
          sub="Portraits, scene art and battle maps, painted on your own GPU. Free to run."
          badge={scanning ? { text: "Looking…", tone: "off" } : comfy ? { text: "Found", tone: "ready" } : { text: "Not found", tone: "off" }}
        />
        <ChoiceCard
          picked={draft.pictures === "openai"}
          onPick={() => pick("openai")}
          glyph="tab-admin"
          title="OpenAI-compatible images API"
          sub={
            storyIsOpenAi && !draft.picturesOpenai.baseUrl.trim()
              ? "On the key from the last step. Each picture is billed to it."
              : "Billed to an API key, per picture. OpenAI itself, or any server with the same images API. No GPU needed."
          }
        />
        {agentPaints ? (
          <ChoiceCard
            picked={draft.pictures === "agent"}
            onPick={() => pick("agent")}
            glyph="system-share"
            title={`${agentLabel} paints`}
            sub={
              agentVerified
                ? `${agentLabel}'s own image tool, on its own plan. It painted a test map here already.`
                : `${agentLabel}'s own image tool, on its own plan. One test map first, painted the way a table asks for one.`
            }
            badge={agentVerified ? { text: "Tested", tone: "ready" } : null}
          />
        ) : null}
        <ChoiceCard
          picked={draft.pictures === "none"}
          onPick={() => pick("none")}
          glyph="tab-handout"
          title="No pictures for now"
          sub="Painted placeholders stand in. A ComfyUI started later on this computer is picked up on its own."
        />
      </ChoiceCards>

      {draft.pictures === "comfyui" ? (
        <div key="comfy" className="reveal-height space-y-3">
          {!comfy && !scanning ? (
            <p className="su-note">
              Nothing answered at ComfyUI&apos;s usual address. Start ComfyUI (its default port is 8188), or type where it runs.{" "}
              <a href={MEDIA_GUIDE} target="_blank" rel="noreferrer" className="text-amber-200 underline">
                Installing ComfyUI, step by step
              </a>
              .
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-400">ComfyUI address</span>
              <input className={ui.input} value={draft.comfy.url} onChange={(event) => setComfy({ url: event.target.value })} placeholder="http://127.0.0.1:8188" />
            </label>
            {comfy?.checkpoints.length ? (
              <div role="group" aria-label="Model file" className="block">
                <span className="mb-1 block text-xs font-medium text-stone-400">Model file</span>
                <Select
                  value={draft.comfy.checkpoint}
                  onChange={(checkpoint) => setComfy({ checkpoint })}
                  options={comfy.checkpoints.map((name) => ({ value: name, label: name }))}
                  label="Model file"
                  className="w-full"
                />
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-stone-400">Model file</span>
                <input className={ui.input} value={draft.comfy.checkpoint} onChange={(event) => setComfy({ checkpoint: event.target.value })} placeholder="Any checkpoint or unet file ComfyUI has installed" />
              </label>
            )}
          </div>
          <p className="text-[11px] text-stone-500">Any model works; the campaign&apos;s genre supplies the art style. Krea2-class unet files pick their encoder and VAE automatically.</p>
        </div>
      ) : draft.pictures === "agent" ? (
        <div key="agent" className="reveal-height">
          <HarnessPictureTest
            saved
            picturesVerified={agentVerified}
            picturesForTables={false}
            offerAdopt={false}
            onVerified={onAgentVerified}
          />
        </div>
      ) : draft.pictures === "openai" ? (
        <div key="openai" className="reveal-height space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-400">Server base URL</span>
              <input
                className={ui.input}
                value={draft.picturesOpenai.baseUrl}
                onChange={(event) => setOpenai({ baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1 (blank = OpenAI itself)"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-400">Model name</span>
              <input
                className={ui.input}
                value={draft.picturesOpenai.model}
                onChange={(event) => setOpenai({ model: event.target.value })}
                placeholder="gpt-image-1"
              />
            </label>
          </div>
          {storyIsOpenAi && !draft.picturesOpenai.baseUrl.trim() ? (
            <p className="su-note">Pictures go to OpenAI on the storyteller&apos;s key. Nothing more to paste.</p>
          ) : (
            <KeyField
              label="API key"
              value={draft.picturesKey}
              onChange={(picturesKey) => update((current) => ({ ...current, picturesKey }))}
              saved={openaiKeySaved}
              hint="Billed to whoever owns the key. A compatible proxy needs its own key here; OpenAI itself takes the storyteller's."
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

type TestResult = { ok: boolean; model?: string; voice?: string; audio?: string; error?: string };

function NarrationTest({ body }: { body: Record<string, string> }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The clip's blob URL, freed when the component goes away or replays.
  const clipUrlRef = useRef("");

  function dropClip() {
    audioRef.current?.pause();
    if (audioRef.current) {
      releaseOutput(audioRef.current);
      audioRef.current = null;
    }
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = "";
    }
  }

  // Leaving the step must not leave a clip talking or a URL stranded.
  useEffect(() => dropClip, []);

  async function test() {
    setTesting(true);
    setResult(null);
    dropClip();
    try {
      const response = await fetch("/api/admin/tts-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as TestResult | null;
      setResult(data ?? { ok: false, error: "The test request failed without an answer." });
      if (data?.ok && data.audio) {
        // Through a blob URL with the play() promise awaited: a browser that
        // refuses playback (autoplay policy, no audio device) says so here
        // instead of the test quietly "passing" in silence.
        clipUrlRef.current = URL.createObjectURL(await (await fetch(data.audio)).blob());
        const audio = registerOutput(new Audio(clipUrlRef.current));
        audioRef.current = audio;
        audio.onended = () => {
          releaseOutput(audio);
          URL.revokeObjectURL(clipUrlRef.current);
          clipUrlRef.current = "";
        };
        try {
          await audio.play();
        } catch (error) {
          setResult({ ok: false, error: `audio blocked: ${error instanceof Error ? error.message : error}` });
        }
      }
    } catch {
      setResult({ ok: false, error: "Could not reach this server." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={test} disabled={testing} aria-busy={testing} className={ui.btnSmall}>
        {testing ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />} Hear a line
      </button>
      {result?.ok ? (
        <p role="status" className="live-in flex items-center gap-1 text-sm text-emerald-400">
          <Check className="tick-in size-4" /> Spoken by {result.model} in the voice {result.voice}.
        </p>
      ) : result ? (
        <p role="alert" className="motion-shake flex items-start gap-1 text-sm text-red-400">
          <X className="mt-0.5 size-4 shrink-0" /> {result.error || "The speech server did not answer."}
        </p>
      ) : null}
    </div>
  );
}

export function VoiceStep({
  draft,
  update,
  scan,
  scanning,
  storyIsOpenAi,
  ttsKeySaved,
  falKeySaved,
}: {
  draft: Draft;
  update: Update;
  scan: ScanResult | null;
  scanning: boolean;
  storyIsOpenAi: boolean;
  ttsKeySaved: boolean;
  falKeySaved: boolean;
}) {
  const kokoro = scan?.kokoro ?? null;
  const whisper = scan?.whisper ?? null;
  const pick = (narration: Draft["narration"]) =>
    update((current) => ({
      ...current,
      narration,
      kokoro:
        narration === "kokoro" && !current.kokoro.url && kokoro
          ? { url: kokoro.url, voice: current.kokoro.voice || (kokoro.voices.includes("af_heart") ? "af_heart" : kokoro.voices[0] ?? "") }
          : current.kokoro,
    }));
  const setKokoro = (patch: Partial<Draft["kokoro"]>) => update((current) => ({ ...current, kokoro: { ...current.kokoro, ...patch } }));
  const setNarrationOpenai = (patch: Partial<Draft["narrationOpenai"]>) =>
    update((current) => ({ ...current, narrationOpenai: { ...current.narrationOpenai, ...patch } }));
  const setNarrationFal = (patch: Partial<Draft["narrationFal"]>) =>
    update((current) => ({ ...current, narrationFal: { ...current.narrationFal, ...patch } }));

  return (
    <div className="space-y-4">
      <ChoiceCards label="Narration">
        <ChoiceCard
          picked={draft.narration === "kokoro"}
          onPick={() => pick("kokoro")}
          glyph="tab-ambience"
          title="Kokoro on this computer"
          sub="Reads each passage aloud in the campaign's chosen voice. Free, and the text stays here."
          badge={scanning ? { text: "Looking…", tone: "off" } : kokoro ? { text: "Found", tone: "ready" } : { text: "Not found", tone: "off" }}
        />
        <ChoiceCard
          picked={draft.narration === "openai"}
          onPick={() => pick("openai")}
          glyph="tab-admin"
          title="OpenAI-compatible speech server"
          sub={
            storyIsOpenAi && !draft.narrationOpenai.baseUrl.trim()
              ? "On the storyteller's key. Every passage read aloud is billed to it."
              : "OpenAI itself, or any server with the same speech API, billed to an API key. No GPU needed."
          }
        />
        <ChoiceCard
          picked={draft.narration === "openrouter"}
          onPick={() => pick("openrouter")}
          glyph="system-share"
          title="OpenRouter (cloud)"
          sub="Reads passages aloud through OpenRouter's Kokoro endpoint, on the OpenRouter key the storyteller already uses. No GPU needed."
        />
        <ChoiceCard
          picked={draft.narration === "fal"}
          onPick={() => pick("fal")}
          glyph="system-share"
          title="fal.ai (cloud)"
          sub="Reads passages aloud through a fal.ai speech model (Chatterbox by default) on a fal.ai key, billed per character. No GPU needed."
        />
        <ChoiceCard
          picked={draft.narration === "off"}
          onPick={() => pick("off")}
          glyph="tab-handout"
          title="Text only"
          sub="No narration. Nothing is sent anywhere to be spoken."
        />
      </ChoiceCards>

      {draft.narration === "kokoro" ? (
        <div key="kokoro" className="reveal-height space-y-3">
          {!kokoro && !scanning ? (
            <p className="su-note">
              Nothing answered at Kokoro&apos;s usual address (port 8880). One Docker command starts it:{" "}
              <code className="text-amber-100">docker run -d --name kokoro -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest</code>.{" "}
              <a href={MEDIA_GUIDE} target="_blank" rel="noreferrer" className="text-amber-200 underline">
                More in the media guide
              </a>
              .
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-400">Kokoro address</span>
              <input className={ui.input} value={draft.kokoro.url} onChange={(event) => setKokoro({ url: event.target.value })} placeholder="http://127.0.0.1:8880" />
            </label>
            {kokoro?.voices.length ? (
              <div role="group" aria-label="Default voice" className="block">
                <span className="mb-1 block text-xs font-medium text-stone-400">Default voice</span>
                <Select
                  value={draft.kokoro.voice}
                  onChange={(voice) => setKokoro({ voice })}
                  options={kokoro.voices.map((voice) => ({ value: voice, label: voice }))}
                  label="Default voice"
                  className="w-full"
                />
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-stone-400">Default voice</span>
                <input className={ui.input} value={draft.kokoro.voice} onChange={(event) => setKokoro({ voice: event.target.value })} placeholder="af_heart" />
              </label>
            )}
          </div>
          <NarrationTest body={{ provider: "kokoro", kokoroUrl: draft.kokoro.url, voice: draft.kokoro.voice }} />
        </div>
      ) : draft.narration === "openai" ? (
        <div key="openai" className="reveal-height space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-400">Server base URL</span>
              <input
                className={ui.input}
                value={draft.narrationOpenai.baseUrl}
                onChange={(event) => setNarrationOpenai({ baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1 (blank = OpenAI itself)"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-400">Model name</span>
              <input
                className={ui.input}
                value={draft.narrationOpenai.model}
                onChange={(event) => setNarrationOpenai({ model: event.target.value })}
                placeholder="gpt-4o-mini-tts"
              />
            </label>
          </div>
          {storyIsOpenAi && !draft.narrationOpenai.baseUrl.trim() ? null : (
            <KeyField
              label="API key"
              value={draft.narrationKey}
              onChange={(narrationKey) => update((current) => ({ ...current, narrationKey }))}
              saved={ttsKeySaved}
              hint="Used only for narration. A compatible proxy needs its own key here; OpenAI itself takes the storyteller's, or the key saved for pictures."
            />
          )}
          <NarrationTest body={{ provider: "openai", baseUrl: draft.narrationOpenai.baseUrl, model: draft.narrationOpenai.model, apiKey: draft.narrationKey }} />
        </div>
      ) : draft.narration === "fal" ? (
        <div key="fal" className="reveal-height space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-400">Model</span>
              <input
                className={ui.input}
                value={draft.narrationFal.model}
                onChange={(event) => setNarrationFal({ model: event.target.value })}
                placeholder="fal-ai/chatterbox"
              />
            </label>
            <KeyField
              label="fal.ai API key"
              value={draft.narrationFal.apiKey}
              onChange={(apiKey) => setNarrationFal({ apiKey })}
              saved={falKeySaved}
              hint="Billed per character. The same key the pictures' fal.ai backend uses, if you set one there."
            />
          </div>
          <p className="text-[11px] text-stone-500">Voice ids are per model — Chatterbox takes its own; the model&apos;s fal.ai page documents them.</p>
          <NarrationTest body={{ provider: "fal", model: draft.narrationFal.model, falApiKey: draft.narrationFal.apiKey }} />
        </div>
      ) : draft.narration === "openrouter" ? (
        <div key="openrouter" className="reveal-height space-y-3">
          <p className="su-note">
            Narration goes to OpenRouter&apos;s speech endpoint on the OpenRouter key from the storyteller step — the
            model is OpenRouter&apos;s Kokoro (hexgrad/kokoro-82m), and nothing more to paste. Set an OpenRouter key in
            the admin panel&apos;s Text model section if there is not one saved already.
          </p>
          <NarrationTest body={{ provider: "openrouter" }} />
        </div>
      ) : null}

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-stone-200">Push-to-talk dictation</h4>
        {whisper ? (
          <p className="su-row text-sm text-stone-300">
            <Lamp tone="ok" /> A Whisper server at {host(whisper.url)} turns speech into text. Nothing to set up.
          </p>
        ) : storyIsOpenAi ? (
          <p className="su-row text-sm text-stone-300">
            <Lamp tone="ok" /> The OpenAI key takes dictation too. Nothing to set up.
          </p>
        ) : (
          <>
            <p className="text-xs text-stone-500">
              No Whisper server answered. The built-in engine runs right here, on the CPU, after a one-time download:
            </p>
            <BuiltinSpeechCard />
          </>
        )}
      </div>
    </div>
  );
}
