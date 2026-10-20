import { currentUser, unauthorized } from "@/lib/auth";
import { offeredContributions } from "@/lib/addons/offered";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/addons
//
// What the switched-on addons add to the app, for any signed-in page that
// offers them: the workshop's "Import with an addon", the map library's
// generators, the board's view switch. Only addons that are ready to run
// are listed, and only what a page needs to draw its controls; settings,
// paths and logs stay on the admin's side (/api/admin/addons).
export async function GET() {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  return Response.json(offeredContributions());
}
