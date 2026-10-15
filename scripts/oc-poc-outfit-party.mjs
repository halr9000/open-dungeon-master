// Outfit the Rogue One party from the SW5e pack (POC helper).
// Appends rows to each campaign sheet's equipment_json; the app derives
// weight/AC at read time (withItemWeights + armor engine), matching what
// grantItemMath would have written, plus slug links for pack resolution.
import Database from "better-sqlite3-multiple-ciphers";
import { serverEnv } from "../src/lib/server-env.ts";

const dbPath =
  process.env.SQLITE_DB_PATH || serverEnv("SQLITE_DB_PATH") ||
  "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite";
const db = new Database(dbPath);
db.pragma("cipher='chacha20'");
db.pragma(`key='${serverEnv("DB_ENCRYPTION_KEY").replaceAll("'", "''")}'`);

const OUTFITS = {
  "Jyn Erso": [
    { name: "Blaster pistol", slug: "blaster-pistol", equipped: true },
    { name: "Hold-out", slug: "hold-out" },
    { name: "Vibroknife", slug: "vibroknife" },
    { name: "Fiber armor - leather", slug: "fiber-armor", equipped: true },
    { name: "Commlink", slug: "communications-commlink" },
    { name: "Medpac", slug: "medpac", qty: 2 },
    { name: "Power cell", slug: "power-cell", qty: 4 },
    { name: "Datapad", slug: "data-recording-and-storage-datapad" },
  ],
  "Cassian Andor": [
    { name: "Blaster carbine", slug: "blaster-carbine", equipped: true },
    { name: "Blaster pistol", slug: "blaster-pistol" },
    { name: "Vibroknife", slug: "vibroknife" },
    { name: "Mesh armor - studded leather", slug: "mesh-armor", equipped: true },
    { name: "Commlink", slug: "communications-commlink" },
    { name: "Medpac", slug: "medpac", qty: 2 },
    { name: "Power cell", slug: "power-cell", qty: 4 },
    { name: "Bandolier", slug: "bandolier" },
  ],
  "Chirrut Imwe": [
    { name: "Echostaff", slug: "echostaff", equipped: true },
    { name: "Lightbow", slug: "lightbow" },
    { name: "Jedi Knight's Robe", slug: "jedi-knights-robe", equipped: true },
    { name: "Medpac", slug: "medpac", qty: 2 },
  ],
  "Baze Malbus": [
    { name: "Heavy repeater", slug: "heavy-repeater", equipped: true },
    { name: "Light repeater", slug: "light-repeater" },
    { name: "Battle armor - chain mail", slug: "battle-armor", equipped: true },
    { name: "Bandolier", slug: "bandolier" },
    { name: "Medpac", slug: "medpac", qty: 2 },
    { name: "Power cell", slug: "power-cell", qty: 6 },
  ],
  "K-2SO": [
    { name: "Blaster rifle", slug: "blaster-rifle", equipped: true },
    { name: "Plastoid composite - half plate", slug: "plastoid-composite", equipped: true },
    { name: "Vibroblade", slug: "vibroblade" },
    { name: "Power cell", slug: "power-cell", qty: 4 },
    { name: "Repair Kit Mk II", slug: "repair-kit-mk-ii" },
  ],
  "Bodhi Rove": [
    { name: "Blaster pistol", slug: "blaster-pistol", equipped: true },
    { name: "Fiber armor - leather", slug: "fiber-armor", equipped: true },
    { name: "Datapad", slug: "data-recording-and-storage-datapad" },
    { name: "Commlink", slug: "communications-commlink" },
    { name: "Repair Kit Mk II", slug: "repair-kit-mk-ii" },
    { name: "Medpac", slug: "medpac", qty: 2 },
    { name: "Power cell", slug: "power-cell", qty: 2 },
  ],
};

const rows = db.prepare(
  "SELECT id, name, equipment_json FROM character_sheets WHERE campaign_id = ?"
).all("f8290a31-39b7-4ee7-bc6f-ca923ab264ee");

const upd = db.prepare("UPDATE character_sheets SET equipment_json = ? WHERE id = ?");
for (const row of rows) {
  const outfit = OUTFITS[row.name];
  if (!outfit) continue;
  let existing = JSON.parse(row.equipment_json || "[]");
  // Drop superseded armor rows whose SRD-unresolvable names were renamed.
  const STALE = new Set(["fiber armor", "mesh armor", "battle armor", "plastoid composite"]);
  existing = existing.filter((i) => !STALE.has((i.name || "").toLowerCase()));
  const have = new Set(existing.map((i) => (i.name || "").toLowerCase()));
  const additions = outfit.filter((i) => !have.has(i.name.toLowerCase()));
  const merged = [...existing, ...additions];
  upd.run(JSON.stringify(merged), row.id);
  console.log(`${row.name}: kept ${existing.length}, added ${additions.length}, total ${merged.length}`);
}
db.close();
