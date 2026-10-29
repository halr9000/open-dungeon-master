import { z } from "zod";
import { isErrorResponse, requireAdmin } from "@/lib/admin-api";
import {
  MAX_RECEIVER_ORIGINS,
  adminReceiverOrigins,
  envReceiverOrigins,
  pollLinksAllowed,
  setAdminReceiverOrigins,
  setPollLinksAllowed,
  startPlayerWebhookRunner,
} from "@/lib/agents/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The receiver addresses an admin allows player agents' webhooks to reach
// (docs/player-webhooks.md). Live on save, no restart. The environment's
// list is shown beside it, read-only: it can only change where it was set.
// Poll links, for agents nothing can send requests to, are a switch of their
// own here, off by default.
export async function GET() {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  return Response.json({ origins: adminReceiverOrigins(), envOrigins: envReceiverOrigins(), pollLinks: pollLinksAllowed() });
}

const putSchema = z
  .object({
    origins: z.array(z.string().max(2048)).max(MAX_RECEIVER_ORIGINS).optional(),
    pollLinks: z.boolean().optional(),
  })
  .refine((body) => body.origins !== undefined || body.pollLinks !== undefined, "Send origins or pollLinks.");

export async function PUT(request: Request) {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  const parsed = putSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message || "Invalid input." }, { status: 400 });
  }
  try {
    if (parsed.data.origins !== undefined) {
      setAdminReceiverOrigins(parsed.data.origins);
      // The first approved address turns delivery on without a restart.
      startPlayerWebhookRunner();
    }
    if (parsed.data.pollLinks !== undefined) setPollLinksAllowed(parsed.data.pollLinks);
    return Response.json({ origins: adminReceiverOrigins(), envOrigins: envReceiverOrigins(), pollLinks: pollLinksAllowed() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid input." }, { status: 400 });
  }
}
