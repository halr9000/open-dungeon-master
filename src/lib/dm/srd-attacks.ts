// The Hunter's Multiattack picks (SRD 5.1, ranger Hunter 11):
//
//   - Whirlwind Attack: the action makes one melee weapon attack against each
//     creature within 5 feet of the ranger, a separate roll for each.
//   - Volley: the action makes one ranged weapon attack against each creature
//     within 10 feet of a point the ranger can see in range; the first target
//     marks the point.
//
// pc_attack `whirlwind` / `volley`: the first attack spends the whole action
// (Extra Attack's swings go with it) and opens the volley in the turn
// budget's once-per-turn list; each later one strikes a creature not struck
// yet by it. Pure over the budget: pc-attack-plan.ts stores what this returns.

import { spendAction, type TurnBudget } from "@/lib/dm/action-budget";
import type { AttackProfile } from "@/lib/dm/attack-logic";
import { tilesBetween } from "@/lib/dm/attack-spatial";
import { holdsFeature } from "@/lib/srd/trait-rules";
import type { CharacterSheet } from "@/lib/schemas/sheet";
import { toolError, type ToolError } from "@/lib/dm/tool-errors";

const OPEN = "hunter-multiattack:";
const STRUCK = "hunter-multiattack-target:";

export type MultiattackKind = "whirlwind" | "volley";

export function hunterMultiattack(input: {
  sheet: CharacterSheet;
  kind: MultiattackKind;
  budget: TurnBudget | null;
  profile: AttackProfile;
  weaponAttack: boolean;
  atRange: boolean;
  encounterId: string;
  enemyId: string;
}): { refused: ToolError } | { budget: TurnBudget; note: string } {
  const { sheet, kind, budget } = input;
  const label = kind === "whirlwind" ? "Whirlwind Attack" : "Volley";
  if (!holdsFeature(sheet, `multiattack: ${label.toLowerCase()}`, label.toLowerCase())) {
    return { refused: { error: `${sheet.name} does not have ${label} (a Hunter ranger's Multiattack pick). They attack with the Attack action instead.`, refused: "rules" } };
  }
  if (!budget) {
    return { refused: { error: `${label} is the Attack action on ${sheet.name}'s own turn; it is not their turn. What they declared waits for their turn.`, refused: "rules" } };
  }
  if (!input.weaponAttack) {
    return { refused: { error: `${label} is made with a weapon, not a spell. They cast the spell on its own, or attack with a weapon.`, refused: "rules" } };
  }
  if (kind === "whirlwind") {
    const apart = tilesBetween(input.encounterId, sheet.id, input.enemyId);
    if (input.profile.ranged || input.atRange || (apart !== null && apart > 1)) {
      return { refused: { error: "Whirlwind Attack makes melee weapon attacks against creatures within 5 feet of the ranger. They can make it without this creature.", retry: true } };
    }
  } else if (!input.profile.ranged && !input.atRange) {
    return { refused: { error: "Volley makes ranged weapon attacks; send the bow or crossbow as the weapon.", retry: true } };
  }
  const open = budget.oncePerTurn.find((key) => key.startsWith(`${OPEN}${kind}:`));
  if (!open) {
    if (budget.attacksMade > 0 || budget.actionUsed) {
      return { refused: { error: `${label} takes the whole Attack action, and ${sheet.name} has already attacked or used their action this turn. It waits for their next turn.`, refused: "rules" } };
    }
    const spent = spendAction(budget, "action", label, sheet.name);
    if (!spent.ok) {
      return { refused: toolError(spent) };
    }
    return {
      budget: {
        ...spent.budget,
        attacksMade: spent.budget.attacksAllowed,
        oncePerTurn: [...spent.budget.oncePerTurn, `${OPEN}${kind}:${input.enemyId}`, `${STRUCK}${input.enemyId}`],
      },
      note: `${label}: the action; one attack against each creature ${kind === "whirlwind" ? "within 5 feet" : "within 10 feet of this one"}, this one first`,
    };
  }
  if (budget.oncePerTurn.includes(`${STRUCK}${input.enemyId}`)) {
    return { refused: { error: `${label} makes one attack against each creature, and ${sheet.name} has already attacked this one with it. They can make it without this creature.`, retry: true } };
  }
  if (kind === "volley") {
    const first = open.slice(`${OPEN}volley:`.length);
    const apart = tilesBetween(input.encounterId, first, input.enemyId);
    if (apart !== null && apart > 2) {
      return { refused: { error: "Volley's targets stand within 10 feet of the point the first one marked; this creature is farther. They can make it without this creature.", retry: true } };
    }
  }
  return {
    budget: { ...budget, oncePerTurn: [...budget.oncePerTurn, `${STRUCK}${input.enemyId}`] },
    note: `${label}: another creature, no attack of the action spent`,
  };
}
