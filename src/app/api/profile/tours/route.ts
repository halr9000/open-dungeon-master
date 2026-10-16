import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { nowIso } from "@/lib/db/core";
import { finishedTours, recordFinishedTours } from "@/lib/db/users";
import type { TourLedger } from "@/lib/tours/account-logic";
import { isTourId } from "@/lib/tours/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The walkthroughs this account has finished (issue #306), so a tour closed
// in one browser or app stays closed in every other. The answer names the
// account too: a device keeps its copy per account (src/lib/tours/tour-store.ts),
// and the app's screens can change server, and so account, without a reload.

const finishSchema = z.object({
  finished: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        version: z.number().int().min(1).max(1_000),
        how: z.enum(["done", "ended"]),
      }),
    )
    .min(1)
    .max(64),
});

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  return Response.json({ userId: user.id, tours: finishedTours(user.id) });
}

// Records finishes; the time is the server's. An id this server has no tour
// for (a page newer than the server) is named back as ignored, so the device
// stops sending it.
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  const parsed = finishSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const at = nowIso();
  const finishedNow: TourLedger = {};
  const ignored: string[] = [];
  for (const entry of parsed.data.finished) {
    if (!isTourId(entry.id)) {
      ignored.push(entry.id);
      continue;
    }
    if ((finishedNow[entry.id]?.version ?? 0) < entry.version) {
      finishedNow[entry.id] = { version: entry.version, how: entry.how, at };
    }
  }
  const tours = Object.keys(finishedNow).length ? recordFinishedTours(user.id, finishedNow) : finishedTours(user.id);
  return Response.json({ userId: user.id, tours, ignored });
}
