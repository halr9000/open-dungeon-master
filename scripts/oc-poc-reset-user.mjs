// Reset ANY user's password on the SW5e POC instance (recovery helper).
// Format mirrors src/lib/auth.ts: hex(salt16) + "$" + hex(scrypt(pw, saltString, 64)).
import Database from "better-sqlite3-multiple-ciphers";
import { randomBytes, scryptSync } from "node:crypto";
import { serverEnv } from "../src/lib/server-env.ts";

const [username, newPassword] = process.argv.slice(2);
if (!username || !newPassword || newPassword.length < 8) {
  console.error("usage: node --experimental-strip-types scripts/oc-poc-reset-user.mjs <username> <newpassword>");
  process.exit(1);
}
const salt = randomBytes(16).toString("hex");
const hashHex = scryptSync(newPassword, salt, 64).toString("hex");
const dbPath =
  process.env.SQLITE_DB_PATH || serverEnv("SQLITE_DB_PATH") ||
  "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite";
const db = new Database(dbPath);
db.pragma("cipher='chacha20'");
db.pragma(`key='${serverEnv("DB_ENCRYPTION_KEY").replaceAll("'", "''")}'`);
const info = db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(
  `${salt}$${hashHex}`, username);
console.log("rows updated:", info.changes);
db.close();
