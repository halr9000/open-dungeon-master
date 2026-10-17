// The content pack's skill set, as the derivation sees it.
//
// Replacement semantics, the standing design rule for setting packs: when a
// mounted pack declares a `skills` table, that table IS the active skill set
// — the bundled SRD 18 are never shown beside it. The rows are registered
// data (src/lib/content/db.ts loads them server-side), so the derivation
// consults it without touching a database, the way class-progression.ts and
// option-grants.ts work. A pack without the table registers nothing and the
// bundled list answers as it always has.
//
// The pack's ids are its own. The SW5e pack writes the Foundry short codes
// (acr, lor, pil, tec, ...); fifteen of its skills name the same skills as
// the bundled SRD's, so code that holds a bundled id should resolve it
// through activeSkillMatching, which matches the active row sharing the
// bundled skill's name.

import skillsJson from "@/lib/srd/skills.json";
import type { SrdSkill } from "@/lib/srd/srd-types";

export type PackSkill = { id: string; name: string; ability: string };

const SRD_SKILL_LIST = skillsJson.skills as SrdSkill[];

let packSkillRows: PackSkill[] = [];

export function registerPackSkills(rows: PackSkill[]): void {
  packSkillRows = rows.map((row) => ({
    id: row.id.trim(),
    name: row.name.trim(),
    ability: row.ability.trim().toLowerCase(),
  }));
}

export function packSkills(): PackSkill[] {
  return packSkillRows;
}

export function packSkillsMounted(): boolean {
  return packSkillRows.length > 0;
}

// The active skill set: the pack's rows when the pack declares them, the
// bundled SRD list otherwise. Replacement, not union.
export function activeSkills(): SrdSkill[] {
  return packSkillRows.length ? (packSkillRows as SrdSkill[]) : SRD_SKILL_LIST;
}

// A skill from the active set BY ID. Strict: a bundled id that the pack
// replaced ("acrobatics") resolves to null — replacement, never a merge;
// bridging a bundled id to the pack's row is activeSkillMatching's job.
export function findActiveSkill(id: string): SrdSkill | null {
  const wanted = id.trim();
  return activeSkills().find((skill) => skill.id === wanted) ?? null;
}

// A skill from the active set by id OR name — for entries a SHEET stores:
// players and older sheets spell skills ("Lore", "Persuasion"), the pack's
// rows carry Foundry short-codes (`lor`, `prc`). Case-insensitive, since
// legality lowercases everything it judges. (Not findActiveSkill: that one
// must stay id-strict so a replaced bundled id stays null.)
export function resolveSkillEntry(entry: string): SrdSkill | null {
  const wanted = entry.trim();
  const active = activeSkills();
  return (
    active.find((skill) => skill.id === wanted) ??
    active.find((skill) => skill.name.toLowerCase() === wanted.toLowerCase()) ??
    null
  );
}

// The active set's equivalent of a bundled skill id: the same id when the
// active set carries it, otherwise the active row sharing the bundled
// skill's name (the SW5e pack writes Perception as `prc`). Null when the
// active set has no such skill (arcana under the SW5e pack).
export function activeSkillMatching(bundledId: string): SrdSkill | null {
  const wanted = bundledId.trim();
  const direct = activeSkills().find((skill) => skill.id === wanted);
  if (direct) {
    return direct;
  }
  if (!packSkillsMounted()) {
    return null;
  }
  const bundled = SRD_SKILL_LIST.find((skill) => skill.id === wanted);
  if (!bundled) {
    return null;
  }
  const wantedName = bundled.name.toLowerCase();
  return activeSkills().find((skill) => skill.name.toLowerCase() === wantedName) ?? null;
}
