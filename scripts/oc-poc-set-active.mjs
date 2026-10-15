// Set each member's active_character_id for a campaign (POC helper).
// Usage: node --experimental-strip-types scripts/oc-poc-set-active.mjs '<campaignId>' '<json {username: characterId}>'
import Database from "better-sqlite3-multiple-ciphers";
import { serverEnv } from "../src/lib/server-env.ts";

const [campaignId, mappingJson] = process.argv.slice(2);
if (!campaignId || !mappingJson) {
  console.error("usage: ... <campaignId> '<json {username: characterId}>'");
  process.exit(1);
}
const mapping = JSON.parse(mappingJson);
const dbPath =
  process.env.SQLITE_DB_PATH || serverEnv("SQLITE_DB_PATH") ||
  "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite";
const db = new Database(dbPath);
db.pragma("cipher='chacha20'");
db.pragma(`key='${serverEnv("DB_ENCRYPTION_KEY").replaceAll("'", "''")}'`);
const stmt = db.prepare(
  "UPDATE campaign_members SET active_character_id = ? WHERE campaign_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)");
let updated = 0;
for (const [username, characterId] of Object.entries(mapping)) {
  updated += stmt.run(characterId, campaignId, username).changes;
}
console.log("members updated:", updated);
db.close();
