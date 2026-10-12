import { configValue, getGlobalConfig } from "@/lib/app-config";
import { currentUser } from "@/lib/auth";
import { imagesConfigured, storyConfigured } from "@/lib/capabilities";
import { getDatabase } from "@/lib/db/core";
import { configuredDefaultStorySettings } from "@/lib/runtime-defaults";
import { serverEnv } from "@/lib/server-env";
import { LOCAL_TEXT_MODEL_IDS } from "@/lib/text-models";

export const runtime = "nodejs";

type Flux = { ok: boolean; loaded: boolean };
type LocalText = { ok: boolean; installedModels: string[] };

// The two backend checks below, each remembered for a few seconds and shared
// by callers that arrive while one is running, so a screen polling health
// (or several of them) costs one request per backend, not one each.
const STATUS_CACHE_MS = 10_000;

declare global {
  var __odmHealthStatus: Map<string, { at: number; value: Promise<unknown> }> | undefined;
}

function remembered<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = (globalThis.__odmHealthStatus ??= new Map());
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < STATUS_CACHE_MS) {
    return hit.value as Promise<T>;
  }
  const value = load();
  store.set(key, { at: now, value });
  return value;
}

async function fluxStatus(workerUrl: string): Promise<Flux> {
  try {
    const response = await fetch(`${workerUrl.replace(/\/$/, "")}/health`, {
      cache: "no-store",
      // A dead worker must cost this endpoint a bounded wait, not a hang.
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok ? ((await response.json()) as Flux) : { ok: false, loaded: false };
  } catch {
    return { ok: false, loaded: false };
  }
}

async function localTextStatus(ollamaUrl: string): Promise<LocalText> {
  try {
    const response = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/tags`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return { ok: false, installedModels: [] };
    }
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    // Ollama resolves model names case-insensitively, so match the same way
    // (a pre-existing "Gemma4" repo can store tags with different casing).
    const installed = new Set(
      (data.models || [])
        .map((model) => (model.name || "").toLowerCase())
        .filter(Boolean),
    );
    return {
      ok: true,
      installedModels: LOCAL_TEXT_MODEL_IDS.filter((id) => installed.has(id.toLowerCase())),
    };
  } catch {
    return { ok: false, installedModels: [] };
  }
}

// Whether the world can be read at all. A listening server whose database
// will not open (a wrong key, a damaged file) used to answer "ok" here, and
// the apps, which wait on this before showing a world, showed one that
// failed on every read.
function databaseReady(): boolean {
  try {
    getDatabase().prepare("SELECT 1").get();
    return true;
  } catch (error) {
    console.error("[health] the database cannot be read", error);
    return false;
  }
}

export async function GET() {
  if (!databaseReady()) {
    return Response.json({ ok: false, error: "The world's database cannot be read." }, { status: 503 });
  }
  // Unauthenticated callers get a bare readiness probe; configuration details
  // (model names, which keys are set, backend reachability) require a login.
  const user = await currentUser();
  if (!user) {
    return Response.json({ ok: true });
  }

  const workerUrl = serverEnv("FLUX_WORKER_URL", "http://127.0.0.1:7869");
  const ollamaUrl = serverEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  // Side by side: two dead backends used to cost this endpoint six seconds.
  const [flux, localText] = await Promise.all([
    remembered(`flux:${workerUrl}`, () => fluxStatus(workerUrl)),
    remembered(`ollama:${ollamaUrl}`, () => localTextStatus(ollamaUrl)),
  ]);

  // The env-var flags above predate the admin panel; the DB-backed config is
  // what the desktop shell writes and what the DM path resolves, so report it
  // too. Config-only flags, no probes: /api/capabilities owns reachability.
  const settings = configuredDefaultStorySettings();
  const cfg = getGlobalConfig();
  const hasOpenaiImageKey = Boolean(
    cfg.images.openaiApiKey || serverEnv("OPENAI_IMAGE_API_KEY") || serverEnv("OPENAI_API_KEY"),
  );

  return Response.json({
    openRouterConfigured: Boolean(serverEnv("OPENROUTER_API_KEY")),
    model: serverEnv("OPENROUTER_MODEL", "google/gemini-3.5-flash"),
    maxTokens: Number.parseInt(serverEnv("OPENROUTER_MAX_TOKENS", "16384"), 10),
    localText,
    flux,
    custom: {
      configured: settings.textProvider === "custom" && storyConfigured(settings),
      story: storyConfigured(settings),
      // Config-only, like the rest of this block: a self-hosted backend
      // counts here only when its URL was named. /api/capabilities adds the
      // default-URL probe.
      images: imagesConfigured(
        settings.imageBackend,
        hasOpenaiImageKey,
        settings.imageBackend === "comfyui"
          ? configValue(cfg.images.comfyUrl, "COMFYUI_URL")
          : serverEnv("FLUX_WORKER_URL"),
        false,
      ),
      tts: Boolean(configValue(cfg.speech.kokoroUrl, "KOKORO_URL")),
    },
  });
}
