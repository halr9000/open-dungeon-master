import { getGlobalConfig } from "@/lib/db/app-settings";
import { getDatabase, nowIso, parseJson } from "@/lib/db/core";
import { defaultRng } from "@/lib/dice";
import { startingWealthDice, wealthFromFaces } from "@/lib/srd/starting-wealth";
import { tableRerollBelow } from "@/lib/srd/ability-rerolls";

// Dice a player is owed while building a character, thrown and kept by the
// server: the six ability totals of the 4d6 method, and the starting wealth
// of a table that rolls it. The builder used to throw the ability dice in
// the browser, so the server could not tell a rolled hero from a typed one;
// now a rolled score is one the server has on record.
//
// One open roll of each kind per player (and, for wealth, per table and
// class). A roll is spent when a character is made with it.
//
// The table is created with the rest of the schema (src/lib/db/core.ts), so
// deleting a campaign or an account can clear its rows without first asking
// whether anyone ever rolled.

const POOL_SIZE = 6;

// The house rule, an admin setting (Admin > Server): a fresh six only while
// the kept six add up to less than this; 0 allows no reroll (issue #128).
export function abilityRerollBelow(): number {
  return getGlobalConfig().abilityRerollBelow;
}

// Where an ability roll is kept and the rule it is thrown under. The
// library's roll is the player's own, under the server's rule, as it always
// was. A table that sets no rule of its own follows the server's, pool and
// all: it hands back the same six as the library, so joining or opening
// another table is not a fresh throw. A table that set its own rule
// (src/lib/srd/ability-rerolls.ts) keeps a six of its own for each player,
// thrown under that rule, and only a character made at that table can spend
// it; its six never reach a stricter table's builder or the library's.
//
// What that does not bound is the character made with them: it joins the
// player's library like any other, and a library character or a file
// entering play is checked against what dice could give, not against where
// they were thrown (src/lib/srd/sheet-legality.ts policyFor).
//
// A lead who switches a table between the server's rule and its own while a
// player is building moves that player's dice to the other pool, so they
// throw again there.
export type AbilityRollPlace = { scope: string; rerollBelow: number };

export function abilityRollPlace(
  campaign?: { id: string; gameSettings: { abilityRerollBelow?: number | null } } | null,
): AbilityRollPlace {
  const own = campaign?.gameSettings.abilityRerollBelow;
  return {
    scope: campaign && typeof own === "number" ? campaign.id : "",
    rerollBelow: tableRerollBelow(own, abilityRerollBelow()),
  };
}

export type AbilityPoolRoll = {
  // The four faces of each throw and the total with the lowest set aside.
  throws: Array<{ dice: number[]; dropIndex: number; total: number }>;
  totals: number[];
  // Whether a fresh six may be asked for: only while the pool adds up to
  // less than the threshold where it was thrown (abilityRollPlace).
  canReroll: boolean;
  rerollBelow: number;
  // True when these six were already on record and are handed back again
  // rather than thrown now, with when they were thrown; the builder shows a
  // kept roll as kept, not as dice in the air (issue #128).
  kept: boolean;
  createdAt: string | null;
};

function read<T>(userId: string, kind: string, scope: string): { payload: T; createdAt: string } | null {
  const row = getDatabase()
    .prepare(`SELECT payload_json, created_at FROM creation_rolls WHERE user_id = ? AND kind = ? AND scope = ?`)
    .get(userId, kind, scope) as { payload_json: string; created_at: string } | undefined;
  if (!row) {
    return null;
  }
  const payload = parseJson<T | null>(row.payload_json, null);
  return payload === null ? null : { payload, createdAt: row.created_at };
}

function write(userId: string, kind: string, scope: string, payload: unknown) {
  getDatabase()
    .prepare(
      `INSERT INTO creation_rolls (user_id, kind, scope, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, kind, scope)
       DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
    )
    .run(userId, kind, scope, JSON.stringify(payload), nowIso());
}

function clear(userId: string, kind: string, scope: string) {
  getDatabase()
    .prepare(`DELETE FROM creation_rolls WHERE user_id = ? AND kind = ? AND scope = ?`)
    .run(userId, kind, scope);
}

function throwFour(): AbilityPoolRoll["throws"][number] {
  const dice = [defaultRng(6), defaultRng(6), defaultRng(6), defaultRng(6)];
  let dropIndex = 0;
  for (let index = 1; index < 4; index += 1) {
    if (dice[index] < dice[dropIndex]) {
      dropIndex = index;
    }
  }
  const total = dice.reduce((sum, face, index) => (index === dropIndex ? sum : sum + face), 0);
  return { dice, dropIndex, total };
}

const shaped = (
  throws: AbilityPoolRoll["throws"],
  kept: boolean,
  createdAt: string | null,
  rerollBelow: number,
): AbilityPoolRoll => {
  const totals = throws.map((entry) => entry.total);
  return {
    throws,
    totals,
    canReroll: totals.reduce((sum, total) => sum + total, 0) < rerollBelow,
    rerollBelow,
    kept,
    createdAt,
  };
};

// The player's open pool at this place (the library unless a table is
// given), or null when none was rolled there.
export function openAbilityPool(userId: string, place: AbilityRollPlace = abilityRollPlace()): AbilityPoolRoll | null {
  const open = read<AbilityPoolRoll["throws"]>(userId, "abilities", place.scope);
  return open?.payload.length === POOL_SIZE ? shaped(open.payload, true, open.createdAt, place.rerollBelow) : null;
}

// Six throws of 4d6, the lowest die of each set aside. A pool at or over
// the place's threshold stands: asking again returns the same six, marked
// as kept.
export function rollAbilityPool(userId: string, place: AbilityRollPlace = abilityRollPlace()): AbilityPoolRoll {
  const open = openAbilityPool(userId, place);
  if (open && !open.canReroll) {
    return open;
  }
  const throws = Array.from({ length: POOL_SIZE }, throwFour);
  write(userId, "abilities", place.scope, throws);
  return shaped(throws, false, nowIso(), place.rerollBelow);
}

export function spendAbilityPool(userId: string, place: AbilityRollPlace = abilityRollPlace()) {
  clear(userId, "abilities", place.scope);
}

export type WealthRoll = { classId: string; faces: number[]; gold: number };

const wealthScope = (campaignId: string, classId: string) =>
  `${campaignId}:${classId.trim().toLowerCase()}`;

export function openWealthRoll(userId: string, campaignId: string, classId: string): WealthRoll | null {
  return read<WealthRoll>(userId, "wealth", wealthScope(campaignId, classId))?.payload ?? null;
}

// The class's starting wealth, rolled once: asking again returns the same
// coin, so a poor roll cannot be thrown back.
export function rollStartingWealth(userId: string, campaignId: string, classId: string): WealthRoll {
  const open = openWealthRoll(userId, campaignId, classId);
  if (open) {
    return open;
  }
  const dice = startingWealthDice(classId);
  const faces = Array.from({ length: dice.count }, () => defaultRng(dice.sides));
  const roll = { classId, faces, gold: wealthFromFaces(classId, faces) };
  write(userId, "wealth", wealthScope(campaignId, classId), roll);
  return roll;
}

export function spendWealthRolls(userId: string, campaignId: string) {
  getDatabase()
    .prepare(`DELETE FROM creation_rolls WHERE user_id = ? AND kind = 'wealth' AND scope LIKE ?`)
    .run(userId, `${campaignId}:%`);
}
