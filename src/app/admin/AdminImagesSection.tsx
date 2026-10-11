"use client";

import { ui } from "@/lib/ui";
import { PageSection } from "@/components/PageShell";
import { FilterableModelPicker, type PickerModel } from "@/components/FilterableModelPicker";
import {
  Field,
  SecretField,
  SelectField,
  type EnvDefaults,
  type MaskedConfig,
} from "@/app/admin/AdminSettingsFields";
import { useEffect, useRef, useState } from "react";

// Image generation. The picker names the backend new campaigns start on; a
// campaign may still pick any backend that is set up here, so each backend
// keeps its own block of fields (address, model, key), the chosen one open
// and first, the rest folded away under it (issue 89: the fields used to sit
// in one flat grid, and nothing said which belonged to which backend).

type Images = MaskedConfig["images"];
type Group = "comfyui" | "flux" | "openai";

function groupOf(backend: string): Group | null {
  if (backend === "comfyui") return "comfyui";
  if (backend === "mflux-hs" || backend === "sdnq-hs") return "flux";
  if (backend === "openai") return "openai";
  return null;
}

const GROUP_TITLE: Record<Group, string> = {
  comfyui: "ComfyUI",
  flux: "FLUX worker",
  openai: "OpenAI-compatible images API",
};

// The checkpoint list one ComfyUI answered with, kept per address: changing
// the URL asks the new server, coming back does not ask the old one again,
// and a repeated render of the panel does not ask twice within a minute.
type CheckpointEntry = { models: PickerModel[]; ok: boolean; error: string; at: number };
type CheckpointCache = Map<string, CheckpointEntry>;

const CHECKPOINT_CACHE_MS = 60_000;

// The ComfyUI model file field as a picker over the server's own /object_info
// lists (unet files first, then plain checkpoints). The list is asked on
// change of the URL — debounce-free: each settled value fires one request,
// cached per URL for a minute — and while it is empty or the server is
// silent, the field stays a plain text input, so a working setup can never be
// blocked by a dropdown that has nothing to show.
function ComfyCheckpointPicker({
  url,
  value,
  onChange,
  placeholder,
}: {
  url: string;
  value: string;
  onChange: (checkpoint: string) => void;
  placeholder: string;
}) {
  const [cache, setCache] = useState<CheckpointCache>(() => new Map());
  const [busy, setBusy] = useState(false);
  const cacheRef = useRef(cache);
  // The effect reads the cache without listing it as a dependency (only a
  // settled URL re-fires the request); the ref is synced in an effect, not
  // during render.
  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);
  const inflight = useRef("");

  const settled = url.trim().replace(/\/+$/, "");
  const entry = cache.get(settled);

  useEffect(() => {
    if (!settled) {
      return;
    }
    const hit = cacheRef.current.get(settled);
    if (hit && Date.now() - hit.at < CHECKPOINT_CACHE_MS) {
      return;
    }
    if (inflight.current === settled) {
      return;
    }
    inflight.current = settled;
    setBusy(true);
    fetch("/api/comfy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: settled }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; error?: string; checkpoints?: unknown } | null) => {
        const models: PickerModel[] = Array.isArray(data?.checkpoints)
          ? (data!.checkpoints as unknown[]).filter((name): name is string => typeof name === "string").map((name) => ({ id: name, label: name }))
          : [];
        setCache((current) => {
          const next = new Map(current);
          next.set(settled, { models, ok: Boolean(data?.ok), error: data?.error ?? "", at: Date.now() });
          return next;
        });
      })
      .catch(() => {
        setCache((current) => {
          const next = new Map(current);
          next.set(settled, { models: [], ok: false, error: "Could not reach ComfyUI.", at: Date.now() });
          return next;
        });
      })
      .finally(() => {
        if (inflight.current === settled) {
          inflight.current = "";
          setBusy(false);
        }
      });
  }, [settled]);

  if (!entry || !entry.models.length) {
    return (
      <div role="group" aria-label="Model file" className="block">
        <span className="mb-1 block text-xs font-medium text-stone-400">Model file</span>
        <input
          className={ui.input}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <span className="mt-1 block text-[11px] leading-4 text-stone-500">
          {busy
            ? "Asking the server for its model list…"
            : entry && !entry.ok
              ? "The server did not answer, so the model file is typed by name; full checkpoint or unet file."
              : "A full checkpoint (SD/SDXL) or a unet file such as a Krea2 or Flux.2 model."}
        </span>
      </div>
    );
  }
  return (
    <FilterableModelPicker
      label="Model file"
      models={entry.models}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  );
}

export function AdminImagesSection({
  images,
  env,
  harness,
  phoneWorld,
  openaiKey,
  onImages,
  onOpenaiKey,
}: {
  images: Images;
  env: EnvDefaults;
  harness: MaskedConfig["harness"];
  // A phone cannot run ComfyUI or a FLUX worker.
  phoneWorld: boolean;
  openaiKey: string;
  onImages: (images: Images) => void;
  onOpenaiKey: (value: string) => void;
}) {
  const set = (patch: Partial<Images>) => onImages({ ...images, ...patch });
  // The backend "Auto" resolves to, so its fields are the ones shown open.
  const effective = images.defaultBackend || env.imageBackend || "comfyui";
  const active = groupOf(effective);

  const blocks: Record<Group, React.ReactNode> = {
    comfyui: (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Server URL" hint={`Env: ${env.comfyUrl}`}>
          <input
            className={ui.input}
            value={images.comfyUrl}
            onChange={(event) => set({ comfyUrl: event.target.value })}
            placeholder={env.comfyUrl}
          />
        </Field>
        <ComfyCheckpointPicker
          url={images.comfyUrl || env.comfyUrl}
          value={images.comfyCheckpoint}
          onChange={(comfyCheckpoint) => set({ comfyCheckpoint })}
          placeholder="krea2Fp8Nvfp4Mixed_turbo.safetensors"
        />
      </div>
    ),
    flux: (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Worker URL" hint={`Env: ${env.fluxWorkerUrl}. The worker loads its own FLUX model.`}>
          <input
            className={ui.input}
            value={images.fluxWorkerUrl}
            onChange={(event) => set({ fluxWorkerUrl: event.target.value })}
            placeholder={env.fluxWorkerUrl}
          />
        </Field>
      </div>
    ),
    openai: (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Server base URL"
          hint="OpenAI itself, or any server with OpenAI's /v1/images/generations. Blank = api.openai.com."
        >
          <input
            className={ui.input}
            value={images.openaiBaseUrl}
            onChange={(event) => set({ openaiBaseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label="Model name" hint="Blank = gpt-image-1.">
          <input
            className={ui.input}
            value={images.openaiModel}
            onChange={(event) => set({ openaiModel: event.target.value })}
            placeholder="gpt-image-1"
          />
        </Field>
        <SecretField
          label="API key"
          isSet={images.hasOpenaiApiKey}
          value={openaiKey}
          onChange={onOpenaiKey}
          hint={
            env.hasOpenaiImageApiKey
              ? "An env-var key is also set; this one wins when filled."
              : "Billed to whoever owns the key. Used only when a campaign's backend is this API."
          }
        />
      </div>
    ),
  };

  const offered = (["comfyui", "flux", "openai"] as Group[]).filter((group) => !phoneWorld || group === "openai");
  const others = offered.filter((group) => group !== active);

  return (
    <PageSection id="admin-images" heading="Image generation" glyph="sense-truesight">
      <div className="mb-3">
        <SelectField<Images["defaultBackend"]>
          label="Default backend"
          hint={
            phoneWorld
              ? "For new campaigns. The OpenAI-compatible API renders on another machine with the key below and needs no GPU here."
              : "For new campaigns; a campaign can pick any backend that is set up below. ComfyUI and the FLUX workers run on this machine; an OpenAI-compatible API renders wherever its address points."
          }
          value={images.defaultBackend}
          onChange={(defaultBackend) => set({ defaultBackend })}
          options={[
            { value: "", label: `Auto (${env.imageBackend || "ComfyUI"})` },
            ...(phoneWorld ? [] : [{ value: "comfyui" as const, label: "ComfyUI (local)" }]),
            { value: "openai", label: "OpenAI-compatible images API" },
            ...(phoneWorld
              ? []
              : [
                  { value: "mflux-hs" as const, label: "FLUX worker: mflux (Apple Silicon)" },
                  { value: "sdnq-hs" as const, label: "FLUX worker: sdnq (CUDA/ROCm)" },
                ]),
            // Only once the agent program has painted a real test picture.
            ...(harness?.images === "native" && harness.imagesVerifiedAt
              ? [{ value: "harness" as const, label: "The agent program's own pictures" }]
              : []),
          ]}
        />
      </div>
      {active && offered.includes(active) ? (
        // Keyed, so picking another backend brings its block in.
        <div key={active} className="reveal">
          <h3 className="mb-2 text-sm font-medium text-stone-200">{GROUP_TITLE[active]}</h3>
          {blocks[active]}
        </div>
      ) : effective === "harness" ? (
        <p className="reveal text-xs text-stone-500">
          Pictures come from the agent program set up in the Agent section; it has no address or key of its own.
        </p>
      ) : null}
      {others.length ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-stone-500">Other backends a campaign can pick:</p>
          {others.map((group) => (
            <details key={group} className="rounded-lg border border-stone-800 bg-stone-950/40 px-3 py-2">
              <summary className="cursor-pointer text-sm text-stone-300">{GROUP_TITLE[group]}</summary>
              <div className="mt-3">{blocks[group]}</div>
            </details>
          ))}
        </div>
      ) : null}
    </PageSection>
  );
}
