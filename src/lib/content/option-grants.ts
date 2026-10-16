// A content pack's option grants, as the sheet and the legality check see
// them.
//
// The pack's class_progression table carries kind 'option_grant' rows: a
// class feature that opens a list of options (Berserker Instincts, Choose
// Fighting Style, Lightsaber Forms), one row per option it may grant, with
// the option resolved through the pack's options table (family, action
// economy, uses). Reading them needs the content database
// (src/lib/content/db.ts), which lives server-side only; the readers here
// are registered data, so the sheet derivation and the legality check
// consult them without touching a database. A pack without the tables —
// every Open5e pack today — registers nothing, and nothing is surfaced or
// admitted on the pack's word.
//
// Slug collisions (the SW5e pack's fighter and monk against the bundled
// SRD's) are pack-wins here by policy: the bundled tables carry no option
// grants at all, so a class the pack describes grants from the pack's rows
// whichever table describes its features. The class-feature half of that
// flip belongs to the level-up work.
import type { SheetOptionGrant } from "@/lib/schemas/sheet";

export type { SheetOptionGrant };

// One option the pack's options table describes, as the engines will
// consume it. `uses` is the pack's own resource expression, formula strings
// included ("per-rest:@classes.engineer.levels"): surfaced raw until the
// resource model exists.
export type PackOption = {
  slug: string;
  name: string;
  family: string;
  prerequisite: string | null;
  actionEconomy: string | null;
  uses: string | null;
};

// One grant row: the feature that opens the list, the option it may grant,
// and the pick budget. `choices` is the per-level pick count the pack's
// data_json carries ({2: {count: 2}, 7: {count: 1}, ...}) flattened to
// level → count; a row without one picks `count` at its own level.
export type PackOptionGrant = {
  level: number;
  name: string;
  refSlug: string;
  archetype: string | null;
  count: number | null;
  choices: Record<number, number>;
  // The option's own name as the grant row carries it (the pack's
  // data_json), for a grant whose option rows have not landed in the
  // options table yet.
  optionName?: string | null;
};

const PACK_OPTIONS = new Map<string, PackOption>();
const PACK_OPTION_GRANTS = new Map<string, PackOptionGrant[]>();

export function registerPackOptions(options: PackOption[]): void {
  for (const option of options) {
    PACK_OPTIONS.set(option.slug.trim().toLowerCase(), option);
  }
}

export function packOptionBySlug(slug: string): PackOption | null {
  return PACK_OPTIONS.get(slug.trim().toLowerCase()) ?? null;
}

export function registerPackOptionGrants(classSlug: string, grants: PackOptionGrant[]): void {
  PACK_OPTION_GRANTS.set(classSlug.trim().toLowerCase(), [...grants]);
}

// A class's grant rows, base class and archetypes together. Empty for every
// class the pack does not describe.
export function packOptionGrantsFor(classSlug: string): PackOptionGrant[] {
  return PACK_OPTION_GRANTS.get(classSlug.trim().toLowerCase()) ?? [];
}

// Class slugs as the sheet names them, normalized the way the pack slugs
// are written: one lowercase alphanumeric run, so "Path of Aggression"
// matches the archetype slug "pathofaggression".
const slugKey = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

// The sheet's options section, derived from the classes a character holds:
// pack grants to their level, the base class's always and an archetype's
// when the sheet's subclass names it. Not stored — derived on read like the
// armor class, so a pack update re-prices every sheet at once. The picking
// itself (options.picks) is the level-up work.
export function packOptionGrantsForClasses(
  classes: Array<{ id: string; subclass?: string; level: number }>,
): SheetOptionGrant[] {
  const out: SheetOptionGrant[] = [];
  for (const entry of classes) {
    const slug = entry.id.trim().toLowerCase();
    const grants = packOptionGrantsFor(slug);
    if (!grants.length) {
      continue;
    }
    const wanted = entry.subclass ? slugKey(entry.subclass) : null;
    const seen = new Set<string>();
    for (const grant of grants) {
      if (grant.archetype && (!wanted || slugKey(grant.archetype) !== wanted)) {
        continue;
      }
      if (grant.level > Math.max(1, Math.min(20, entry.level))) {
        continue;
      }
      const key = `${grant.name}|${grant.level}|${grant.archetype ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const picks: Record<number, number> = {};
      for (const [level, count] of Object.entries(grant.choices ?? {})) {
        picks[Number(level)] = count;
      }
      if (!Object.keys(picks).length && grant.count) {
        picks[grant.level] = grant.count;
      }
      const family = PACK_OPTIONS.get(grant.refSlug)?.family ?? "unknown";
      out.push({
        classId: slug,
        name: grant.name,
        level: grant.level,
        family,
        ...(grant.archetype ? { archetype: grant.archetype } : {}),
        picks,
        count: Object.entries(picks)
          .filter(([level]) => Number(level) <= entry.level)
          .reduce((sum, [, count]) => sum + count, 0),
      });
    }
  }
  return out;
}

// The option names a class's grants declare, base class and archetypes
// together: the write-time allowlist's answer to "does the pack declare
// this name?" (src/lib/srd/legality/features.ts). A grant whose option rows
// have not landed yet answers with the option_name its data_json carries,
// so the allowance holds either way.
export function packOptionNamesFor(classSlug: string): string[] {
  return [...new Set(packOptionNamesRaw(classSlug))];
}

function packOptionNamesRaw(classSlug: string): string[] {
  const names: string[] = [];
  for (const grant of packOptionGrantsFor(classSlug)) {
    const name = PACK_OPTIONS.get(grant.refSlug)?.name ?? grant.optionName;
    if (name) {
      names.push(name);
    }
  }
  return names;
}
