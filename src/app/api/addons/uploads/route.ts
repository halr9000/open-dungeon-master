import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { addonSupport } from "@/lib/addons/support";
import { beginUpload, MAX_ADDON_INPUT_BYTES, UPLOAD_CHUNK_BYTES } from "@/lib/addons/uploads";
import { campaignCreationRefusal, canCreateCampaigns } from "@/lib/shared-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/addons/uploads { name, mime, size }: opens an upload for a file
// an addon will read (a rulebook PDF for a workshop importer). The bytes
// follow in pieces to /api/addons/uploads/<id> (src/lib/addons/uploads.ts
// says why). Importing creates a workshop, so the same rule decides who may.

const bodySchema = z.object({
  name: z.string().trim().min(1).max(260),
  mime: z.string().trim().max(120).default(""),
  size: z.number().int().min(1).max(MAX_ADDON_INPUT_BYTES),
});

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (!canCreateCampaigns(user)) return campaignCreationRefusal();
  const support = addonSupport();
  if (!support.supported) return Response.json({ error: support.reason }, { status: 400 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "Send the file's name, type and size (up to 2 GB)." }, { status: 400 });
  }
  const upload = await beginUpload({ userId: user.id, ...parsed.data });
  return Response.json({ uploadId: upload.id, chunkBytes: UPLOAD_CHUNK_BYTES });
}
