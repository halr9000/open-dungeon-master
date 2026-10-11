import { z } from "zod";
import { isErrorResponse, requireAdmin } from "@/lib/admin-api";
import { PREVIEW_LINE } from "@/lib/tts";
import { describeSpeechFailure, serverVoices, synthesizeSpeech, ttsBackend } from "@/lib/tts-backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  provider: z.enum(["", "kokoro", "openai", "openrouter", "fal", "off"]).default(""),
  kokoroUrl: z.string().trim().max(500).default(""),
  baseUrl: z.string().trim().max(500).default(""),
  model: z.string().trim().max(200).default(""),
  // Only a freshly typed key; blank falls back to the saved one.
  apiKey: z.string().optional(),
  falApiKey: z.string().optional(),
  voice: z.string().trim().max(120).default(""),
});

// The narration counterpart of the text model's "Test backend": speak one
// line on the server as typed in the admin form (blanks fall back to the
// saved settings and env, the way a real passage resolves them), and hand
// the clip back so the admin hears it. A failure answers with the same
// sentence a table would be shown.
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid test request." }, { status: 400 });
  }
  const form = parsed.data;
  const backend = ttsBackend({
    provider: form.provider,
    kokoroUrl: form.kokoroUrl,
    openaiUrl: form.baseUrl,
    model: form.model,
    apiKey: form.apiKey,
    voice: form.voice,
    falApiKey: form.falApiKey,
  });
  const endpoint = backend.provider === "fal" ? `${backend.v1}/${backend.model}` : `${backend.v1}/audio/speech`;
  if (backend.provider === "off") {
    return Response.json({ ok: false, endpoint: "", error: "Narration is switched off, so there is nothing to test." });
  }
  const { ids, listed } = await serverVoices(backend, true);
  // fal's voices belong to its models and are not listable; an empty one is
  // the model's own default there, not a failure.
  const voice = form.voice || backend.defaultVoice || ids[0] || "";
  if (!voice && backend.provider !== "fal") {
    return Response.json({
      ok: false,
      endpoint,
      voices: 0,
      error: "This server did not list any voices. Type a default voice it knows, then test again.",
    });
  }
  try {
    const audio = await synthesizeSpeech(PREVIEW_LINE, voice, 1, backend);
    return Response.json({
      ok: true,
      endpoint,
      model: backend.model,
      voice,
      voices: listed ? ids.length : 0,
      audio: `data:audio/mpeg;base64,${audio.toString("base64")}`,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      endpoint,
      model: backend.model,
      voice,
      voices: listed ? ids.length : 0,
      error: describeSpeechFailure(error, backend),
    });
  }
}
