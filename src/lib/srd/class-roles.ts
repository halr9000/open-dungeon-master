// A class's job in a fight, in the words a gamer already knows (Tank, DPS,
// Healer, Support, Control, Utility: 4th edition's defender, striker, leader
// and controller, plus the skill-and-scouting job none of those named), and
// which of the core four it plays like. The bundled classes carry both in
// their data files (src/lib/srd/classes.json, src/lib/classes/*.json), set by
// hand and corrected there. Any other class (a workshop's, a content pack's)
// gets a reading of its numbers, marked as suggested.
import { CUSTOM_CLASSES } from "@/lib/classes";
import { SRD_CLASSES } from "@/lib/srd";

export const CLASS_ROLES = ["Tank", "DPS", "Healer", "Support", "Control", "Utility"] as const;
export type ClassRole = (typeof CLASS_ROLES)[number];

export type ClassRoleReading = { roles: ClassRole[]; playsLike: string; suggested: boolean };

type ClassLike = {
  id: string;
  hitDie?: number;
  armor?: string[];
  casterType?: string;
  spellAbility?: string | null;
  spellListFrom?: string | null;
  roles?: string[];
  playsLike?: string;
};

const isRole = (value: string): value is ClassRole => (CLASS_ROLES as readonly string[]).includes(value);

// What a borrowed spell list says about a class: a cleric's list heals, a
// wizard's controls, a sorcerer's or warlock's hits.
const BY_SPELL_LIST: Record<string, { roles: ClassRole[]; playsLike: string }> = {
  cleric: { roles: ["Healer", "Support"], playsLike: "Cleric" },
  druid: { roles: ["Healer", "Control"], playsLike: "Cleric" },
  bard: { roles: ["Support", "Control"], playsLike: "Rogue + Wizard" },
  wizard: { roles: ["Control"], playsLike: "Wizard" },
  sorcerer: { roles: ["DPS"], playsLike: "Wizard" },
  warlock: { roles: ["DPS"], playsLike: "Wizard" },
  paladin: { roles: ["Tank", "DPS"], playsLike: "Fighter + Cleric" },
  ranger: { roles: ["DPS", "Utility"], playsLike: "Fighter + Rogue" },
};
// The same reading by casting ability, for a class that names no list.
const BY_ABILITY: Record<string, { roles: ClassRole[]; playsLike: string }> = {
  int: BY_SPELL_LIST.wizard,
  wis: BY_SPELL_LIST.cleric,
  cha: BY_SPELL_LIST.sorcerer,
};

function readNumbers(klass: ClassLike): { roles: ClassRole[]; playsLike: string } {
  const listed = klass.spellListFrom ? BY_SPELL_LIST[klass.spellListFrom] : undefined;
  if (listed) {
    return listed;
  }
  if (klass.casterType && klass.casterType !== "none" && klass.spellAbility && BY_ABILITY[klass.spellAbility]) {
    return BY_ABILITY[klass.spellAbility];
  }
  const armor = (klass.armor ?? []).join(" ").toLowerCase();
  const sturdy = (klass.hitDie ?? 8) >= 10 && /medium|heavy/.test(armor);
  return sturdy ? { roles: ["Tank", "DPS"], playsLike: "Fighter" } : { roles: ["DPS", "Utility"], playsLike: "Rogue" };
}

export function classRoles(klass: ClassLike): ClassRoleReading {
  const own = (klass.roles ?? []).filter(isRole);
  if (own.length && klass.playsLike) {
    return { roles: own, playsLike: klass.playsLike, suggested: false };
  }
  // A content pack's row for a bundled class (its id is the slug) reads the
  // bundled entry's.
  const bundled = [...SRD_CLASSES, ...CUSTOM_CLASSES].find((entry) => entry.id === klass.id);
  const bundledRoles = (bundled?.roles ?? []).filter(isRole);
  if (bundled && bundledRoles.length && bundled.playsLike) {
    return { roles: bundledRoles, playsLike: bundled.playsLike, suggested: false };
  }
  return { ...readNumbers(klass), suggested: true };
}
