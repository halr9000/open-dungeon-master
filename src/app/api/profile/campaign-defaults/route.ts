import { currentUser, unauthorized } from "@/lib/auth";
import {
  CAMPAIGN_DEFAULTS_VERSION,
  readStoredDefaults,
  validateDefaultsWrite,
} from "@/lib/campaign-defaults";
import { clearCampaignDefaults, getUserSettings, setCampaignDefaults } from "@/lib/db/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed-in person's own new-campaign defaults
// (src/lib/campaign-defaults.ts). Theirs alone: every request reads and
// writes the account it is signed in as, and no admin right is involved.

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  return Response.json({ defaults: readStoredDefaults(getUserSettings(user.id).campaignDefaults) });
}

// Saving replaces the whole saved setup with the one sent: it is "these are
// my defaults now", not a merge into an older set.
export async function PUT(request: Request) {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  const raw = await request.json().catch(() => null);
  const checked = validateDefaultsWrite(raw);
  if (!checked.ok) {
    return Response.json({ error: checked.error }, { status: 400 });
  }
  const defaults = {
    version: CAMPAIGN_DEFAULTS_VERSION,
    savedAt: new Date().toISOString(),
    settings: checked.settings,
  };
  setCampaignDefaults(user.id, defaults);
  return Response.json({ defaults });
}

export async function DELETE() {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  clearCampaignDefaults(user.id);
  return Response.json({ defaults: null });
}
