// The builder's hit points: the one number the explainer, the preview and
// the save all show, worked out as the server will work it out
// (src/lib/srd/sheet-legality.ts, "hit dice and hit points"). Lineage,
// Tough, Draconic Resilience, Constitution, level and the table's method all
// count, and a stored character keeps its hit points only where the server
// would keep them.
import { derivedMaxHp, hpBonusPerLevelFor, hpRange, type HpMethod } from "@/lib/srd/hit-points";
import { hpBonusPerLevel } from "@/lib/srd/race-id";
import { featureHitPoints } from "@/lib/srd/trait-rules";
import { hpBreakdown, type HpBreakdown } from "./abilityDice";

export type BuilderHpInput = {
  hitDie: number;
  classId: string;
  subclass: string;
  level: number;
  // The Constitution the sheet will hold, half-feat and Primal Champion in.
  con: number;
  raceId: string | null;
  // Every feat the sheet will hold: the race's and those taken with
  // Ability Score Improvements.
  feats: string[];
  // The table's method; null in the library, where no table has chosen one.
  method: HpMethod | null;
  // What a stored character came home with, or null for a new one.
  stored: { maxHp: number; level: number; con: number } | null;
};

export type BuilderHp = {
  maxHp: number;
  range: { min: number; max: number };
  // The method the figure follows. A table that rolls shows the fixed value
  // here and `range` for what the dice may give.
  method: HpMethod;
  // The stored character's own hit points stand.
  kept: boolean;
  parts: HpBreakdown;
};

export function builderHitPoints(input: BuilderHpInput): BuilderHp {
  const hpInput = {
    classes: [{ die: input.hitDie, level: input.level }],
    con: input.con,
    perLevelBonus: hpBonusPerLevelFor(input.raceId ? hpBonusPerLevel(input.raceId) > 0 : false, input.feats),
    extraHp: featureHitPoints({ class: input.classId, subclass: input.subclass, level: input.level }),
  };
  const range = hpRange(hpInput);
  const method = input.method ?? "average";
  const shown = method === "max" ? "max" : "average";
  const parts = hpBreakdown({
    hitDie: input.hitDie,
    con: input.con,
    level: input.level,
    bonusPerLevel: hpInput.perLevelBonus,
    method: shown,
    featureHp: hpInput.extraHp,
  });
  // The server keeps a stored character's hit points only in the library
  // (no table method), while they sit in range and the level and the
  // Constitution behind them stand. A table derives them, or rolls them.
  const stored = input.stored;
  const kept =
    input.method === null &&
    stored !== null &&
    stored.maxHp >= range.min &&
    stored.maxHp <= range.max &&
    stored.level === input.level &&
    stored.con === input.con;
  return {
    maxHp: kept && stored ? stored.maxHp : derivedMaxHp(shown, hpInput),
    range,
    method,
    kept,
    parts,
  };
}
