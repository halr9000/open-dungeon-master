import { openDatabase, type SqliteDatabase } from "@/lib/db/driver";
import { EDITION_2024_DOCUMENTS } from "@/lib/content/edition";
import { packFeatText } from "@/lib/srd/feat-text";
import { registerFeatRules } from "@/lib/srd/feature-effects";
import { registerPackClassFeatures, type PackClassFeature } from "@/lib/content/class-progression";
import {
  registerPackOptionGrants,
  registerPackOptions,
  type PackOptionGrant,
} from "@/lib/content/option-grants";
import { registerPackSkills } from "@/lib/content/skills";
import { existsSync } from "node:fs";
import path from "node:path";

// The Open5e content pack is a separate READ-ONLY SQLite built by
// scripts/import-open5e.mjs. Keeping it out of the app database means it
// never contends with the single-writer game DB and never ships to the
// client. A missing pack degrades gracefully: accessors return empty
// results and the UI falls back to the bundled SRD data.

declare global {
  var __odmContentDb: SqliteDatabase | null | undefined;
}

// Read at open time, not module load: pack-backed tests re-point
// CONTENT_DB_PATH between phases, and a constant captured here at module
// load would pin the first path forever.
const contentDbPath = () =>
  process.env.CONTENT_DB_PATH ||
  path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "content", "open5e.sqlite");

// Whether THIS module graph has registered the pack's registries. Kept in
// module scope deliberately — a server runtime may hold several module
// graphs over one process (a Next.js app does: pages, route handlers,
// instrumentation each bundle their own copy of the registry modules), the
// DB handle memoizes on globalThis and is shared by all of them, but the
// registry state lives in module scope — each graph must register its own
// copy, and a graph that arrives late must not skip that because the handle
// is already memoized. Every register call is an idempotent setter, so
// re-running them per graph is free.
let registrationsDone = false;

export function getContentDb(): SqliteDatabase | null {
  if (globalThis.__odmContentDb !== undefined) {
    if (!registrationsDone && globalThis.__odmContentDb) {
      const db = globalThis.__odmContentDb;
      registerPackFeats(db);
      registerPackClassProgression(db);
      registerPackOptionTables(db);
      loadPackSkills(db);
      registrationsDone = true;
    }
    return globalThis.__odmContentDb;
  }
  if (!existsSync(/*turbopackIgnore: true*/ contentDbPath())) {
    globalThis.__odmContentDb = null;
    return null;
  }
  const db = openDatabase(contentDbPath(), { readonly: true, fileMustExist: true });
  globalThis.__odmContentDb = db;
  registerPackFeats(db);
  registerPackClassProgression(db);
  registerPackOptionTables(db);
  loadPackSkills(db);
  registrationsDone = true;
  return db;
}

// The pack's 2014 feats reach the engines the way ODM's own do (issue
// #147, src/lib/srd/feature-effects.ts registerFeatRules): their speed,
// initiative and passive bonuses, their resistances, and their text as the
// guidance the prompt shows. The 2024 rows are left out (their numbers are
// not the engine's); ODM's own rows are already in.
function registerPackFeats(db: SqliteDatabase): void {
  try {
    const editions = [...EDITION_2024_DOCUMENTS, "odm-expanded"];
    const rows = db
      .prepare(`SELECT name, data_json FROM feats WHERE document_slug NOT IN (${editions.map(() => "?").join(", ")})`)
      .all(...editions) as Array<{ name: string; data_json: string }>;
    for (const row of rows) {
      try {
        registerFeatRules(row.name, packFeatText(JSON.parse(row.data_json) as Record<string, unknown>).desc);
      } catch {
        // A row that does not parse grants nothing here.
      }
    }
  } catch {
    // An older pack without a feats table serves no feats either.
  }
}

// A pack's classes' base features, read once into the registry the pure
// grant helpers read (src/lib/content/class-progression.ts): kind 'feature'
// rows at level by level, one per name+level, the proficiency bookkeeping
// rows off (their grants are what classMechanics derives saves and
// proficiencies from, not sheet features). The SW5e pack is the first
// writer; an older pack without the table serves no class features either.
const PROFICIENCY_ROWS = /^(Class|Multiclass) Proficiencies$/;

function registerPackClassProgression(db: SqliteDatabase): void {
  try {
    const rows = db
      .prepare(
        `SELECT class_slug, level, name FROM class_progression
         WHERE archetype_slug IS NULL AND kind = 'feature' AND name NOT LIKE 'Class Proficiencies'
         ORDER BY class_slug, level, rowid`,
      )
      .all() as Array<{ class_slug: string; level: number; name: string }>;
    const byClass = new Map<string, PackClassFeature[]>();
    const seen = new Set<string>();
    for (const row of rows) {
      if (PROFICIENCY_ROWS.test(row.name)) {
        continue;
      }
      const slug = row.class_slug.trim().toLowerCase();
      const key = `${slug}:${row.level}:${row.name.trim().toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const features = byClass.get(slug) ?? [];
      features.push({ level: row.level, name: row.name.trim() });
      byClass.set(slug, features);
    }
    for (const [slug, features] of byClass) {
      registerPackClassFeatures(slug, features);
    }
  } catch {
    // An older pack without a class_progression table serves none either.
  }
}

// A pack's option families and the grants that open them (the SW5e pack is
// the first writer): the options table's rows, and the class_progression
// kind 'option_grant' rows (base class and archetypes together) with the
// per-level pick counts their data_json carries. Older packs without the
// tables serve neither.
function registerPackOptionTables(db: SqliteDatabase): void {
  try {
    const options = db
      .prepare(`SELECT slug, name, family, prerequisite, action_economy, uses FROM options`)
      .all() as Array<{
      slug: string;
      name: string;
      family: string;
      prerequisite: string | null;
      action_economy: string | null;
      uses: string | null;
    }>;
    registerPackOptions(
      options.map((row) => ({
        slug: row.slug,
        name: row.name,
        family: row.family,
        prerequisite: row.prerequisite,
        actionEconomy: row.action_economy,
        uses: row.uses,
      })),
    );
  } catch {
    // An older pack without an options table serves no option grants either.
  }
  try {
    const rows = db
      .prepare(
        `SELECT class_slug, archetype_slug, level, name, ref_slug, count, data_json FROM class_progression
         WHERE kind = 'option_grant' ORDER BY class_slug, level, rowid`,
      )
      .all() as Array<{
      class_slug: string;
      archetype_slug: string | null;
      level: number;
      name: string;
      ref_slug: string;
      count: number | null;
      data_json: string | null;
    }>;
    const byClass = new Map<string, PackOptionGrant[]>();
    for (const row of rows) {
      const slug = row.class_slug.trim().toLowerCase();
      const grants = byClass.get(slug) ?? [];
      const choices: Record<number, number> = {};
      const replacement: Record<number, boolean> = {};
      let optionName: string | null = null;
      try {
        const data = row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : null;
        const raw = data?.choices as Record<string, { count?: unknown; replacement?: unknown }> | undefined;
        if (raw && typeof raw === "object") {
          for (const [level, step] of Object.entries(raw)) {
            const count = Number(step?.count ?? 0);
            if (Number.isFinite(Number.parseInt(level, 10)) && count > 0) {
              choices[Number.parseInt(level, 10)] = count;
            }
            if (typeof step?.replacement === "boolean") {
              replacement[Number.parseInt(level, 10)] = step.replacement;
            }
          }
        }
        optionName = typeof data?.option_name === "string" ? data.option_name : null;
      } catch {
        // A row that does not parse grants its shape, not its counts.
      }
      grants.push({
        level: row.level,
        name: row.name.trim(),
        refSlug: row.ref_slug ?? "",
        archetype: row.archetype_slug,
        count: row.count,
        choices,
        ...(Object.keys(replacement).length ? { replacement } : {}),
        optionName,
      });
      byClass.set(slug, grants);
    }
    for (const [slug, grants] of byClass) {
      registerPackOptionGrants(slug, grants);
    }
  } catch {
    // An older pack without a class_progression table serves none either.
  }
}

// The pack's skill set (the SW5e pack is the first writer): the active
// skill list whenever the pack declares one, replacing the bundled SRD 18
// with replacement semantics (src/lib/content/skills.ts). An older pack
// without the table registers nothing, and the bundled list stands.
function loadPackSkills(db: SqliteDatabase): void {
  try {
    const rows = db.prepare(`SELECT id, name, ability FROM skills`).all() as Array<{
      id: string;
      name: string;
      ability: string;
    }>;
    registerPackSkills(rows);
  } catch {
    // An older pack without a skills table replaces nothing.
  }
}

export function contentPackInstalled() {
  return getContentDb() !== null;
}
