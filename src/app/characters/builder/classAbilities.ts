// Which abilities a class leans on, in order, so the builder can place the
// six scores for a player who does not know yet where a fighter's 15 goes.
// The SRD classes have the order most tables would give them; any other class
// (a genre class, a content pack's) is read from its multiclass prerequisite,
// then Constitution, then its casting ability and saves.
import type { Ability } from "@/lib/schemas/sheet";
import { multiclassPrereq } from "@/lib/srd/multiclass";

const ABILITIES: Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

const ORDER: Record<string, Ability[]> = {
  barbarian: ["str", "con", "dex", "wis", "cha", "int"],
  bard: ["cha", "dex", "con", "wis", "int", "str"],
  cleric: ["wis", "con", "str", "dex", "cha", "int"],
  druid: ["wis", "con", "dex", "int", "cha", "str"],
  fighter: ["str", "con", "dex", "wis", "int", "cha"],
  monk: ["dex", "wis", "con", "str", "int", "cha"],
  paladin: ["str", "cha", "con", "wis", "dex", "int"],
  ranger: ["dex", "wis", "con", "str", "int", "cha"],
  rogue: ["dex", "con", "int", "wis", "cha", "str"],
  sorcerer: ["cha", "con", "dex", "wis", "int", "str"],
  warlock: ["cha", "con", "dex", "wis", "int", "str"],
  wizard: ["int", "con", "dex", "wis", "cha", "str"],
  artificer: ["int", "con", "dex", "wis", "str", "cha"],
};

export type ClassAbilityHints = { id: string; spellAbility?: string | null; saves?: string[] };

const isAbility = (value: unknown): value is Ability => ABILITIES.includes(value as Ability);

// All six abilities, most important first.
export function abilityPriority(klass: ClassAbilityHints): Ability[] {
  const listed = ORDER[klass.id.trim().toLowerCase()];
  if (listed) {
    return listed;
  }
  const order: Ability[] = [];
  const add = (ability: unknown) => {
    if (isAbility(ability) && !order.includes(ability)) {
      order.push(ability);
    }
  };
  for (const ability of multiclassPrereq(klass.id)?.[0] ?? []) add(ability);
  add(klass.spellAbility);
  add("con");
  for (const save of klass.saves ?? []) add(save);
  for (const ability of ["dex", "wis", "str", "int", "cha"]) add(ability);
  return order;
}

// The abilities a class needs first, as the multiclass table names them: one
// list per way to qualify ("Strength or Dexterity"; "Strength and Charisma").
export function keyAbilities(klass: ClassAbilityHints): Ability[][] {
  const prereq = multiclassPrereq(klass.id);
  if (prereq?.length) {
    return prereq;
  }
  return [[abilityPriority(klass)[0]]];
}

// The standard array laid on the abilities in the class's order: 15 on the
// first, 14 on the second, down to 8.
export function standardFor(klass: ClassAbilityHints, array: readonly number[]): Record<Ability, number> {
  const order = abilityPriority(klass);
  return Object.fromEntries(order.map((ability, index) => [ability, array[index]])) as Record<Ability, number>;
}

// A thrown pool laid the same way: the highest total on the first ability.
// Returns which pool entry each ability holds.
export function poolSlotsFor(klass: ClassAbilityHints, totals: readonly number[]): Record<Ability, number> {
  const order = abilityPriority(klass);
  const byTotal = totals.map((total, index) => ({ total, index })).sort((a, b) => b.total - a.total || a.index - b.index);
  return Object.fromEntries(order.map((ability, rank) => [ability, byTotal[rank].index])) as Record<Ability, number>;
}
