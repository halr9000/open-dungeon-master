// Whether a character may take a reaction, asked the same way by every tool
// that spends one: use_reaction (src/lib/dm/reaction-tools.ts) and a feature
// whose cost is the reaction (prepareReaction, src/lib/dm/turn-budget.ts).
//
// The dead, the dying, the incapacitated and the surprised have no reaction;
// whose turn it is does not matter to one. A reaction to the hit that dropped
// them is taken as the hit lands, so it is asked of them as they stood before
// it (the record is src/lib/dm/last-hit.ts).

import type { Encounter } from "@/lib/db/encounters";
import type { CharacterSheet } from "@/lib/schemas/sheet";
import { canAct } from "@/lib/dm/can-act";
import { freshLastHit } from "@/lib/dm/last-hit";
import { conditionBlocksReactions } from "@/lib/srd/condition-effects";

function reactingAs(campaignId: string, sheet: CharacterSheet): CharacterSheet {
  const answering = freshLastHit(campaignId, sheet.id);
  const before = answering && answering.before.currentHp > 0 && sheet.currentHp <= 0 ? answering.before : null;
  return before
    ? { ...sheet, currentHp: before.currentHp, conditions: before.conditions, deathSaves: before.deathSaves }
    : sheet;
}

// The refusal for a reaction the character cannot take, or null.
export function reactionRefusal(
  campaignId: string,
  sheet: CharacterSheet,
  encounter: Encounter | null,
  label: string,
): string | null {
  const standing = reactingAs(campaignId, sheet);
  const allowed = canAct({ sheet: standing, encounter, kind: "reaction" });
  if (!allowed.ok) {
    return allowed.error;
  }
  // Slow and its kin switch reactions off entirely.
  const blocked = conditionBlocksReactions(standing.conditions);
  return blocked ? `${sheet.name} is ${blocked} and cannot take reactions; ${label} does not happen.` : null;
}
