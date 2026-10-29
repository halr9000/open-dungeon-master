import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { isErrorResponse, requirePrepAuthority } from "@/lib/campaign-api";
import { ADDON_MAP_LIMITS } from "@/lib/addons/contracts";
import { startImport } from "@/lib/addons/run-importer";
import { startMapGeneration } from "@/lib/addons/run-map";
import { addonSupport } from "@/lib/addons/support";
import { taskView } from "@/lib/addons/tasks";
import { uploadFor } from "@/lib/addons/uploads";
import { MAP_THEMES } from "@/lib/battlemap/generate";
import { campaignCreationRefusal, canCreateCampaigns } from "@/lib/shared-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/addons/tasks: start an addon run, answered at once with the
// task; GET /api/addons/tasks/<id> follows it.
//
//   { kind: "workshop-import", addonId, importerId, uploadId, options }
//     reads a finished upload into a workshop bundle. Whoever may create a
//     workshop may run one; the bundle becomes a workshop only when they
//     press Import on the preview (/api/workshops/import { addonTask }).
//   { kind: "map", campaignId, addonId, generatorId, request, options }
//     builds a map into that campaign's or workshop's library. Prep
//     authority, as the library's own routes ask.

const importSchema = z.object({
  kind: z.literal("workshop-import"),
  addonId: z.string().min(1).max(60),
  importerId: z.string().min(1).max(40),
  uploadId: z.string().min(1).max(60),
  options: z.record(z.string(), z.unknown()).default({}),
});

const mapSchema = z.object({
  kind: z.literal("map"),
  campaignId: z.string().min(1).max(80),
  addonId: z.string().min(1).max(60),
  generatorId: z.string().min(1).max(40),
  request: z.object({
    name: z.string().trim().min(1).max(80),
    width: z.number().int().min(ADDON_MAP_LIMITS.minSide).max(ADDON_MAP_LIMITS.maxSide),
    height: z.number().int().min(ADDON_MAP_LIMITS.minSide).max(ADDON_MAP_LIMITS.maxSide),
    theme: z.enum(MAP_THEMES as [string, ...string[]]),
    ambient: z.enum(["bright", "dim", "dark"]),
    summary: z.string().trim().max(600).default(""),
    seed: z.number().int().min(0).max(0xffffffff).optional(),
  }),
  options: z.record(z.string(), z.unknown()).default({}),
});

const bodySchema = z.discriminatedUnion("kind", [importSchema, mapSchema]);

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const support = addonSupport();
  if (!support.supported) return Response.json({ error: support.reason }, { status: 400 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "That is not a run this server knows how to start." }, { status: 400 });
  const body = parsed.data;

  if (body.kind === "workshop-import") {
    if (!canCreateCampaigns(user)) return campaignCreationRefusal();
    const upload = uploadFor(body.uploadId, user.id);
    if (!upload) return Response.json({ error: "That upload is not open. Send the file again." }, { status: 404 });
    const started = await startImport({ user, addonId: body.addonId, importerId: body.importerId, upload, options: body.options });
    if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
    return Response.json({ task: taskView(started.task) });
  }

  const context = await requirePrepAuthority(body.campaignId);
  if (isErrorResponse(context)) return context;
  const started = await startMapGeneration({
    user,
    campaign: context.campaign,
    addonId: body.addonId,
    generatorId: body.generatorId,
    request: {
      ...body.request,
      theme: body.request.theme as (typeof MAP_THEMES)[number],
      seed: body.request.seed ?? Math.floor(Math.random() * 0xffffffff),
    },
    options: body.options,
  });
  if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
  return Response.json({ task: taskView(started.task) });
}
