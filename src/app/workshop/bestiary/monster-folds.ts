import type { MonsterDraft } from "@/lib/bestiary/monster-draft";

// The monster editor's folded groups (MonsterEditor.tsx): the block's core
// numbers and attacks lead, and the specialist parts sit closed beneath a
// line that says what each holds, so nothing set is hidden unseen. Pure,
// for scripts/test-monster-folds.mjs.

export type MonsterFold = "actions" | "spellcasting" | "regeneration" | "senses";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function monsterFoldSummary(fold: MonsterFold, draft: MonsterDraft): string {
  const stats = draft.stats;
  switch (fold) {
    case "actions": {
      const parts = [
        stats.routines?.length ? "a Multiattack routine" : "",
        stats.specials?.length ? plural(stats.specials.length, "special", "specials") : "",
        stats.traits?.length ? plural(stats.traits.length, "trait line", "trait lines") : "",
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : "None yet: Multiattack, a breath weapon and other specials go here";
    }
    case "spellcasting": {
      const casting = stats.spellcasting;
      const spells = casting?.spells.length ?? stats.spells?.length ?? 0;
      if (!casting && !spells) return "None: this creature casts no spells";
      return [spells ? plural(spells, "spell", "spells") : "", casting?.dc ? `save DC ${casting.dc}` : "", casting?.attack !== undefined ? `+${casting.attack} to hit` : ""]
        .filter(Boolean)
        .join(" · ");
    }
    case "regeneration": {
      const regen = stats.regeneration;
      if (!regen) return "None";
      return `Regains ${regen.amount} hit points a turn${regen.stoppedBy.length ? `, stopped by ${regen.stoppedBy.join(" or ")}` : ""}`;
    }
    case "senses": {
      const senses = stats.senses ?? {};
      const sight = (["darkvision", "blindsight", "tremorsense", "truesight"] as const)
        .filter((sense) => senses[sense])
        .map((sense) => `${sense} ${senses[sense]} ft`);
      const skills = Object.keys(stats.skills ?? {}).length;
      const parts = [skills ? plural(skills, "skill", "skills") : "", ...sight, stats.languages ? stats.languages : ""].filter(Boolean);
      return parts.length ? parts.join(" · ") : "None set";
    }
  }
}
