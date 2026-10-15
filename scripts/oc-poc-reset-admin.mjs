// Reset the sw5epoc admin password on the SW5e POC instance.
// Format mirrors src/lib/auth.ts: hex(16-byte salt) + "$" + hex(scrypt(pw, salt, 64)),
// Node default scrypt params — exactly what hashPassword produces.
import Database from "better-sqlite3-multiple-ciphers";
import { randomBytes, scryptSync } from "node:crypto";
import { serverEnv } from "../src/lib/server-env.ts";

const newPassword = process.argv[2];
if (!newPassword || newPassword.length < 8) {
  console.error("usage: node --experimental-strip-types scripts/oc-poc-reset-admin.mjs <newpassword>");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
// auth.ts calls scrypt(password, salt, KEYLEN) with salt as the HEX STRING —
// Node then uses its utf8 bytes, not decoded hex. Match that exactly.
const hashHex = scryptSync(newPassword, salt, 64).toString("hex");
const stored = salt + "$" + hashHex;

const dbPath =
  process.env.SQLITE_DB_PATH || serverEnv("SQLITE_DB_PATH") ||
  "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite";
const db = new Database(dbPath);
db.pragma("cipher='chacha20'");
db.pragma(`key='${serverEnv("DB_ENCRYPTION_KEY").replaceAll("'", "''")}'`);
const row = db.prepare("SELECT password_hash FROM users WHERE username = ?").get("sw5epoc");
if (!row) {
  console.error("user sw5epoc not found");
  process.exit(1);
}
const info = db
  .prepare("UPDATE users SET password_hash = ? WHERE username = ? AND is_admin = 1")
  .run(stored, "sw5epoc");
console.log("rows updated:", info.changes);
db.close();
