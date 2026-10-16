import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { getCampaignById, isCampaignMember } from "@/lib/db/campaigns";
import {
  abilityRollPlace,
  openAbilityPool,
  openWealthRoll,
  rollAbilityPool,
  rollStartingWealth,
  type AbilityRollPlace,
} from "@/lib/db/creation-rolls";
import { describeWealthDice, startingWealthDice } from "@/lib/srd/starting-wealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The dice a character is built with are thrown here, by the server, and
// kept (src/lib/db/creation-rolls.ts): the six ability totals of the 4d6
// method, and the starting wealth of a table that rolls it. The builder asks
// for a roll and shows what came back; a sheet that claims rolled scores or
// rolled coin is held to what is on record here when it is saved.

const rollSchema = z.discriminatedUnion("kind", [
  // A table's id when the character is being made at it (its reroll rule,
  // and its own kept six when it set a rule of its own); none in the
  // library.
  z.object({ kind: z.literal("abilities"), campaignId: z.string().trim().max(80).optional() }),
  z.object({
    kind: z.literal("wealth"),
    campaignId: z.string().trim().min(1),
    classId: z.string().trim().min(1).max(60),
  }),
]);

// Whether this table rolls starting wealth for this player, or why not.
function wealthRefusal(userId: string, campaignId: string): Response | null {
  const campaign = getCampaignById(campaignId);
  if (!campaign || !isCampaignMember(campaignId, userId)) {
    return Response.json({ error: "That campaign is not one of yours." }, { status: 404 });
  }
  if ((campaign.gameSettings.startingWealth ?? "equipment") !== "rolled") {
    return Response.json(
      {
        error:
          "This table starts characters with their class's equipment and their background's coin; starting wealth is not rolled here.",
      },
      { status: 409 },
    );
  }
  return null;
}

const wealthAnswer = (classId: string, roll: { faces: number[]; gold: number }) => ({
  classId,
  faces: roll.faces,
  gold: roll.gold,
  dice: describeWealthDice(startingWealthDice(classId)),
});

// The rolls still open for this player: what a builder opened again shows
// instead of asking for new dice.
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  const params = new URL(request.url).searchParams;
  const campaignId = (params.get("campaignId") ?? "").trim();
  const classId = (params.get("classId") ?? "").trim();
  let wealth = null;
  if (campaignId && classId && !wealthRefusal(user.id, campaignId)) {
    const open = openWealthRoll(user.id, campaignId, classId);
    wealth = open ? wealthAnswer(classId, open) : null;
  }
  const place = abilityPlace(user.id, campaignId);
  if ("error" in place) {
    return place.error;
  }
  // The reroll rule where the character is being made rides along even with
  // no pool open, so the builder's words match it before the first throw.
  return Response.json({ abilities: openAbilityPool(user.id, place), wealth, rerollBelow: place.rerollBelow });
}

// The library, or a table the player belongs to: where their ability roll is
// kept and the reroll rule it answers to (abilityRollPlace). A table that
// follows the server answers with the library's six, but only to a member.
function abilityPlace(userId: string, campaignId: string): AbilityRollPlace | { error: Response } {
  if (!campaignId) {
    return abilityRollPlace();
  }
  const campaign = getCampaignById(campaignId);
  if (!campaign || !isCampaignMember(campaignId, userId)) {
    return { error: Response.json({ error: "That campaign is not one of yours." }, { status: 404 }) };
  }
  return abilityRollPlace(campaign);
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  const parsed = rollSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json(
      { error: "Say which dice to roll: the ability scores, or a class's starting wealth at a table." },
      { status: 400 },
    );
  }
  if (parsed.data.kind === "abilities") {
    // Six at or over the place's threshold stand: asking again answers with
    // the same six, marked kept.
    const place = abilityPlace(user.id, parsed.data.campaignId ?? "");
    if ("error" in place) {
      return place.error;
    }
    return Response.json({ abilities: rollAbilityPool(user.id, place) });
  }
  const refused = wealthRefusal(user.id, parsed.data.campaignId);
  if (refused) {
    return refused;
  }
  // Rolled once for a class at a table: asking again answers with the same
  // coin.
  const roll = rollStartingWealth(user.id, parsed.data.campaignId, parsed.data.classId);
  return Response.json({ wealth: wealthAnswer(parsed.data.classId, roll) });
}
