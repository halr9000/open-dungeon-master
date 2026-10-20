import { isErrorResponse, requireStoryAuthority } from "@/lib/campaign-api";
import { applyPlayLink } from "@/lib/db/world-forge";
import { publishEphemeral } from "@/lib/events";
import { recordsChanged } from "@/lib/workshop/record-events";
import { PLAY_FIELDS, type PlayField } from "@/lib/worldforge/play-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One of a Cast member's World links, set into play (audit finding WF-12):
// their faction from a "member of" link, their home from a "lives in" or
// "located in" link. { field: "faction" | "home", link: <link id>,
// truth?: true to apply a hidden truth }. A false belief is refused.
export async function POST(request: Request, { params }: { params: Promise<{ campaignId: string; ref: string }> }) {
  const { campaignId, ref } = await params;
  const context = await requireStoryAuthority(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  const raw = (await request.json().catch(() => ({}))) as { field?: unknown; link?: unknown; truth?: unknown };
  const field = raw.field as PlayField;
  const link = typeof raw.link === "string" ? raw.link.slice(0, 80) : "";
  if (!PLAY_FIELDS.includes(field) || !link) {
    return Response.json({ error: "Name a faction or a home, and the link to use." }, { status: 400 });
  }
  const result = applyPlayLink(campaignId, ref.includes("%") ? decodeURIComponent(ref) : ref, field, link, raw.truth === true);
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status ?? 400 });
  }
  publishEphemeral(campaignId, "world_updated", { at: Date.now() });
  recordsChanged(campaignId, "npc", "world");
  return Response.json(result);
}
