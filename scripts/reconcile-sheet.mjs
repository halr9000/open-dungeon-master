// Stage 1 of the reconciliation policy (docs/reconciliation-policy.md) — the
// CLI. Deterministic, idempotent, no LLM: it rewrites only what the sheet's
// own recorded choices prove, flags the rest with evidence, and writes a JSON
// log that Stage 2 (the agent, in conversation — no in-app component) reads.
//
//   node scripts/reconcile-sheet.mjs --character <id> [--user <name>] [--apply]
//   node scripts/reconcile-sheet.mjs --file <sheet.json> [--out <fixed.json>] [--apply]
//
//   --character  a stored library character (read and written through the
//                app database; SQLITE_DB_PATH, defaulting to the service's)
//   --file       a sheet or character bundle JSON; with --apply, the fixed
//                sheet is written back to --out (default: alongside input)
//   --apply      write the fixed sheet. Without it the run is a dry run:
//                the log records what WOULD change, the sheet is untouched
//   --log <p>    where the JSON log goes (default: reconcile-log-<ts>.json
//                in the current directory)
//
// Exit codes: 0 every entry succeeded, 1 partial (warnings only), 2 any
// failure. Skills first (the proven pain point); saves, tools and languages
// follow the same shape once proven.
import { register } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
register("./lib/register-alias.mjs", import.meta.url);

const PACK_DB = process.env.CONTENT_DB_PATH || "/home/halr9000/projects/sw5e-odm-pack/sw5e.sqlite";
const APP_DB = process.env.SQLITE_DB_PATH || "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite";

function usage(code) {
  console.error(
    "usage: reconcile-sheet.mjs --character <id> [--user <name>] [--apply] [--log <p>]\n" +
      "       reconcile-sheet.mjs --file <sheet.json> [--out <p>] [--apply] [--log <p>]",
  );
  process.exit(code);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`);
if (has("help") || has("h")) {
  usage(0);
}
const characterId = flag("character");
const filePath = flag("file");
if (Boolean(characterId) === Boolean(filePath)) {
  usage(2);
}
const apply = has("apply");

// Mount the content pack BEFORE importing any consumer of activeSkills()
// (catalog's class/background/feat lookups included): the pack's skill table
// is registered data read off the open database. The app database path is
// likewise set before any import: src/lib/db/core.ts computes its path at
// module load, and catalog pulls that chain in.
process.env.CONTENT_DB_PATH = PACK_DB;
if (characterId && !process.env.SQLITE_DB_PATH) {
  process.env.SQLITE_DB_PATH = APP_DB;
}
const { getContentDb } = await import("@/lib/content/db");
getContentDb();

const { reconcileSheetSkills } = await import("./reconcile/core.mjs");
const { resolveSkillEntry } = await import("@/lib/content/skills");
const { classGrantsFor, backgroundGrantsFor, featFactsFor } = await import("@/lib/characters/catalog");
const { featGrantSpec } = await import("@/lib/srd/feat-grant-text");

// ---- load the sheet ---------------------------------------------------------
let sheet;
let meta;
if (characterId) {
  const { getDatabase } = await import("@/lib/db/core");
  const row = getDatabase()
    .prepare(`SELECT id, user_id, name, class, subclass, background, sheet_json FROM library_characters WHERE id = ?`)
    .get(characterId);
  if (!row) {
    console.error(`no library character ${characterId} in ${APP_DB}`);
    process.exit(2);
  }
  sheet = JSON.parse(row.sheet_json);
  meta = { source: "db", characterId: row.id, name: row.name, userId: row.user_id, db: APP_DB };
} else {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  // A character bundle wraps the sheet ({ sheet }); a bare sheet carries
  // proficiencies itself.
  sheet = parsed.sheet ?? parsed;
  if (!sheet.proficiencies) {
    console.error(`${filePath} carries no sheet (no proficiencies)`);
    process.exit(2);
  }
  meta = { source: "file", file: filePath, name: sheet.name ?? "" };
}

// ---- providers: what the sheet's own rows answer to ------------------------
const classGrants = classGrantsFor(sheet.class ?? "");
const background = backgroundGrantsFor(sheet.background ?? "");
const feats = (sheet.feats ?? []).map((name) => {
  const facts = featFactsFor(name, meta.userId ? [meta.userId] : undefined);
  const picks = sheet.featChoices?.[name] ?? sheet.featChoices?.[name.toLowerCase()] ?? undefined;
  return { name, desc: facts?.desc ?? "", picks, known: Boolean(facts) };
});

const result = reconcileSheetSkills(sheet, {
  resolveEntry: resolveSkillEntry,
  classOffers: classGrants?.skillChoices?.from ?? classGrants?.skills ?? [],
  backgroundSkills: background?.skills ?? [],
  racialSkills: sheet.racialChoices?.skills ?? [],
  feats: feats.map((feat) => ({
    name: feat.name,
    spec: feat.known ? featGrantSpec(feat.desc) : null,
    picks: feat.picks,
  })),
});

// ---- the log: Stage 2 sees this alone --------------------------------------
const log = {
  tool: "reconcile-sheet",
  version: 1,
  ranAt: new Date().toISOString(),
  applied: apply,
  input: meta,
  context: {
    class: sheet.class ?? "",
    subclass: sheet.subclass ?? "",
    background: sheet.background ?? "",
    feats: sheet.feats ?? [],
  },
  ops: result.ops,
  warnings: result.warnings,
  failures: result.failures,
  summary: result.summary,
};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const slug = (meta.name || "sheet").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const logPath = flag("log") ?? `reconcile-log-${slug}-${stamp}.json`;
writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);

if (apply) {
  if (characterId) {
    const { getDatabase } = await import("@/lib/db/core");
    getDatabase()
      .prepare(`UPDATE library_characters SET sheet_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(result.sheet), new Date().toISOString(), characterId);
    console.error(`wrote ${characterId} (${log.summary.result}); log: ${logPath}`);
  } else {
    const out = flag("out") ?? filePath.replace(/\.json$/i, ".reconciled.json");
    writeFileSync(out, `${JSON.stringify(result.sheet, null, 2)}\n`);
    console.error(`wrote ${out} (${log.summary.result}); log: ${logPath}`);
  }
} else {
  console.error(`dry run (${log.summary.result}); log: ${logPath} — rerun with --apply to write`);
}
console.log(JSON.stringify(log.summary));
process.exit(log.summary.result === "success" ? 0 : log.summary.result === "partial" ? 1 : 2);
